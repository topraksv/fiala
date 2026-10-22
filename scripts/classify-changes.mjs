/**
 * Decide what a main-branch push has to prove and which surfaces it can ship.
 *
 * The safe error is a slow run: every unrecognised path receives the full
 * gate, while a missing base receives the full gate and both deploy targets.
 * An empty diff means production already holds this tree.
 *
 * Usage: node scripts/classify-changes.mjs <base-ref> <head-ref>
 *        node scripts/classify-changes.mjs --files a.ts b.ts
 * Writes `key=value` lines to stdout and, when set, to $GITHUB_OUTPUT.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * The scripts THIS repository's `ci.yml` executes, matched by equality: an
 * escaped path in a regex is right until the first name with a `+` in it.
 *
 * What decides risk is not the directory but whether the gate that certifies
 * this push can run the file, so a local tool or another workflow's script
 * stays light. A test walks `ci.yml`, the `npm run` targets it names, the
 * configs those load and the `postinstall` every `npm ci` runs, and fails when
 * this list and that walk disagree.
 */
export const CI_EXECUTED_SCRIPTS = [
  "scripts/check-lint-ratchet.mjs",
  "scripts/check-mutation-ratchet.mjs",
  "scripts/check-published.mjs",
  "scripts/check-web-budget.mjs",
  "scripts/classify-changes.mjs",
  "scripts/export-e2e-web.mjs",
  // `npm ci` runs it as `postinstall`: it rewrites what every job builds.
  "scripts/patch-dependencies.mjs",
  // Started by `playwright.config.ts`, not by a `run:`.
  "scripts/serve-web-export.mjs",
  // Loaded by `stryker.config.mjs` as the mutation gate's runner.
  "scripts/stryker-vitest-files.mjs",
];

/** Money, persistence, identity, sync, native, and what builds or checks the app. */
const HIGH_RISK = [
  /^src\/domain\//,
  /^src\/data\//,
  /^src\/db\//,
  /^src\/sync\//,
  /^src\/auth\//,
  /^src\/services\//,
  // The tests behind the coverage floors and the mutation baseline: a push that
  // weakens one is the push whose gate must measure it.
  /^tests\/(?:domain|data|db|sync|auth|services)\//,
  /^tests\/helpers\.ts$/,
  /^supabase\//,
  /^package(-lock)?\.json$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^app\.json$/,
  /^eas\.json$/,
  /^plugins\//,
  /^drizzle\.config\.ts$/,
  /^(babel|metro|eslint)\.config\.js$/,
  /^tsconfig\.json$/,
  /^vitest(?:\.mutation)?\.config\.mts$/,
  /^stryker(?:\.[^.]+)?\.config\.mjs$/,
  /^(lint|mutation)-baseline\.json$/,
  /^playwright\.config\.ts$/,
  /^knip\.json$/,
  /^src\/app\/(?:.*\/)?_layout\.tsx$/,
  /^src\/app\/\+html\.tsx$/,
  /^\.github\/workflows\/ci\.yml$/,
];

/**
 * Repository material that cannot alter either delivered application. `docs/`
 * and the agent files are untracked, but a stray `git add` of one must not be
 * able to trigger a web deploy and an OTA update.
 */
const NO_APP_IMPACT = [
  /^README\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.env\.example$/,
  /^\.mcp\.json$/,
  // Release notes: `release.yml` reads them on a tag, and neither app does.
  /^CHANGELOG\.md$/,
  // Local audit configs: no workflow reads them.
  /^\.(?:jscpd\.json|madgerc)$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^\.claude\//,
  /^\.vscode\//,
  /^docs\//,
  /^assets\/screenshots\//,
  /^assets\/brand\/horizontal-(?:light|dark)\.png$/,
];

/**
 * Checked here but never published as Pages or Expo Go application bytes.
 * `patch-dependencies.mjs` is the exception under `scripts/`: it edits
 * `node_modules` on every install, so it ships like the lockfile does.
 */
const NOT_SHIPPED = [
  /^e2e\//,
  /^tests\//,
  /^\.github\//,
  /^scripts\/(?!patch-dependencies\.mjs$)/,
  /^supabase\//,
  /^plugins\//,
  /^(lint|mutation)-baseline\.json$/,
];

/**
 * Controls whose own correctness decides whether either delivery can finish:
 * a change to one republishes both surfaces after the full gate, so a broken
 * deploy or verification step is found by the push that broke it.
 */
const DELIVERY_CONTROL = [
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/classify-changes\.mjs$/,
  /^scripts\/check-published\.mjs$/,
];

