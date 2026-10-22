/**
 * A picture chosen from the library is kept shrunk: its longest edge at most
 * the one asked for, as a JPEG data URI.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const picker = vi.hoisted(() => ({ launchImageLibraryAsync: vi.fn() }));
const resized = vi.hoisted(() => [] as unknown[]);
vi.mock("expo-image-picker", () => picker);
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: () => ({
      resize(size: unknown) {
        const base64 = `b${resized.push(size)}`;
        return { renderAsync: async () => ({ saveAsync: async () => ({ base64 }) }) };
      },
    }),
  },
}));

const { default: pickPicture, edgeOf } = await import("../../src/ui/photo-take");

const shot = { canceled: false, assets: [{ uri: "file:///a.jpg", width: 4032, height: 3024 }] };

beforeEach(() => {
  resized.length = 0;
  picker.launchImageLibraryAsync.mockReset().mockResolvedValue(shot);
});

describe("edgeOf", () => {
  it("bounds the longest edge and never enlarges", () => {
    expect(edgeOf(4032, 3024, 1024)).toEqual({ width: 1024 });
    expect(edgeOf(3024, 4032, 1024)).toEqual({ height: 1024 });
    expect(edgeOf(640, 480, 1024)).toEqual({ width: 640 });
  });
});

describe("pickPicture", () => {
  it("keeps the picture as a JPEG data URI, shrunk to the edge asked for", async () => {
    expect(await pickPicture(1600)).toBe("data:image/jpeg;base64,b1");
    expect(resized).toEqual([{ width: 1600 }]);
  });

  it("comes back empty when nothing was picked", async () => {
    picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickPicture(1600)).toBe("cancelled");
    expect(resized).toEqual([]);
  });
});
