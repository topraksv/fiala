/**
 * A glob so a new domain file is mutated the day it lands. The runner is
 * `scripts/stryker-vitest-files.mjs`, which says why.
 */
export default {
  mutate: ["src/domain/**/*.ts"],
  ignorePatterns: ["/android/**", "/ios/**", "/dist/**", "/dist-e2e/**", "/.expo/**", "/.claude/**", "/docs/**", "/coverage/**", "/playwright-report/**", "/test-results/**", "/reports/**"],
  plugins: ["@stryker-mutator/vitest-runner", "./scripts/stryker-vitest-files.mjs"],
  testRunner: "vitest-files",
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  concurrency: 4,
  timeoutMS: 15_000,
  cleanTempDir: "always",
  vitest: { configFile: "vitest.mutation.config.mts", related: false },
};
