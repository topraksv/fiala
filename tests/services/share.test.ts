/**
 * Handing text to the share sheet (SPEC 6.2): the phone's sheet, the
 * browser's where it has one, the clipboard where it has none; a closed sheet
 * is not an error, anything else is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  os: "ios",
  shared: [] as unknown[],
  shareFails: null as Error | null,
  copied: [] as string[],
}));

vi.mock("react-native", () => ({
  Platform: { get OS() { return device.os; } },
  Share: {
    share: async (content: unknown) => {
      if (device.shareFails) throw device.shareFails;
      device.shared.push(content);
    },
  },
}));

const { shareText } = await import("../../src/services/share");

function browser(withShare: boolean) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      share: withShare ? async () => {} : undefined,
      clipboard: { writeText: async (text: string) => void device.copied.push(text) },
    },
  });
}

const aborted = () => Object.assign(new Error("Share canceled"), { name: "AbortError" });

beforeEach(() => {
  Object.assign(device, { os: "ios", shared: [], shareFails: null, copied: [] });
  browser(false);
});

describe("on a phone", () => {
  it("opens the share sheet with the text, whatever the browser globals say", async () => {
    await expect(shareText("Süt\nEkmek")).resolves.toBe("sheet");
    expect(device.shared).toEqual([{ message: "Süt\nEkmek" }]);
    expect(device.copied).toEqual([]);
  });

  it("lets a failing sheet fail the caller", async () => {
    device.shareFails = new Error("no activity");
    await expect(shareText("Süt")).rejects.toThrow("no activity");
  });
});

describe("on the web", () => {
  beforeEach(() => {
    device.os = "web";
  });

  it("copies the text where the browser has no share sheet, and says so", async () => {
    await expect(shareText("Süt")).resolves.toBe("clipboard");
    expect(device.copied).toEqual(["Süt"]);
    expect(device.shared).toEqual([]);
  });

  it("uses the browser's sheet where it has one", async () => {
    browser(true);
    await expect(shareText("Süt")).resolves.toBe("sheet");
    expect(device.shared).toEqual([{ message: "Süt" }]);
    expect(device.copied).toEqual([]);
  });

  it("treats a sheet the person closed as done, not as a failure", async () => {
    browser(true);
    device.shareFails = aborted();
    await expect(shareText("Süt")).resolves.toBe("sheet");
  });

  it("still reports any other refusal", async () => {
    browser(true);
    device.shareFails = Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
    await expect(shareText("Süt")).rejects.toThrow("not allowed");
  });

  it("does not take a thrown non-error for a closed sheet", async () => {
    browser(true);
    device.shareFails = { name: "AbortError" } as unknown as Error;
    await expect(shareText("Süt")).rejects.toEqual({ name: "AbortError" });
  });
});
