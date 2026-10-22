import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // The layers that decide what a record means or what gets written. A
      // glob rather than a list: a new file there is gated the day it lands,
      // with nobody having to remember to add it. Screens and tokens are not
      // here — their rules are owned by contract tests, not by line counts.
      // The write layer and its ids are named alone: the rest of `src/db`
      // opens the native driver or imports `.sql`, which Vitest cannot load.
      include: ["src/domain/**/*.ts", "src/data/**/*.ts", "src/db/mutations.ts", "src/db/ids.ts", "src/auth/**/*.ts", "src/sync/**/*.ts"],
      // React's binding over the live stores: one hook call per store, and
      // what it would decide is `live-query.ts`, which is gated. `supabase.ts`
      // only builds the client, which every test replaces.
      exclude: ["src/data/hooks.ts", "src/sync/supabase.ts"],
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary"],
      thresholds: {
        perFile: true,
        branches: 90,
        functions: 100,
        lines: 95,
        statements: 90,
      },
    },
  },
});
