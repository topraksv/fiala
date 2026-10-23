/**
 * The phone's code scanner (F1.7): iOS asks for the camera and is
 * closed by the app once a code is read; Android asks nothing and closes
 * itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const phone = vi.hoisted(() => ({
  os: "ios",
  granted: true,
  launched: [] as unknown[],
  dismissed: 0,
  listener: null as ((event: { type: string; data: string }) => void) | null,
}));

vi.mock("react-native", () => ({ Platform: { get OS() { return phone.os; } } }));
vi.mock("expo-camera", () => ({
  Camera: { requestCameraPermissionsAsync: async () => ({ granted: phone.granted }) },
  CameraView: {
    isModernBarcodeScannerAvailable: true,
    launchScanner: async (options: unknown) => void phone.launched.push(options),
    dismissScanner: async () => void (phone.dismissed += 1),
    onModernBarcodeScanned: (listener: typeof phone.listener) => {
      phone.listener = listener;
      return { remove: () => (phone.listener = null) };
    },
  },
}));

const { launchScanner, onScanned } = await import("../../src/services/barcode-scan.native");

beforeEach(() => Object.assign(phone, { os: "ios", granted: true, launched: [], dismissed: 0, listener: null }));

describe("launchScanner", () => {
  it("scans a box's karekod and barcode, and on iOS not without the camera", async () => {
    expect(await launchScanner()).toBe(true);
    expect(phone.launched).toEqual([{ barcodeTypes: ["datamatrix", "ean13"] }]);
    phone.granted = false;
    expect(await launchScanner()).toBe(false);
    phone.os = "android";
    expect(await launchScanner()).toBe(true);
    expect(phone.launched).toHaveLength(2);
  });
});

describe("onScanned", () => {
  it("hands over the code, closes iOS's scanner, and stops when told", () => {
    const read: string[] = [];
    const stop = onScanned((code) => read.push(code));
    phone.listener!({ type: "ean13", data: "8690000000001" });
    expect(phone.dismissed).toBe(1);
    phone.os = "android";
    phone.listener!({ type: "ean13", data: "8690000000002" });
    expect(read).toEqual(["8690000000001", "8690000000002"]);
    expect(phone.dismissed, "Android closes its own").toBe(1);
    stop();
    expect(phone.listener).toBeNull();
  });
});

// The web bundles the stand-in, and the add form hides its scan button on this answer.
describe("on the web", () => {
  it("has no scanner, never opens one, and hears no code", async () => {
    const web = await import("../../src/services/barcode-scan");
    const read = vi.fn();
    expect(web.canScan).toBe(false);
    await expect(web.launchScanner()).resolves.toBe(false);
    const stop = web.onScanned(read);
    expect(stop).toBeTypeOf("function");
    stop();
    expect(read).not.toHaveBeenCalled();
  });
});
