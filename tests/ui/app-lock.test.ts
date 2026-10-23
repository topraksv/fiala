/**
 * The app lock's switch is named for the sensor the phone has (`docs/TASKS.md`
 * F1.30), Helix's rule: Apple's own names on iOS, the plain ones on Android,
 * and the neutral name when the phone names neither.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ AppState: { currentState: "active" }, Platform: { OS: "ios" } }));
vi.mock("expo-router", () => ({ useNavigationContainerRef: () => null }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("../../src/services/kv", () => ({ kv: {} }));

const { lockName } = await import("../../src/ui/app-lock");

describe("the lock's name", () => {
  it.each([
    [{ ios: true, facial: true, fingerprint: false }, "Face ID Kilidi"],
    [{ ios: true, facial: true, fingerprint: true }, "Face ID Kilidi"],
    [{ ios: true, facial: false, fingerprint: true }, "Touch ID Kilidi"],
    [{ ios: true, facial: false, fingerprint: false }, "Uygulama Kilidi"],
    [{ ios: false, facial: true, fingerprint: false }, "Yüz Tanıma Kilidi"],
    [{ ios: false, facial: true, fingerprint: true }, "Parmak İzi Kilidi"],
    [{ ios: false, facial: false, fingerprint: true }, "Parmak İzi Kilidi"],
    [{ ios: false, facial: false, fingerprint: false }, "Uygulama Kilidi"],
  ])("is %o → %s", (sensors, name) => {
    expect(lockName(sensors)).toBe(name);
  });
});
