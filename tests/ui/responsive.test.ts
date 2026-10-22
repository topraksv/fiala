import { describe, expect, it } from "vitest";

import { tabLabelsFit, tooWide } from "../../src/ui/responsive";

describe("the floating tab bar's labels", () => {
  // Labels must render once to be measured, so "not measured" reads as fits.
  it("draws labels before anything has been measured", () => {
    expect(tabLabelsFit(0, 0)).toBe(true);
    expect(tabLabelsFit(0, 60)).toBe(true);
    expect(tabLabelsFit(48, 0)).toBe(true);
  });

  it("drops labels the moment the widest stops clearing its column, and brings them back", () => {
    expect(tabLabelsFit(54, 60)).toBe(true);
    expect(tabLabelsFit(55, 60)).toBe(false);
    expect(tabLabelsFit(84, 120)).toBe(true);
  });

  it("treats a wrapped label as too wide for any column", () => {
    expect(tabLabelsFit(tooWide(60), 60)).toBe(false);
    expect(tabLabelsFit(tooWide(120), 120)).toBe(false);
  });
});
