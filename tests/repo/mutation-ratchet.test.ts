import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluate as evaluateMutation, recordedFrom, scoreOf } from "../../scripts/check-mutation-ratchet.mjs";
import { selectMutationScope } from "../../stryker.ci.config.mjs";

const root = join(import.meta.dirname, "../..");

describe("mutation ratchet", () => {
  const present = () => true;

  it("counts a timeout as detected and an uncovered mutant against the total", () => {
    expect(scoreOf([{ status: "Killed" }, { status: "Timeout" }, { status: "Survived" }, { status: "NoCoverage" }])).toBe(50);
    expect(scoreOf([{ status: "CompileError" }])).toBe(100);
  });

  it("holds a file to its recorded score, half a point of runner drift aside", () => {
    expect(evaluateMutation({ "a.ts": 91.4 }, { files: { "a.ts": { score: 91.8 } } }, present).problems).toEqual([]);
    expect(evaluateMutation({ "a.ts": 91.2 }, { files: { "a.ts": { score: 91.8 } } }, present).problems[0]).toMatch(/^WORSE a\.ts: 91\.80 -> 91\.20\./);
  });

  it("records the counts behind each score, what they cost, and the tree it was measured on", () => {
    const mutants = ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError"].map((status, index) => ({ status, ...(index < 3 && { testsCompleted: 10 * (index + 1) }) }));
    expect(recordedFrom({ files: { "a.ts": { mutants } } }, "abc", "2026-10-08")).toEqual({
      "a.ts": { score: 50, killed: 1, timeout: 1, survived: 1, noCoverage: 1, cost: 60, measuredOn: "abc", measuredDate: "2026-10-08" },
    });
  });

  // A push that touches nothing in scope mutates the sentinels; an unrecorded
  // one fails that push for a reason it did not cause.
  it("has a recorded floor for every sentinel, with the counts that derive it", () => {
    const recorded = JSON.parse(readFileSync(join(root, "mutation-baseline.json"), "utf8")).files;
    const sentinels = selectMutationScope({ base: "", head: "", eventName: "workflow_dispatch", cwd: root });
    expect(sentinels.filter((file: string) => recorded[file] === undefined)).toEqual([]);
    for (const [file, entry] of Object.entries(recorded) as [string, Record<string, number>][]) {
      const detected = entry.killed! + entry.timeout!;
      const valid = detected + entry.survived! + entry.noCoverage!;
      expect(valid === 0 ? 100 : Number(((detected / valid) * 100).toFixed(2)), file).toBe(entry.score);
      expect(entry.measuredOn, file).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("refuses a file nobody measured and an entry whose file is gone", () => {
    const { problems } = evaluateMutation({ "new.ts": 99 }, { files: { "gone.ts": { score: 80 } } }, (file) => file !== "gone.ts");
    expect(problems.map((problem) => problem.split(" ")[0])).toEqual(["UNRECORDED", "STALE"]);
  });

  // Vitest 5 matches a name filter against "suite > test", which Stryker 10
  // does not send, so a mutant's covering tests are run by file instead.
  it("runs a mutant's covering tests by their files, not by a name Vitest 5 would not match", async () => {
    const { strykerPlugins } = await import("../../scripts/stryker-vitest-files.mjs");
    const calls: unknown[] = [];
    const upstream = { run: (options: unknown) => calls.push(options) };
    const injector = { provideValue: () => ({ injectClass: () => upstream }) };
    // `run` is the upstream runner's own method, not part of Stryker's `TestRunner` contract.
    const runner = strykerPlugins[0]!.factory(injector) as unknown as { run: (options: object) => void };
    runner.run({ testIds: ["tests/a.test.ts#suite one", "tests/a.test.ts#suite two", "tests/b.test.ts#other"], relatedFiles: ["x"] });
    runner.run({ relatedFiles: ["x"] });
    expect(calls).toEqual([{ relatedFiles: ["x"], testFiles: ["tests/a.test.ts", "tests/b.test.ts"] }, { relatedFiles: ["x"] }]);
  });
});
