// Fails when a mutated file detects fewer mutants than recorded, or has no recorded score; `--record` adopts the last run by hand.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const REPORT = "reports/mutation/mutation.json";
const BASELINE = "mutation-baseline.json";

// Stryker counts a timeout as detected and timeouts vary with load, so a score drifts without code changing; record with `--timeoutMS 60000` (.claude/rules/mutation-gate.md).
const TOLERANCE = 0.5;

// A compile or runtime error is not a mutant the tests could have detected.
const COUNTED = { Killed: "killed", Timeout: "timeout", Survived: "survived", NoCoverage: "noCoverage" };

function countsOf(mutants) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  for (const { status } of mutants) if (status in COUNTED) counts[COUNTED[status]] += 1;
  return counts;
}

/** Stryker's own definition: detected over everything that could be detected. */
export function scoreOf(mutants) {
  const { killed, timeout, survived, noCoverage } = countsOf(mutants);
  const valid = killed + timeout + survived + noCoverage;
  return valid === 0 ? 100 : Number((((killed + timeout) / valid) * 100).toFixed(2));
}

export function scoresFromReport(report) {
  return Object.fromEntries(Object.entries(report.files ?? {}).map(([file, entry]) => [file, scoreOf(entry.mutants ?? [])]));
}

/**
 * The entries `--record` writes: the counts behind each score, so a number can
 * be re-derived, and the tree it was measured on, per file, because a run
 * covers only its scope and one stamp for the document would claim the rest.
 * `cost` is the test runs the file's mutants took, which deals the CI shards
 * (`stryker.ci.config.mjs`).
 */
export function recordedFrom(report, measuredOn, measuredDate) {
  return Object.fromEntries(Object.entries(report.files ?? {}).map(([file, entry]) => {
    const mutants = entry.mutants ?? [];
    const cost = mutants.reduce((sum, mutant) => sum + (mutant.testsCompleted ?? 0), 0);
    return [file, { score: scoreOf(mutants), ...countsOf(mutants), cost, measuredOn, measuredDate }];
  }));
}

/** Read whole, with no existence check first (TOCTOU). */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { files: {} };
    throw error;
  }
}

export function evaluate(measured, baseline, exists = existsSync) {
  const recorded = baseline.files ?? {};
  const problems = [];
  const improvements = [];
  for (const [file, score] of Object.entries(measured)) {
    const previous = recorded[file]?.score;
    if (previous === undefined) problems.push(`UNRECORDED ${file} scored ${score.toFixed(2)}: read what survived, then \`npm run mutation:record\`.`);
    else if (score < previous - TOLERANCE) problems.push(`WORSE ${file}: ${previous.toFixed(2)} -> ${score.toFixed(2)}. Kill what now survives, or say in the commit why the file covers less.`);
    else if (score > previous + TOLERANCE) improvements.push(`${file}: ${previous.toFixed(2)} -> ${score.toFixed(2)}`);
  }
  for (const file of Object.keys(recorded)) {
    if (!exists(file)) problems.push(`STALE ${file} is recorded but gone: delete its entry.`);
  }
  return { problems, improvements };
}

if (import.meta.main) {
  if (!existsSync(REPORT)) {
    console.error(`No mutation report at ${REPORT}. Run the mutation gate first.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const baseline = readBaseline();

  if (process.argv.includes("--record")) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const entries = recordedFrom(report, head, new Date().toISOString().slice(0, 10));
    // A file deleted since takes its entry with it: the check above names it STALE.
    const merged = Object.entries({ ...baseline.files, ...entries }).filter(([file]) => existsSync(file)).sort(([a], [b]) => a.localeCompare(b));
    writeFileSync(BASELINE, `${JSON.stringify({ files: Object.fromEntries(merged) }, null, 2)}\n`);
    for (const [file, { score }] of Object.entries(entries)) {
      const before = baseline.files?.[file]?.score;
      console.log(`${score.toFixed(2).padStart(6)}  ${before === undefined ? "new" : `was ${before.toFixed(2)}`}  ${file}`);
    }
    console.log(`Recorded ${Object.keys(entries).length} file(s) into ${BASELINE}.`);
    process.exit(0);
  }

  const { problems, improvements } = evaluate(scoresFromReport(report), baseline);
  if (improvements.length > 0) {
    console.log(`Above the recorded score, record only if tests you added earned it:\n  ${improvements.join("\n  ")}`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`No mutated file detects less than ${BASELINE} records.`);
}
