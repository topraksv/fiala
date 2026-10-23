import { describe, expect, it } from "vitest";

import { photoViewer } from "../../src/ui/theme";
import { clampPan, clampScale } from "../../src/ui/zoom";

describe("clampScale", () => {
  it("holds a pinch between the whole photo and the largest zoom", () => {
    expect(clampScale(0.4, photoViewer.minZoom, photoViewer.maxZoom)).toBe(photoViewer.minZoom);
    expect(clampScale(2, photoViewer.minZoom, photoViewer.maxZoom)).toBe(2);
    expect(clampScale(9, photoViewer.minZoom, photoViewer.maxZoom)).toBe(photoViewer.maxZoom);
  });
});

describe("clampPan", () => {
  it("allows no drag at 1x, where the photo fits", () => {
    expect(clampPan(50, 400, 400, 1)).toBe(0);
    expect(clampPan(-50, 400, 400, 1)).toBeCloseTo(0);
  });

  it("lets the photo's edge reach the window's and no further", () => {
    // 2x of 400 is 800 wide, 200 spare on each side.
    expect(clampPan(120, 400, 400, 2)).toBe(120);
    expect(clampPan(500, 400, 400, 2)).toBe(200);
    expect(clampPan(-500, 400, 400, 2)).toBe(-200);
  });

  it("holds a photo narrower than the window until zoom makes it wider", () => {
    // A receipt drawn 160 wide in a 400 window: 320 at 2x still fits, 640 at 4x has 120 spare a side.
    expect(clampPan(100, 160, 400, 2)).toBeCloseTo(0);
    expect(clampPan(500, 160, 400, 4)).toBe(120);
  });

  it("treats a scale below 1 as 1", () => {
    expect(clampPan(30, 400, 400, 0.5)).toBe(0);
  });
});
