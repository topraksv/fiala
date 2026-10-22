/** The part of the day a greeting is written for. */

import { describe, expect, it } from "vitest";

import { partOfDay } from "../../src/domain/dates";

describe("dates", () => {
  it("names the part of the day by the device's hour", () => {
    const at = (hour: number, minute: number) => partOfDay(new Date(2026, 9, 1, hour, minute));
    expect(at(0, 0)).toBe("night");
    expect(at(5, 59)).toBe("night");
    expect(at(6, 0)).toBe("morning");
    expect(at(11, 59)).toBe("morning");
    expect(at(12, 0)).toBe("day");
    expect(at(17, 59)).toBe("day");
    expect(at(18, 0)).toBe("evening");
    expect(at(23, 59)).toBe("evening");
  });
});
