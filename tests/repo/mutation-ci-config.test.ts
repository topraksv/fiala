import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isMutationScoped, selectMutationScope, shardOfScope, weigherOf } from "../../stryker.ci.config.mjs";

const root = join(import.meta.dirname, "../..");

describe("mutation scope", () => {
  it("mutates the in-scope files the range changed", () => {
    const repository = mkdtempSync(join(tmpdir(), "fiala-mutation-scope-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.email", "mutation@example.invalid");
      git("config", "user.name", "Mutation Test");
      // A signing key in the global config would ask for its passphrase here.
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(repository, "src/domain"), { recursive: true });
      writeFileSync(join(repository, "src/domain/list.ts"), "export const size = 1;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(repository, "src/domain/list.ts"), "export const size = 2;\n");
      writeFileSync(join(repository, "README.md"), "prose\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "change");
      expect(selectMutationScope({ base, head: git("rev-parse", "HEAD"), cwd: repository })).toEqual(["src/domain/list.ts"]);

      // A file's tests or its recorded floor decide its score as much as its source.
      writeFileSync(join(repository, "src/domain/item.ts"), "export const kind = 1;\n");
      writeFileSync(join(repository, "mutation-baseline.json"), JSON.stringify({ files: { "src/domain/item.ts": { score: 80 }, "src/domain/list.ts": { score: 90 } } }));
      git("add", ".");
      git("commit", "--quiet", "-m", "floors");
      const floors = git("rev-parse", "HEAD");
      mkdirSync(join(repository, "tests/domain"), { recursive: true });
      // Named for what it checks, not for the file it imports.
      writeFileSync(join(repository, "tests/domain/size-bounds.test.ts"), 'import { size } from "../../src/domain/list";\n// fewer cases\n');
      writeFileSync(join(repository, "mutation-baseline.json"), JSON.stringify({ files: { "src/domain/item.ts": { score: 85 }, "src/domain/list.ts": { score: 90, measuredOn: "later" } } }));
      git("add", ".");
      git("commit", "--quiet", "-m", "raise");
      // list.ts comes in through its test; its floor only moved provenance.
      expect(selectMutationScope({ base: floors, head: git("rev-parse", "HEAD"), cwd: repository })).toEqual([
        "src/domain/item.ts",
        "src/domain/list.ts",
      ]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }, 30_000);

  // A push must name a range it can resolve; only a dispatch falls back to
  // the sentinels without one.
  it("fails closed on a push it cannot measure", () => {
    expect(() => selectMutationScope({ base: "0".repeat(40), head: "HEAD", cwd: root })).toThrow(/zero SHA/);
    expect(() => selectMutationScope({ base: "", head: "HEAD", eventName: "push", cwd: root })).toThrow(/missing mutation diff/i);
    expect(selectMutationScope({ base: "", head: "", eventName: "workflow_dispatch", cwd: root })).toContain("src/domain/names.ts");
  });

  // Every directory with logic; never what carries none.
  it("mutates storage, sync, sign-in and services, never what has nothing to mutate", () => {
    for (const file of ["src/domain/items.ts", "src/data/items.ts", "src/db/mutations.ts", "src/sync/engine.ts", "src/auth/session.ts", "src/services/reminders.native.ts"]) {
      expect(isMutationScoped(file), file).toBe(true);
    }
    for (const file of ["src/db/schema.ts", "src/db/migrations/migrations.js", "src/db/expo-sqlite.server.js", "src/sync/realtime-absent.js", "src/data/hooks.ts", "src/ui/theme.ts", "src/app/index.tsx"]) {
      expect(isMutationScoped(file), file).toBe(false);
    }
  });

  it("deals every file to exactly one shard, heaviest first", () => {
    const sizes: Record<string, number> = { "a.ts": 900, "b.ts": 500, "c.ts": 400, "d.ts": 300, "e.ts": 100 };
    const files = Object.keys(sizes);
    const shards = [1, 2, 3].map((shard) => shardOfScope(files, `${shard}/3`, (file: string) => sizes[file]!));
    expect(shards).toEqual([["a.ts"], ["b.ts", "e.ts"], ["c.ts", "d.ts"]]);
    expect(() => shardOfScope(files, "4/3", () => 1)).toThrow(/MUTATION_SHARD/);
  });

  it("weighs a file by its recorded cost, and an unrecorded one by bytes at the recorded rate", () => {
    const sizes: Record<string, number> = { "static.ts": 100, "plain.ts": 300, "new.ts": 200 };
    const sizeOf = (file: string) => {
      if (!(file in sizes)) throw new Error(`ENOENT ${file}`);
      return sizes[file]!;
    };
    const weightOf = weigherOf({ "static.ts": { cost: 3000 }, "plain.ts": { cost: 1000 }, "gone.ts": { cost: 50 } }, sizeOf);
    expect(["static.ts", "plain.ts", "new.ts", "gone.ts", "missing.ts"].map(weightOf)).toEqual([3000, 1000, 2000, 50, 0]);
    expect(weigherOf({}, sizeOf)("new.ts")).toBe(200);
  });
});
