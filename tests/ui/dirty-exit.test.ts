/**
 * A form holding an unsaved draft asks before it loses it. The wiring is read
 * from the source: a panel that closed on `onClose` directly would drop a
 * draft without a single failing screen.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const confirm = vi.fn<(title: string, message: string, label: string) => Promise<boolean>>();
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-router", () => ({ useIsFocused: vi.fn(), useNavigation: vi.fn() }));
vi.mock("expo-router/react-navigation", () => ({ usePreventRemove: vi.fn() }));
vi.mock("../../src/ui/dialog", () => ({ appConfirm: (...args: [string, string, string]) => confirm(...args) }));
vi.mock("../../src/ui/navigation", () => ({ registerDirtyExitFallback: vi.fn() }));

const { confirmDiscard } = await import("../../src/ui/dirty-exit");

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("confirmDiscard", () => {
  beforeEach(() => confirm.mockReset());

  it("leaves a clean draft without asking", () => {
    const leave = vi.fn();
    confirmDiscard(false, leave);
    expect(leave).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("leaves a dirty draft only on the discard action", async () => {
    const leave = vi.fn();
    confirm.mockResolvedValueOnce(false);
    confirmDiscard(true, leave);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(leave).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    confirmDiscard(true, leave);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
  });

  it("asks once however often back is pressed while the question is up", async () => {
    let answer: (discard: boolean) => void = () => {};
    confirm.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const leave = vi.fn();
    confirmDiscard(true, leave);
    confirmDiscard(true, leave);
    expect(confirm).toHaveBeenCalledOnce();
    answer(true);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
  });
});

describe("the draft guard's wiring", () => {
  it.each(["src/app/feedback.tsx", "src/app/account-security.tsx"])("%s guards its route", (path) => {
    expect(read(path)).toMatch(/useDirtyExitGuard\(/);
  });

  it("the send leaves the feedback form without asking", () => {
    const screen = read("src/app/feedback.tsx");
    expect(screen).toMatch(/allowExit\(\(\) => navigateBack\(router, home\)\)/);
    expect(screen).toContain('const home = signedIn ? "/settings" : "/sign-in";');
  });
});
