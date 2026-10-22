import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  blockingAdvisories,
  evaluate,
  evaluateUnaudited,
  newAdvisories,
  unregisteredPackages,
} from "../../scripts/check-advisories.mjs";

const advisory = (id: string, severity: string, name = "pkg") => ({
  source: 1,
  name,
  title: `${name} is broken`,
  url: `https://github.com/advisories/${id}`,
  severity,
});

const report = (vulnerabilities: Record<string, unknown>) => ({ vulnerabilities });
const ack = (id: string, extra: Record<string, unknown> = {}) => [
  { id, package: "pkg", checkedOn: "2026-07-28", reason: "proven unreachable", ...extra },
];
/** A direct dependency that depends on the vulnerable package. */
const root = (dep: string) => ({ isDirect: true, via: [dep] });
const TODAY = "2026-07-29";

describe("advisory gate", () => {
  it("collects one entry per advisory, not per affected package", () => {
    // 25 packages were flagged by a single brace-expansion advisory. Counting
    // packages instead of advisories made the report unreadable and hid how
    // few decisions were actually being made.
    const found = blockingAdvisories(
      report({
        a: { via: [advisory("GHSA-x", "high")] },
        b: { via: ["a", advisory("GHSA-x", "high")] },
        c: { via: [advisory("GHSA-y", "critical")] },
      }),
    );
    expect([...found.keys()].sort()).toEqual(["GHSA-x", "GHSA-y"]);
    expect([...found.get("GHSA-x")!.affected].sort()).toEqual(["a", "b"]);
  });

  it("ignores transitive edges and anything below high", () => {
    const found = blockingAdvisories(
      report({
        a: { via: ["depends-on-b"] },
        b: { via: [advisory("GHSA-moderate", "moderate")] },
        c: { via: [advisory("GHSA-low", "low")] },
      }),
    );
    expect([...found.keys()]).toEqual([]);
  });

  it("fails on an advisory nobody has examined", () => {
    const { problems } = evaluate(report({ a: { via: [advisory("GHSA-new", "high")] } }), []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("UNACKNOWLEDGED GHSA-new");
  });

  it("still fails when a new advisory appears beside an accepted one", () => {
    const { problems } = evaluate(
      report({ a: { via: [advisory("GHSA-known", "high")] }, b: { via: [advisory("GHSA-new", "critical")] } }),
      ack("GHSA-known"),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GHSA-new");
  });

  it("fails on an acknowledgement that outlived its advisory", () => {
    // Otherwise the list silently becomes a permanent exemption for something
    // that was fixed upstream years ago.
    const { problems } = evaluate(report({}), ack("GHSA-fixed"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("STALE GHSA-fixed");
  });

  it("passes only when every blocking advisory is accounted for", () => {
    const { problems, accepted } = evaluate(
      report({ a: { via: [advisory("GHSA-known", "high")] } }),
      ack("GHSA-known"),
    );
    expect(problems).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it("keeps the real acknowledgement list minimal and evidenced", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/check-advisories.mjs"), "utf8");
    const ids = [...source.matchAll(/id: "(GHSA-[^"]+)"/g)].map((match) => match[1]);
    const packages = new Set([...source.matchAll(/id: "GHSA-[^"]+",\s*\n\s*package: "([^"]+)"/g)].map((m) => m[1]));

    // Counted per PACKAGE, not per advisory. The pressure this applies is
    // meant to be against accumulating judgements, and an upstream that
    // publishes four advisories for one parser in one week adds four ids and
    // no judgement at all. Three is the same ceiling it always was; it now
    // measures the thing it was written to measure.
    expect(packages.size, "every exemption is a decision; keep the list short").toBeLessThanOrEqual(3);

    for (const id of ids) {
      expect(source).toMatch(new RegExp(`${id}[\\s\\S]{0,400}checkedOn: "\\d{4}-\\d{2}-\\d{2}"`));
      // Nothing is accepted for ever. Without this, "keep the list short" is
      // satisfied by three entries that never expire.
      expect(source, `${id} must carry a recheckAfter`)
        .toMatch(new RegExp(`${id}[\\s\\S]{0,400}recheckAfter: "\\d{4}-\\d{2}-\\d{2}"`));
      expect(source, `${id} must name its expected dependency paths`)
        .toMatch(new RegExp(`${id}[\\s\\S]{0,400}expectedPaths:`));
    }
    // The threshold itself must never be quietly relaxed.
    expect(source).toContain('new Set(["high", "critical"])');
  });
});

describe("advisory gate: dependency paths and expiry", () => {
  const tree = (roots: string[]) => {
    const v: Record<string, unknown> = { pkg: { via: [advisory("GHSA-x", "high")] } };
    for (const r of roots) v[r] = root("pkg");
    return report(v);
  };

  it("reports the direct dependencies an advisory reaches through", () => {
    const found = blockingAdvisories(tree(["eslint", "expo"]));
    expect([...found.get("GHSA-x")!.roots].sort()).toEqual(["eslint", "expo"]);
  });

  it("follows a chain of transitive edges up to the direct dependency", () => {
    // The real tree is eslint -> minimatch -> brace-expansion, and only the
    // last one carries the advisory object.
    const found = blockingAdvisories(
      report({
        "brace-expansion": { via: [advisory("GHSA-x", "high")] },
        minimatch: { via: ["brace-expansion"] },
        eslint: { isDirect: true, via: ["minimatch"] },
      }),
    );
    expect([...found.get("GHSA-x")!.roots]).toEqual(["eslint"]);
  });

  it("terminates on a cyclic dependency graph", () => {
    const found = blockingAdvisories(
      report({
        pkg: { via: [advisory("GHSA-x", "high")] },
        a: { via: ["b"] },
        b: { via: ["a", "pkg"] },
        eslint: { isDirect: true, via: ["a"] },
      }),
    );
    expect([...found.get("GHSA-x")!.roots]).toEqual(["eslint"]);
  });

  it("fails when the advisory appears through an unexamined consumer", () => {
    const { problems } = evaluate(tree(["eslint", "some-new-runtime-dep"]), ack("GHSA-x", { expectedPaths: ["eslint"] }), TODAY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("UNEXPECTED PATH");
    expect(problems[0]).toContain("some-new-runtime-dep");
  });

  it("fails when an examined consumer disappears from the tree", () => {
    const { problems } = evaluate(tree(["eslint"]), ack("GHSA-x", { expectedPaths: ["eslint", "expo"] }), TODAY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("TREE CHANGED");
    expect(problems[0]).toContain("expo");
  });

  it("passes while the tree matches exactly and the acceptance is current", () => {
    const { problems } = evaluate(
      tree(["eslint", "expo"]),
      ack("GHSA-x", { expectedPaths: ["eslint", "expo"], recheckAfter: "2026-12-31" }),
      TODAY,
    );
    expect(problems).toEqual([]);
  });

  it("fails once the re-examination date has passed", () => {
    const { problems } = evaluate(
      tree(["eslint"]),
      ack("GHSA-x", { expectedPaths: ["eslint"], recheckAfter: "2026-07-29" }),
      TODAY,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("EXPIRED");
  });

  it("keeps failing on the day after expiry, not just on the day itself", () => {
    const { problems } = evaluate(
      tree(["eslint"]),
      ack("GHSA-x", { expectedPaths: ["eslint"], recheckAfter: "2026-01-01" }),
      TODAY,
    );
    expect(problems[0]).toContain("EXPIRED");
  });

});

/**
 * The dependency the registry audit cannot see.
 *
 * `npm audit` and Dependabot both resolve against the npm registry, so a
 * package installed from a tarball URL is not reported clean — it is not
 * reported at all. `xlsx` is in none of the audit's advisories, which is the
 * same answer it would give for a version with a known critical hole.
 *
 * The list that stands in for the audit is only worth anything if it cannot
 * fall behind the lockfile, so the lockfile is what defines the set.
 */
describe("unaudited dependencies", () => {
  const lock = (packages: Record<string, { resolved?: string; version?: string }>) => ({ packages });
  const REGISTRY = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
  const CDN = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
  const tracked = [{ package: "xlsx", version: "0.20.3", recheckAfter: "2027-01-01" }];

  it("finds the packages that do not come from the registry", () => {
    const found = unregisteredPackages(lock({
      "": { version: "1.0.0" },
      "node_modules/left-pad": { resolved: REGISTRY, version: "1.3.0" },
      "node_modules/xlsx": { resolved: CDN, version: "0.20.3" },
      // A workspace or link entry has no `resolved` and is not a download.
      "node_modules/local": { version: "0.0.0" },
    }));
    expect([...found.keys()]).toEqual(["xlsx"]);
    expect(found.get("xlsx")).toMatchObject({ host: "cdn.sheetjs.com", version: "0.20.3" });
  });

  it("reads a nested install under the name it is installed as", () => {
    const found = unregisteredPackages(lock({
      "node_modules/a/node_modules/xlsx": { resolved: CDN, version: "0.20.3" },
    }));
    expect([...found.keys()]).toEqual(["xlsx"]);
  });

  it("passes when every unregistered package is written down at its installed version", () => {
    const found = unregisteredPackages(lock({ "node_modules/xlsx": { resolved: CDN, version: "0.20.3" } }));
    expect(evaluateUnaudited(found, tracked, "2026-09-02")).toEqual([]);
  });

  it("fails on a blind spot nobody has written down", () => {
    const found = unregisteredPackages(lock({
      "node_modules/xlsx": { resolved: CDN, version: "0.20.3" },
      "node_modules/other": { resolved: "https://example.com/other-1.0.0.tgz", version: "1.0.0" },
    }));
    const problems = evaluateUnaudited(found, tracked, "2026-09-02");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("UNTRACKED other@1.0.0");
    expect(problems[0]).toContain("example.com");
  });

  it("fails when the installed version is not the one that was reviewed", () => {
    const found = unregisteredPackages(lock({ "node_modules/xlsx": { resolved: CDN, version: "0.21.0" } }));
    expect(evaluateUnaudited(found, tracked, "2026-09-02")[0]).toContain("VERSION MOVED");
  });

  it("fails once the review is due, so nothing is accepted for ever", () => {
    const found = unregisteredPackages(lock({ "node_modules/xlsx": { resolved: CDN, version: "0.20.3" } }));
    expect(evaluateUnaudited(found, tracked, "2027-01-01")[0]).toContain("EXPIRED");
  });

  it("fails on an entry for a package that has rejoined the registry", () => {
    const found = unregisteredPackages(lock({ "node_modules/xlsx": { resolved: REGISTRY, version: "0.20.3" } }));
    expect(evaluateUnaudited(found, tracked, "2026-09-02")[0]).toContain("STALE xlsx");
  });

  it("reports only the advisories on a publisher's page that nobody has read", () => {
    const page = "Advisories: CVE-2023-30533 and CVE-2024-22363 and CVE-2027-11111";
    const { seen, unreviewed } = newAdvisories(page, ["CVE-2023-30533", "CVE-2024-22363"]);
    expect(seen).toHaveLength(3);
    expect(unreviewed).toEqual(["CVE-2027-11111"]);
  });

  it("reports an unreadable page as finding nothing, not as finding nothing wrong", () => {
    // The caller treats an empty scan as a failure. This is the distinction it
    // depends on: a page whose shape changed reads exactly like a clean one.
    expect(newAdvisories("<html>no identifiers here</html>", ["CVE-2023-30533"]).seen).toEqual([]);
  });
});
