// Fails on any advisory, whatever its severity, that a published release within the installed major fixes; on any high
// or critical advisory with no such release that is not individually examined and written down here; and on any entry
// that stopped matching. A new release is installed the day it ships unless an advisory names it: there is no age wait.
// --omit=dev hides nothing useful because Expo and React Native declare their build tooling as ordinary dependencies.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Each entry is a claim someone checked. Empty is allowed, and a stale entry fails as loudly as an unacknowledged advisory.
const ACKNOWLEDGED = [];

// Dependencies installed outside the npm registry, which `npm audit` and Dependabot cannot see; `reviewed` is what was read and found not to apply.
const UNAUDITED = [
  {
    package: "xlsx",
    version: "0.20.3",
    advisories: "https://cdn.sheetjs.com/advisories/",
    reviewed: ["CVE-2023-30533", "CVE-2024-22363"],
    checkedOn: "2026-09-02",
    recheckAfter: "2026-12-02",
    reason:
      "SheetJS publishes from its own CDN, so neither `npm audit` nor Dependabot has a registry record to match and neither will ever report it. Both advisories the publisher lists are fixed below the pinned version: CVE-2023-30533 (prototype pollution) in 0.19.3 and CVE-2024-22363 (ReDoS) in 0.20.2, against 0.20.3 here. The tarball is pinned by URL and by sha512 in package-lock.json, so the bytes cannot change under the pin. Re-read the publisher's advisory page and re-check the pinned version before expiry.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether a plain `x.y.z` falls inside an advisory's range: `||`-joined sets of space-joined comparators, as npm audit prints them. */
export function inRange(version, range) {
  const v = parse(version);
  if (!v) return false;
  return range.split("||").some((set) =>
    set.trim().split(/\s+/).filter(Boolean).every((comparator) => {
      const match = /^(<=|>=|<|>|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
      if (!match) return comparator === "*";
      const order = compare(v, parse(match[2]));
      return { "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0, "=": order === 0, undefined: order === 0 }[match[1]];
    }),
  );
}

/**
 * Per advisory, any severity: the oldest release that leaves its range within an installed copy's major, so the
 * parents' caret ranges already admit it.
 * A copy with no such release is listed in `stuck`: its fix is a major the parent must move to, or none exists.
 *
 * @param {{ vulnerabilities?: Record<string, any> }} report
 * @param {(node: string) => string | undefined} installedAt version at a `node_modules/...` path
 * @param {(name: string) => Record<string, string>} releasesOf keyed by version, as `npm view <name> time`
 */
export function remedies(report, installedAt, releasesOf) {
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || via.name !== name || typeof via.range !== "string") continue;
      const id = via.url?.split("/").pop() ?? String(via.source);
      const remedy = found.get(id) ?? { id, package: name, severity: via.severity, title: via.title, fixes: [], stuck: [] };
      found.set(id, remedy);
      const releases = Object.entries(releasesOf(name)).filter(([version]) => parse(version));
      for (const node of entry.nodes ?? []) {
        const installed = installedAt(node);
        const current = installed && parse(installed);
        if (!current) continue;
        const fix = releases
          .filter(([version]) => parse(version)[0] === current[0] && compare(parse(version), current) > 0 && !inRange(version, via.range))
          .sort(([a], [b]) => compare(parse(a), parse(b)))[0];
        if (!fix) {
          remedy.stuck.push(`${installed} at ${node}`);
          continue;
        }
        remedy.fixes.push({ node, installed, version: fix[0] });
      }
    }
  }
  return found;
}

function audit() {
  let report;
  try {
    // npm exits non-zero on findings, the normal case; the stdout report is what matters.
    report = JSON.parse(execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    if (typeof error.stdout !== "string" || !error.stdout.trim().startsWith("{")) throw error;
    report = JSON.parse(error.stdout);
  }
  // An unreachable audit endpoint exits 0 with `{ message, error }`; read as a report that would be a green gate.
  if (report.error) throw new Error(`npm audit returned no report: ${report.message ?? JSON.stringify(report.error)}`);
  return report;
}

// Every distinct blocking advisory, with the packages it affects and the DIRECT dependencies it reaches them through.
export function blockingAdvisories(report) {
  const entries = report.vulnerabilities ?? {};
  const found = new Map();

  for (const [name, entry] of Object.entries(entries)) {
    for (const via of entry.via ?? []) {
      // A string `via` is a transitive edge, not an advisory of its own.
      if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
      const id = via.url?.split("/").pop() ?? String(via.source);
      if (!found.has(id)) found.set(id, { id, title: via.title, package: via.name, affected: new Set(), roots: new Set() });
      found.get(id).affected.add(name);
    }
  }

  // The visited set bounds the walk, so a cycle terminates.
  const reaches = (start, targets) => {
    const seen = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const name = stack.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      if (targets.has(name)) return true;
      for (const via of entries[name]?.via ?? []) {
        if (typeof via === "string") stack.push(via);
        else if (via?.name) stack.push(via.name);
      }
    }
    return false;
  };

  for (const [name, entry] of Object.entries(entries)) {
    if (!entry.isDirect) continue;
    for (const advisory of found.values()) {
      if (reaches(name, advisory.affected)) advisory.roots.add(name);
    }
  }
  return found;
}

/**
 * Failure modes as data: unacknowledged, unexamined path, tree moved, expired, stale.
 *
 * @param {{ vulnerabilities?: Record<string, any> }} report
 * @param {{ id: string, package: string, checkedOn: string, reason: string,
 *           expectedPaths?: string[], recheckAfter?: string }[]} [acknowledgements]
 * @param {string} [today] ISO date; injected so expiry is testable.
 */
export function evaluate(report, acknowledgements = ACKNOWLEDGED, today = new Date().toISOString().slice(0, 10), fixes = new Map()) {
  const advisories = blockingAdvisories(report);
  const acknowledged = new Map(acknowledgements.map((entry) => [entry.id, entry]));
  const problems = [];
  const accepted = [];

  for (const remedy of fixes.values()) {
    if (remedy.fixes.length === 0) continue;
    problems.push(
      `FIXABLE ${remedy.id} (${remedy.package}, ${remedy.severity}): ${remedy.title}\n` +
        remedy.fixes.map((fix) => `  ${fix.installed} at ${fix.node} -> ${fix.version}`).join("\n") +
        `\n  Move the lock to it (\`npm update ${remedy.package}\`, or the override in package.json), whatever the severity.`,
    );
  }

  for (const [id, advisory] of advisories) {
    if (fixes.get(id)?.fixes.length > 0) continue;
    const entry = acknowledged.get(id);
    if (entry) {
      const expected = entry.expectedPaths ?? [];
      // A root outside the examined tree is a consumer nobody looked at.
      const unexpected = [...advisory.roots].filter((root) => !expected.includes(root));
      if (unexpected.length > 0) {
        problems.push(
          `UNEXPECTED PATH ${id} (${entry.package}) now reaches through: ${unexpected.sort().join(", ")}\n` +
            `  Examined roots: ${expected.join(", ") || "(none)"}.\n` +
            `  Prove this consumer cannot reach runtime, or fix the advisory.`,
        );
      }
      const missing = expected.filter((root) => !advisory.roots.has(root));
      if (missing.length > 0) {
        problems.push(
          `TREE CHANGED ${id} (${entry.package}) no longer reaches through: ${missing.sort().join(", ")}\n` +
            `  The dependency tree moved under the acceptance. Re-examine and update expectedPaths.`,
        );
      }
      if (entry.recheckAfter && today >= entry.recheckAfter) {
        problems.push(
          `EXPIRED ${id} (${entry.package}) was due for re-examination on ${entry.recheckAfter}.\n` +
            `  Check upstream for a compatible fix and re-prove it cannot reach runtime,\n` +
            `  then move checkedOn and recheckAfter forward.`,
        );
      }
      accepted.push(entry);
      continue;
    }
    problems.push(
      `UNACKNOWLEDGED ${id} (${advisory.package}): ${advisory.title}\n` +
        `  reaches: ${[...advisory.affected].sort().join(", ")}\n` +
        `  Fix it, or add it to ACKNOWLEDGED in this file with evidence.`,
    );
  }

  for (const entry of acknowledgements) {
    if (!advisories.has(entry.id)) {
      problems.push(
        `STALE ${entry.id} (${entry.package}) is acknowledged but no longer reported.\n` +
          `  It was fixed upstream or dropped. Delete the entry.`,
      );
    }
  }

  return { advisories, accepted, problems };
}

/**
 * Read from the lockfile, not a hand-written list, so a blind spot that GREW is noticed.
 *
 * @param {{ packages?: Record<string, { resolved?: string, version?: string }> }} lock
 */
export function unregisteredPackages(lock) {
  const found = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = entry?.resolved;
    if (!path.startsWith("node_modules/") || typeof resolved !== "string") continue;
    let host;
    try {
      host = new URL(resolved).host;
    } catch {
      continue;
    }
    if (host === "registry.npmjs.org") continue;
    found.set(path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length), {
      host,
      version: entry.version,
      resolved,
    });
  }
  return found;
}

