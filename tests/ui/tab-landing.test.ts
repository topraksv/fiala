/**
 * A row that leaves one tab for another flies to that tab and the tab
 * bounces as it lands (`docs/UI.md` section 7): the bar says where each tab
 * sits, and a screen asks.
 */

import { describe, expect, it, vi } from "vitest";

import { flightTo, landTab, onLanding, placeTabs, tabCentre } from "../../src/ui/tab-landing";

describe("placeTabs", () => {
  it("puts each tab at the middle of its slot, inside the bar's edge", () => {
    placeTabs(["index", "pantry"], { x: 16, y: 700, width: 208, height: 60 }, 4);
    expect(tabCentre("index")).toEqual({ x: 16 + 4 + 50, y: 730 });
    expect(tabCentre("pantry")).toEqual({ x: 16 + 4 + 150, y: 730 });
  });

  it("knows nothing of a tab the bar has not laid out", () => {
    expect(tabCentre("nowhere")).toBeNull();
  });
});

describe("flightTo", () => {
  it("carries a row's centre onto the point", () => {
    expect(flightTo({ x: 20, y: 100, width: 300, height: 60 }, { x: 70, y: 730 })).toEqual({ dx: -100, dy: 600 });
  });
});

describe("landTab", () => {
  it("tells whoever listens which tab something landed on, until they stop", () => {
    const heard = vi.fn();
    const stop = onLanding(heard);
    landTab("index");
    stop();
    landTab("index");
    expect(heard.mock.calls).toEqual([["index"]]);
  });
});
