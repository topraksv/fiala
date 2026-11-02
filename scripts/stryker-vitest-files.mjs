// Stryker reruns a mutant by test name joined with spaces; Vitest 5 joins with " > ", so tests inside a describe match nothing and every mutant survives.
// The id keeps the test's file before the `#`, so running the covering files whole can only kill more. Delete when upstream matches Vitest 5's names.
//
// A static mutant (module-level code, run once at import) has no per-test coverage, so Stryker runs every test for it: 787 of
// one release's 11,368 mutants took 89% of its 135 minutes. Only a test whose import graph loads the mutated file can observe
// it, so those test files run instead. Running fewer tests can only kill fewer mutants: a missed edge lowers a score and fails
// the ratchet, it never passes a weak suite. Vitest's own `related` was rejected for this: its graph cannot parse the `.sql`
// migrations. A test with an import this reader cannot resolve stays in every static mutant's run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { strykerPlugins as upstream } from "@stryker-mutator/vitest-runner";

const [vitest] = upstream;

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*)["'](\.{1,2}\/[^"'?]+)/g;
const CANDIDATES = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];
const CODE = /\.(?:[cm]?js|tsx?)$/;

function resolveSpecifier(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const suffix of CANDIDATES) {
    const path = base + suffix;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

function testFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every test file under `root/tests`, with the files its imports reach, or `null` where one import could not be resolved. */
export function importGraph(root) {
  const reach = new Map();
  const edges = (file) => {
    if (!CODE.test(file)) return [];
    const found = [];
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) found.push(resolveSpecifier(file, match[1]));
    return found;
  };
  for (const test of testFilesUnder(join(root, "tests"))) {
    const seen = new Set();
    const stack = [test];
    let whole = true;
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const next of edges(file)) {
        if (next === null) whole = false;
        else stack.push(next);
      }
    }
    reach.set(test, whole ? seen : null);
  }
  return reach;
}

/** The test files that can observe a change to `file`; empty when none can be shown, which the caller reads as "all". */
export function testsLoading(graph, file) {
  const target = resolve(file);
  return [...graph].filter(([, reached]) => reached === null || reached.has(target)).map(([test]) => test);
}

function createRunner(injector) {
  const runner = vitest.factory(injector);
  const run = runner.run.bind(runner);
  const mutantRun = runner.mutantRun.bind(runner);
  let graph = null;
  let staticTarget = null;
  runner.mutantRun = async (options) => {
    staticTarget = options.testFilter === undefined ? options.sandboxFileName : null;
    try {
      return await mutantRun(options);
    } finally {
      staticTarget = null;
    }
  };
  runner.run = ({ testIds = [], ...rest } = {}) => {
    if (testIds.length > 0) return run({ ...rest, testFiles: [...new Set(testIds.map((id) => id.split("#")[0]))] });
    if (staticTarget) {
      graph ??= importGraph(process.cwd());
      const testFiles = testsLoading(graph, staticTarget);
      if (testFiles.length > 0) return run({ ...rest, testFiles });
    }
    return run(rest);
  };
  return runner;
}
createRunner.inject = vitest.factory.inject;

export const strykerPlugins = [{ ...vitest, name: "vitest-files", factory: createRunner }];