/**
 * Failure modes as data: untracked, version moved, expired, stale.
 *
 * @param {Map<string, { host: string, version?: string }>} unregistered
 * @param {{ package: string, version: string, recheckAfter?: string }[]} [entries]
 * @param {string} [today]
 */
export function evaluateUnaudited(unregistered, entries = UNAUDITED, today = new Date().toISOString().slice(0, 10)) {
  const problems = [];
  const tracked = new Map(entries.map((entry) => [entry.package, entry]));

  for (const [name, installed] of unregistered) {
    const entry = tracked.get(name);
    if (!entry) {
      problems.push(
        `UNTRACKED ${name}@${installed.version} installs from ${installed.host}, not the npm registry.\n` +
          `  Neither \`npm audit\` nor Dependabot can see it, so nothing is watching it.\n` +
          `  Add it to UNAUDITED in this file with its advisory source and a review date.`,
      );
      continue;
    }
    if (installed.version !== entry.version) {
      problems.push(
        `VERSION MOVED ${name} is installed at ${installed.version}; the review covers ${entry.version}.\n` +
          `  Read the publisher's advisories for the installed version, then update the entry.`,
      );
    }
    if (entry.recheckAfter && today >= entry.recheckAfter) {
      problems.push(
        `EXPIRED ${name} was due for re-examination on ${entry.recheckAfter}.\n` +
          `  Re-read the publisher's advisory page, confirm the pinned version, then move the dates forward.`,
      );
    }
  }

  for (const entry of entries) {
    if (!unregistered.has(entry.package)) {
      problems.push(
        `STALE ${entry.package} is tracked here but no longer installs from outside the registry.\n` +
          `  The ordinary audit covers it now. Delete the entry.`,
      );
    }
  }

  return problems;
}

