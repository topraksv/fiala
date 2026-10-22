import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CI_EXECUTED_SCRIPTS, classify } from "../../scripts/classify-changes.mjs";

const root = join(import.meta.dirname, "../..");

describe("classify-changes", () => {
  it.each([
    ["no diff could be taken", null, true],
    ["a record's meaning moved", ["src/domain/lists.ts"], true],
    ["the database moved", ["supabase/migrations/0001_init.sql"], true],
    ["the local database moved", ["src/db/migrations/0001_items.sql"], true],
    ["the dependency tree moved", ["package-lock.json"], true],
    ["the root layout moved", ["src/app/_layout.tsx"], true],
    ["a script the gate runs moved", ["scripts/check-web-budget.mjs"], true],
    ["a path nobody classified appeared", ["babel.config.js", "somewhere/new.ts"], true],
    ["a test behind a floor moved", ["tests/domain/lists.test.ts"], true],
    ["the tests' shared harness moved", ["tests/helpers.ts"], true],
    ["a test of the delivery itself moved", ["tests/repo/lint-ratchet.test.ts"], false],
    ["a screen moved", ["src/app/privacy.tsx"], false],
    ["a token moved", ["src/ui/theme.ts"], false],
    ["the browser suite moved", ["e2e/first-list.spec.ts"], false],
    ["only prose moved", ["docs/BACKLOG.md", "AGENTS.md", ".claude/hooks/stop-gate.sh"], false],
    ["nothing moved", [], false],
  ])("full gate when %s", (_, files, full) => {
    expect(classify(files).full_gate).toBe(full);
  });

  it.each([
    ["no diff could be taken", null, true],
    ["a screen moved", ["src/app/privacy.tsx"], true],
    ["a picture moved", ["public/og-cover.jpg"], true],
    ["the dependency tree moved", ["package-lock.json"], true],
    ["the deploy itself moved", [".github/workflows/ci.yml"], true],
    ["only a test moved", ["tests/repo/lint-ratchet.test.ts"], false],
    ["only the database moved", ["supabase/migrations/0002_lists.sql"], false],
    ["another workflow moved", [".github/workflows/security.yml"], false],
    ["only prose moved", ["docs/RELEASE.md"], false],
  ])("publishes the web when %s", (_, files, publishes) => {
    expect(classify(files).deploy_web).toBe(publishes);
  });

  it.each([
    ["no diff could be taken", null, true],
    ["a screen moved", ["src/app/privacy.tsx"], true],
    ["a picture the app bundles moved", ["assets/icon.png"], true],
    ["the dependency tree moved", ["package-lock.json"], true],
    ["the deploy itself moved", [".github/workflows/ci.yml"], true],
    ["only the web's own files moved", ["public/og-cover.jpg", "scripts/check-web-budget.mjs"], false],
    ["only a test moved", ["tests/repo/lint-ratchet.test.ts"], false],
    ["only prose moved", ["docs/RELEASE.md"], false],
  ])("publishes to Expo Go when %s", (_, files, publishes) => {
    expect(classify(files).deploy_mobile).toBe(publishes);
  });

  // The whole suite, on every push that can change what it renders or how it
  // is tested, on either tier.
  it.each([
    ["no diff could be taken", null, true],
    ["a screen moved", ["src/app/privacy.tsx"], true],
    ["the browser suite moved", ["e2e/first-list.spec.ts"], true],
    ["the server it drives moved", ["scripts/serve-web-export.mjs"], true],
    ["only a unit test moved", ["tests/repo/lint-ratchet.test.ts"], false],
    ["only the database moved", ["supabase/migrations/0002_lists.sql"], false],
  ])("runs the browser suite when %s", (_, files, runs) => {
    expect(classify(files).run_e2e).toBe(runs);
  });

  it("escalates a mixed push by its riskiest path", () => {
    expect(classify(["docs/UI.md", "src/ui/theme.ts", "src/data/lists.ts"])).toMatchObject({
      full_gate: true,
      reason: "high risk: src/data/lists.ts",
    });
  });

  /**
   * Every script ci.yml can reach, followed rather than listed: its `run:`
   * lines, the `npm run` targets they name, the hooks `npm ci` runs, and the
   * configs those commands load — `playwright.config.ts` starts the web server
   * and `stryker.config.mjs` loads the runner, and neither is a `run:`.
   * A script named in a comment is not run, so only `node scripts/…` and a
   * quoted `./scripts/…` count.
   */
  it("escalates exactly the scripts ci.yml can reach, and no more", () => {
    const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    const configFor: Record<string, string[]> = {
      "playwright test": ["playwright.config.ts"],
      "stryker run": ["stryker.config.mjs", "stryker.ci.config.mjs"],
    };
    const reached = new Set<string>();
    const visited = new Set<string>();
    const walk = (text: string) => {
      for (const [, path] of text.matchAll(/(?:node |"\.\/)(scripts\/[\w.-]+\.mjs)/g)) reached.add(path!);
      for (const [command, configs] of Object.entries(configFor)) {
        if (!text.includes(command)) continue;
        for (const config of configs) {
          if (visited.has(config)) continue;
          visited.add(config);
          walk(readFileSync(join(root, config), "utf8"));
        }
      }
      for (const [, name, noHooks] of text.matchAll(/npm (?:run )?([\w:-]+)( --ignore-scripts)?/g)) {
        const targets = name === "ci" ? (noHooks ? [] : ["preinstall", "install", "postinstall", "prepare"]) : [name!];
        for (const target of targets) {
          if (visited.has(target) || scripts[target] == null) continue;
          visited.add(target);
          walk(scripts[target]!);
        }
      }
    };
    walk(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));

    expect(reached.size).toBeGreaterThan(3);
    expect([...CI_EXECUTED_SCRIPTS].sort()).toEqual([...reached].sort());
  });

  // `check-published.mjs green` owns the one query, unfiltered and paged: its
  // note says which run search answered weeks stale, and what that cost.
  it("asks for the newest green run through one paged query", () => {
    for (const name of ["ci.yml", "nightly.yml", "release.yml"]) {
      const text = readFileSync(join(root, ".github/workflows", name), "utf8");
      expect(text, name).not.toContain("/runs?");
      expect(text, name).toContain("node scripts/check-published.mjs green");
    }
  });
});
