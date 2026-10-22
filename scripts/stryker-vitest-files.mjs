// Stryker reruns a mutant by test name joined with spaces; Vitest 5 joins with " > ", so tests inside a describe match nothing and every mutant survives.
// The id keeps the test's file before the `#`, so running the covering files whole can only kill more. Delete when upstream matches Vitest 5's names.
import { strykerPlugins as upstream } from "@stryker-mutator/vitest-runner";

const [vitest] = upstream;

function createRunner(injector) {
  const runner = vitest.factory(injector);
  const run = runner.run.bind(runner);
  runner.run = ({ testIds = [], ...rest } = {}) =>
    run(testIds.length > 0 ? { ...rest, testFiles: [...new Set(testIds.map((id) => id.split("#")[0]))] } : rest);
  return runner;
}
createRunner.inject = vitest.factory.inject;

export const strykerPlugins = [{ ...vitest, name: "vitest-files", factory: createRunner }];