/**
 * A plain scan for CVE identifiers, not a parse of someone else's HTML; the caller treats an empty scan as a failure.
 *
 * @param {string} pageText
 * @param {readonly string[]} reviewed
 */
export function newAdvisories(pageText, reviewed) {
  const seen = [...new Set(pageText.match(/CVE-\d{4}-\d{4,7}/g) ?? [])];
  return { seen, unreviewed: seen.filter((id) => !reviewed.includes(id)) };
}

// Fails closed: an unreachable page, a page with no identifiers (its shape changed) and an unreviewed identifier all fail.
async function reviewPublisherAdvisories(entry) {
  let text;
  try {
    const response = await fetch(entry.advisories, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    return [
      `UNREACHABLE ${entry.package}: could not read ${entry.advisories} (${error}).\n` +
        `  Nothing is watching this dependency, so this cannot be treated as clean.`,
    ];
  }
  const { seen, unreviewed } = newAdvisories(text, entry.reviewed);
  if (seen.length === 0) {
    return [
      `UNREADABLE ${entry.package}: ${entry.advisories} listed no advisory identifiers.\n` +
        `  The page's shape changed, and an empty scan reads exactly like a clean one.\n` +
        `  Read it by hand and adjust the scan.`,
    ];
  }
  if (unreviewed.length > 0) {
    return [
      `NEW ADVISORY ${entry.package}: ${unreviewed.join(", ")} appeared on ${entry.advisories}.\n` +
        `  Read it, check whether ${entry.version} is affected, upgrade if it is,\n` +
        `  then add the identifier to \`reviewed\` with the dates moved forward.`,
    ];
  }
  return [];
}

// Importing this file must not shell out.
if (import.meta.main) {
  const report = audit();
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const releasesOf = (name) => JSON.parse(execFileSync("npm", ["view", name, "time", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const fixes = remedies(report, (node) => lock.packages?.[node]?.version, releasesOf);
  const { advisories, accepted, problems } = evaluate(report, ACKNOWLEDGED, undefined, fixes);

  const unregistered = unregisteredPackages(lock);
  // A development dependency installs too: Fiala's xlsx runs only in CI's catalogue import.
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
  const unaudited = UNAUDITED.filter((e) => e.package in dependencies || e.package in devDependencies);
  problems.push(...evaluateUnaudited(unregistered, unaudited));
  for (const entry of unaudited) {
    if (!unregistered.has(entry.package)) continue;
    console.log(`tracked ${entry.package}@${entry.version} from ${new URL(entry.advisories).host}, last read ${entry.checkedOn}`);
    problems.push(...(await reviewPublisherAdvisories(entry)));
  }

  for (const entry of accepted) {
    console.log(`accepted ${entry.id} (${entry.package}), last checked ${entry.checkedOn}`);
    console.log(`      ${entry.reason}`);
  }
  for (const remedy of fixes.values()) {
    if (remedy.stuck.length > 0 && remedy.fixes.length === 0) {
      console.log(`carried ${remedy.id} (${remedy.package}, ${remedy.severity}): no release in the installed major fixes ${remedy.stuck.join(", ")}`);
    }
  }

  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(
    `\n${advisories.size} distinct high/critical advisories across ` +
      `${(counts.high ?? 0) + (counts.critical ?? 0)} affected packages; ` +
      `${ACKNOWLEDGED.length} acknowledged.`,
  );

  if (problems.length > 0) {
    console.error(`\n${problems.join("\n\n")}\n`);
    process.exit(1);
  }
  console.log("No fixable advisory, and no unacknowledged high or critical one.");
}
