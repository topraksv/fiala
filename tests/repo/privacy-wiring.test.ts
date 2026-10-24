import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "../source-corpus";

// localStorage on web is readable by any script on the origin; only named
// non-secret keys may be written. CodeQL flags the writer because the id and
// address `signInWithPassword` returns land there; session material stays in
// supabase-js.
describe("the device's key-value store", () => {
  it("holds only named, non-secret keys", () => {
    // `kvSwitch` and `kvList` forward their key to `kv.set`, so that forwarding is the
    // one variable allowed, and each one's key is read where it is made.
    const forwarding = join("src", "services", "kv.ts");
    const keys = sourceFiles("src", { atLeast: 60 }).flatMap((file) =>
      [...readFileSync(join(process.cwd(), file), "utf8").matchAll(/(?<!function )(?:kv\.set|kvSwitch|kvList)\(\s*([^,)]+)[,)]/g)]
        .map((match) => match[1]!.trim())
        .filter((key) => !(file === forwarding && key === "key")),
    );
    // An empty sweep would pass everything below.
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) {
      expect(key).not.toMatch(/token|password|secret|credential|jwt|session/i);
      expect(key).toMatch(/^("fiala\.[\w.-]+"|[A-Z][A-Z0-9_]*_KEY|(APPEARANCE_)?KEYS\.\w+)$/);
    }
  });
});
