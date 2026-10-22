import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FOCUS_BOX, FOCUS_PROPERTY, focusRingCss } from "../../src/ui/focus-ring";
import { DEFAULT_PALETTE_ID, PALETTES } from "../../src/ui/theme";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const css = focusRingCss("#000000");

describe("the keyboard focus ring", () => {
  it("is drawn by the app in the live palette's focus colour, the default palette's before the app runs", () => {
    const defaultCss = focusRingCss(PALETTES[DEFAULT_PALETTE_ID].light.focus);
    expect(defaultCss).toContain(`outline:2px solid var(${FOCUS_PROPERTY},${PALETTES[DEFAULT_PALETTE_ID].light.focus})`);
    expect(read("src/app/+html.tsx")).toContain("focusRingCss(");
    expect(read("src/app/_layout.tsx")).toContain("FOCUS_PROPERTY");
  });

  it("shows for the keyboard only, inside its own box so a card's clipping cannot cut it", () => {
    expect(css).not.toMatch(/:focus[^-]/);
    expect(css).toContain("outline-offset:-2px");
  });

  // A sheet is react-native-web's Modal, which renders beside `#root` rather
  // than in it: scoped to `#root`, not one control in a sheet had the ring.
  it("covers every element Fiala lets focus reach, in a sheet too, react-native-web's own outline reset included", () => {
    expect(css).not.toContain("#root");
    for (const target of ["[tabindex]", "[role=button]", "[role=checkbox]", "[role=switch]", "[role=radio]", "[role=tab]", "[role=slider]", "input", "textarea"]) {
      expect(css, target).toContain(`body ${target}:focus-visible`);
    }
  });

  // A sheet moves focus to its title for a screen reader; the title is not a
  // control, and a ring round it on every opening reads as a stray selection.
  it("draws no ring round a heading that took focus", () => {
    expect(css.indexOf("body [role=heading]:focus-visible{outline:none")).toBeGreaterThan(css.indexOf("[tabindex]:focus-visible"));
  });

  it("rings the drawn box of a control whose hit area is larger, not the invisible square around it", () => {
    expect(FOCUS_BOX).toEqual({ dataSet: { focusBox: "true" } });
    const hidden = css.indexOf(":focus-visible:has(> [data-focus-box]){outline:none");
    expect(hidden).toBeGreaterThan(css.indexOf("[role=button]:focus-visible"));
    expect(css).toContain(":focus-visible > [data-focus-box]{outline:2px solid");
  });
});
