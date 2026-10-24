import { describe, expect, it } from "vitest";

import { TILE_WIDTH, WEEKDAY_TILE_WIDTH, tabLabelsFit, tileColumns, tooWide } from "../../src/ui/responsive";

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

describe("a row of tiles under a larger system text size", () => {
  it("keeps three tiles on the narrowest phone at size 1 and drops columns as the size grows", () => {
    expect(tileColumns(288, 1, 3)).toBe(3);
    expect(tileColumns(358, 1.3, 3)).toBe(2);
    expect(tileColumns(358, 2, 3)).toBe(1);
  });

  it("never asks for more than it has, nor fewer than one", () => {
    expect(tileColumns(1180, 1, 3)).toBe(3);
    expect(tileColumns(100, 3, 2)).toBe(1);
    // A system that reports below 1 never widens a tile past its wanted count.
    expect(tileColumns(288, 0.8, 3, TILE_WIDTH)).toBe(3);
  });

  it("keeps a week on one row until a weekday's letters would break", () => {
    expect(tileColumns(288, 1, 7, WEEKDAY_TILE_WIDTH)).toBe(7);
    expect(tileColumns(358, 1.3, 7, WEEKDAY_TILE_WIDTH)).toBeLessThan(7);
  });
});
