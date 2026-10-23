// Fails when a lint rule fires more often than lint-baseline.json records; errors fail outright.
// Per rule, not per file: a file-level baseline would be rewritten whenever a file moved. `--record` adopts the counts by hand.
// Shells out to `expo lint --no-cache`: a warm cache reports nothing for unchanged files, so the ratchet would fall to whatever was cached.
// SDK 58 moved that cache to `.expo/cache/eslint/`, so deleting `.eslintcache` left it warm and four errors passed locally.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE = "lint-baseline.json";

/** ESLint's JSON, out of a command that also prints its own env preamble. */
export function parseLintReport(output) {
  const start = output.indexOf("[{");
  const end = output.lastIndexOf("}]");
  if (start < 0 || end < 0) throw new Error("no ESLint JSON report in the lint output");
  return JSON.parse(output.slice(start, end + 2));
}

export function countsFrom(report) {
  const rules = {};
  let errors = 0;
  for (const file of report) {
    errors += file.errorCount ?? 0;
    for (const message of file.messages ?? []) {
      if (message.severity !== 1) continue;
      const rule = message.ruleId ?? "(no rule)";
      rules[rule] = (rules[rule] ?? 0) + 1;
    }
  }
  return { rules, errors };
}

/**
 * @param {Record<string, number>} measured
 * @param {{ rules: Record<string, number> }} baseline
 */
export function evaluate(measured, baseline) {
  const recorded = baseline.rules ?? {};
  const problems = [];
  const improvements = [];
  for (const [rule, count] of Object.entries(measured)) {
    const previous = recorded[rule];
    if (previous === undefined) {
      problems.push(`NEW RULE ${rule} fired ${count} time(s) and has no recorded baseline.`);
    } else if (count > previous) {
      problems.push(`WORSE ${rule}: ${previous} -> ${count}.`);
    } else if (count < previous) {
      improvements.push(`${rule}: ${previous} -> ${count}`);
    }
  }
  for (const [rule, previous] of Object.entries(recorded)) {
    if (measured[rule] === undefined) improvements.push(`${rule}: ${previous} -> 0`);
  }
  return { problems, improvements };
}

/** Read whole, with no existence check first (TOCTOU); `null` when there is none. */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function runLint() {
  // `expo lint` exits non-zero on a real error; the report is still read.
  try {
    return execFileSync("npx", ["expo", "lint", "--no-cache", "--", "--format", "json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.includes("[{")) return error.stdout;
    throw error;
  }
}

if (import.meta.main) {
  const report = parseLintReport(runLint());
  const { rules, errors } = countsFrom(report);
  const total = Object.values(rules).reduce((sum, count) => sum + count, 0);
  const record = process.argv.includes("--record");
  const stored = readBaseline();
  const baselineExists = stored !== null;
  const baseline = stored ?? { rules: {} };
  const { problems, improvements } = evaluate(rules, baseline);

  // Printed before any decision: every run is cold, so a run that prints nothing costs a second cold lint.
  for (const rule of Object.keys({ ...baseline.rules, ...rules }).sort()) {
    const now = rules[rule] ?? 0;
    const was = baseline.rules?.[rule];
    const mark = was === undefined ? "  new" : now > was ? " WORSE" : now < was ? " better" : "     ok";
    console.log(`${mark}  ${String(now).padStart(4)}  (was ${was ?? "unrecorded"})  ${rule}`);
  }
  console.log(`\n${total} warning(s), ${errors} error(s).`);

  // A parse error hides that file's warnings; recording it would set a floor nobody measured.
  if (errors > 0) {
    const failing = report.filter((file) => (file.errorCount ?? 0) > 0).map((file) => file.filePath);
    console.error(
      `\nLint reported ${errors} error(s), which are not ratcheted: they fail outright.\n  ${failing.join("\n  ")}\n` +
        (record ? "\nFix them and record again: a partial run must not become the baseline." : ""),
    );
    process.exit(1);
  }
  if (record) {
    writeFileSync(BASELINE, `${JSON.stringify({ total, rules }, null, 2)}\n`);
    console.log(`Recorded ${total} warning(s) across ${Object.keys(rules).length} rule(s) in ${BASELINE}.`);
    process.exit(0);
  }
  if (!baselineExists) {
    console.error(`No ${BASELINE}. Read the current findings, then run \`npm run lint:record\`.`);
    process.exit(1);
  }
  if (improvements.length > 0) {
    console.log(
      `\n${improvements.length} rule(s) fired less than the baseline:\n  ${improvements.join("\n  ")}\n` +
        `  Lock them in with \`npm run lint:record\` once the fix is committed.`,
    );
  }
  if (problems.length > 0) {
    console.error(`\n${problems.join("\n")}\n\nFix the new findings, or explain in the commit why the count legitimately grew.`);
    process.exit(1);
  }
  console.log("\nNo lint rule fires more than its recorded baseline.");
}
