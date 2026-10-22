import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      // Scans every file under `src/` for colour and size literals. Stryker
      // runs against an instrumented copy whose mutant ids are quoted strings
      // ("1a", "2f"), which read as an alpha channel, so the dry run dies. It
      // guards `src/ui`, which is not mutated, and stays in the normal gate.
      "tests/ui/design-system-contract.test.ts",
    ],
    environment: "node",
    // Instrumentation, not the tests, makes Vitest's 5-second default too
    // short; the normal gate keeps the default.
    testTimeout: 60_000,
  },
});
