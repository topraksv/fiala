import { describe, expect, it } from "vitest";

import { SessionEpoch, SessionEpochCancelledError } from "../../src/sync/session-epoch";

describe("the session epoch", () => {
  it("aborts one account's epoch when another account starts", () => {
    const epoch = new SessionEpoch();
    const first = epoch.start("a");
    expect(epoch.activeUserId).toBe("a");
    const next = epoch.start("b");
    expect(first.signal.aborted).toBe(true);
    expect(epoch.isCurrent(next)).toBe(true);
    expect(() => epoch.assertCurrent(first)).toThrow(SessionEpochCancelledError);
  });

  it("does not let a late callback reactivate a stopped session", () => {
    const epoch = new SessionEpoch();
    const token = epoch.start("a");
    epoch.stop();
    expect(token.signal.aborted).toBe(true);
    expect(epoch.capture("a")).toBeNull();
    expect(epoch.isCurrent(token)).toBe(false);
  });
});