/** Explicit light-tier allowlist; everything else escalates. */
const KNOWN_LIGHT = [
  // Whatever HIGH_RISK above did not name. HIGH_RISK is tested first.
  /^scripts\//,
  /^\.github\//,
  /^src\/i18n\//,
  /^src\/app\/.*\.tsx$/,
  /^src\/ui\//,
  /^e2e\//,
  /^tests\//,
  /^public\//,
  /^assets\//,
];

/** Inputs capable of changing Expo Go JavaScript or shipped assets. */
const AFFECTS_MOBILE_UPDATE = [
  /^src\//,
  /^assets\//,
  /^app\.json$/,
  /^package(-lock)?\.json$/,
  /^(babel|metro)\.config\.js$/,
  /^tsconfig\.json$/,
  /^\.npmrc$/,
  /^scripts\/patch-dependencies\.mjs$/,
];

/** The same, plus what only the web export or its budget check reads. */
const AFFECTS_WEB_BUILD = [...AFFECTS_MOBILE_UPDATE, /^public\//, /^scripts\/check-web-budget\.mjs$/];

/**
 * What the browser suite needs besides the app itself: a change here runs the
 * suite on any tier, so a changed test is run by the push that changed it.
 */
const E2E_INPUTS = [
  // Not `e2e/native*`: those are Maestro flows, run on a simulator by hand.
  /^e2e\/(?!native)/,
  // The Node every export runs on: a release that breaks Metro shows nowhere
  // else in a push that changes only this.
  /^\.nvmrc$/,
  /^playwright\.config\.ts$/,
  /^scripts\/(export-e2e-web|serve-web-export)\.mjs$/,
];

const matches = (path, patterns) => patterns.some((pattern) => pattern.test(path));

/** `files` is null when no diff could be taken, and empty when one was. */
export function classify(files) {
  if (files === null) {
    return {
      full_gate: true,
      run_web_build: true,
      run_e2e: true,
      deploy_web: true,
      deploy_mobile: true,
      reason: "no diff available; fail-open full gate and dual deploy",
    };
  }

  const relevant = files.filter((file) => !matches(file, NO_APP_IMPACT));
  if (relevant.length === 0) {
    return {
      full_gate: false,
      run_web_build: false,
      run_e2e: false,
      deploy_web: false,
      deploy_mobile: false,
      reason: "no application impact; light gate retained",
    };
  }

  const escalates = (file) => matches(file, HIGH_RISK) || CI_EXECUTED_SCRIPTS.includes(file);
  const unknown = (file) => !escalates(file) && !matches(file, KNOWN_LIGHT);
  const highRisk = relevant.filter((file) => escalates(file) || unknown(file));
  const deliveryControl = relevant.filter((file) => matches(file, DELIVERY_CONTROL));
  const shipping = relevant.filter((file) => !matches(file, NOT_SHIPPED));
  const buildsWeb = (file) => matches(file, AFFECTS_WEB_BUILD) || unknown(file);
  const run_web_build = deliveryControl.length > 0 || relevant.some(buildsWeb);

  return {
    full_gate: highRisk.length > 0,
    run_web_build,
    run_e2e: run_web_build || relevant.some((file) => matches(file, E2E_INPUTS)),
    deploy_web: deliveryControl.length > 0 || shipping.some(buildsWeb),
    deploy_mobile: deliveryControl.length > 0 || shipping.some(
      (file) => matches(file, AFFECTS_MOBILE_UPDATE) || unknown(file),
    ),
    reason: deliveryControl.length > 0
      ? `delivery control changed: ${deliveryControl.slice(0, 5).join(", ")}; full gate and dual republish`
      : highRisk.length > 0
      ? `high risk: ${highRisk.slice(0, 5).join(", ")}`
      : "ordinary change; light gate",
  };
}

const hasBase = (base) => Boolean(base) && !/^0+$/.test(base);

function changedFiles(base, head) {
  // Rename detection can return only the destination. If a shipped path moves
  // into a no-impact area, classify both the deletion and addition instead.
  return execFileSync("git", ["diff", "--no-renames", "--name-only", `${base}..${head}`], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const [first, ...rest] = process.argv.slice(2);
  let files;
  if (first === "--files") {
    files = rest;
  } else if (!hasBase(first)) {
    files = null;
  } else {
    try {
      files = changedFiles(first, rest[0] ?? "HEAD");
    } catch {
      files = null;
    }
  }

  const lines = Object.entries(classify(files)).map(([key, value]) => `${key}=${value}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (import.meta.main) main();
