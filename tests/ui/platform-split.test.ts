/**
 * A .native file must not import its web twin: on a phone ./stem resolves to
 * itself; typecheck, Vitest and the browser all resolve the web file.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "../source-corpus";

const natives = sourceFiles("src", { extensions: [".native.ts", ".native.tsx"], atLeast: 2 });

describe("a platform split", () => {
  it("takes no value from its own stem", () => {
    const offenders = natives.filter((file) => {
      const stem = basename(file).replace(/\.native\.tsx?$/, "");
      // A re-export resolves the same way; `import type` and `export type` are erased before Metro resolves anything.
      return new RegExp(`^(?:import|export) (?!type\\b)[^;]*from ["']\\./${stem}["'];`, "m").test(readFileSync(join(process.cwd(), file), "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
