/**
 * Absence checks over the source: what a rendered test cannot prove, that a
 * prop appears nowhere. `e2e/a11y.spec.ts` owns what the browser draws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maxFontScale } from "../../src/ui/theme";
import { sourceFiles } from "../source-corpus";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("system text size is never opted out of", () => {
  // A ceiling is allowed only at the shared 200% WCAG 1.4.4 asks for, on a box that
  // cannot grow with its text; opting out, or a literal below 2, costs a user their size.
  it("no component disables font scaling", () => {
    const offenders = sourceFiles("src", { atLeast: 100 }).filter((file) =>
      /allowFontScaling\s*=\s*\{?\s*false/.test(source(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("caps the font multiplier only at the shared token", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src", { atLeast: 100 })) {
      for (const [index, line] of source(file).split("\n").entries()) {
        if (!line.includes("maxFontSizeMultiplier")) continue;
        if (line.includes("maxFontSizeMultiplier={maxFontScale.measuredBox}")) continue;
        offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders, "a text ceiling that is not the shared 200% token").toEqual([]);
  });

  it("keeps the shared ceiling at the 200% WCAG 1.4.4 asks for", () => {
    expect(maxFontScale.measuredBox).toBe(2);
  });
});

describe("password-manager metadata on the sign-in form", () => {
  // `/(auth)/sign-in` is unreachable from the e2e workspace, which is local-only and so
  // signed in, so this stays a source check; a real device verifies the autofill itself.
  it("declares email, mode-correct password and one-time-code autofill hints", () => {
    const signIn = source("src/app/(auth)/sign-in.tsx");
    expect(signIn).toContain('autoComplete={creating ? "new-password" : "current-password"}');
    expect(signIn).toContain('textContentType={creating ? "newPassword" : "password"}');
    // Only sign-in asks for the current password; sign-up and reset make a new one.
    expect(signIn).toMatch(/signIn: \{[^\n]*password: "current"/);
    expect(signIn).toMatch(/signUp: \{[^\n]*password: "new"/);
    expect(signIn).toMatch(/reset: \{[^\n]*password: "new"/);
    // The e-mail and the e-mailed code take the shared field props.
    expect(signIn).toContain("{...EMAIL_FIELD}");
    expect(signIn).toContain("{...CODE_FIELD}");
    const components = source("src/ui/components.tsx");
    expect(components).toMatch(/EMAIL_FIELD = \{[\s\S]*?autoComplete: "email"[\s\S]*?textContentType: "emailAddress"/);
    expect(components).toMatch(/CODE_FIELD = \{[\s\S]*?autoComplete: "one-time-code"[\s\S]*?textContentType: "oneTimeCode"/);
  });
});
