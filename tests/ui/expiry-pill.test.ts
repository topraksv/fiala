/** What a status pill says, and how full a bar draws: the words and the clamp, in the cabinet's own days. */

import { describe, expect, it } from "vitest";

import type { BoxFacts } from "../../src/domain/boxes";
import { boxPill, productPill, stockShare } from "../../src/ui/expiry-pill";

const TODAY = "2026-11-17";
const box = (patch: Partial<BoxFacts>): BoxFacts => ({
  expiresOn: null,
  soonDays: null,
  openedOn: null,
  useWithinDays: null,
  lowMilli: null,
  remainingMilli: 6000,
  counted: true,
  disposition: null,
  ...patch,
});

describe("boxPill", () => {
  it("says days past in red, days left in amber and the printed day in the quiet tone", () => {
    expect(boxPill(box({ expiresOn: "2026-08-31" }), TODAY)).toEqual({ tone: "error", label: "78 gün önce geçti" });
    expect(boxPill(box({ expiresOn: "2026-11-30" }), TODAY)).toEqual({ tone: "warning", label: "13 gün kaldı" });
    expect(boxPill(box({ expiresOn: "2030-03-01" }), TODAY)).toEqual({ tone: "ok", label: "SKT 01.03.2030" });
  });

  it("is none for a box with no day, one that left, or one with nothing left", () => {
    expect(boxPill(box({}), TODAY)).toBeNull();
    expect(boxPill(box({ expiresOn: "2026-08-31", disposition: "disposed" }), TODAY)).toBeNull();
    expect(boxPill(box({ expiresOn: "2026-08-31", remainingMilli: 0 }), TODAY)).toBeNull();
  });

  it("follows the nearer of the printed day and the opened box's last day, and names the one it follows", () => {
    // Opened on 14 Nov for 7 days: its last day is the 20th, three days away, while the print is years off.
    expect(boxPill(box({ expiresOn: "2030-03-01", openedOn: "2026-11-14", useWithinDays: 7 }), TODAY)).toEqual({ tone: "warning", label: "3 gün kaldı" });
    // Opened for 90 days, far from its end: the open end is still the only day that is there to name.
    expect(boxPill(box({ openedOn: "2026-11-14", useWithinDays: 90 }), TODAY)).toEqual({ tone: "ok", label: "Açıkken son gün 11.02.2027" });
  });
});

describe("productPill", () => {
  it("takes the worst of the boxes, the first among equals", () => {
    const boxes = [box({ expiresOn: "2030-03-01" }), box({ expiresOn: "2026-11-30" }), box({ expiresOn: "2026-08-31" })];
    expect(productPill(boxes, TODAY)?.tone).toBe("error");
    expect(productPill([box({ expiresOn: "2026-11-20" }), box({ expiresOn: "2026-11-30" })], TODAY)?.label).toBe("3 gün kaldı");
    expect(productPill([box({})], TODAY)).toBeNull();
  });
});

describe("stockShare", () => {
  it("is what is left of what went in, never past a full bar", () => {
    expect(stockShare(6000, [{ quantityMilli: 20_000 }, { quantityMilli: -14_000 }])).toBeCloseTo(0.3);
    expect(stockShare(6000, [{ quantityMilli: 6000 }])).toBe(1);
    expect(stockShare(9000, [{ quantityMilli: 6000 }])).toBe(1);
  });

  it("is none until a move says how much went in", () => {
    expect(stockShare(0, [])).toBeNull();
    expect(stockShare(0, [{ quantityMilli: -1000 }])).toBeNull();
  });
});
