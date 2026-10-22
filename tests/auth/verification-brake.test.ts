import { describe, expect, it } from "vitest";

import {
  IDLE_BRAKE,
  isVerificationBlocked,
  recordVerificationFailure,
  recordVerificationSuccess,
  VERIFY_COOLDOWN_MS,
  VERIFY_MAX_FAILURES,
  type VerificationBrake,
} from "../../src/auth/verification-brake";

describe("the brake on password checks", () => {
  const A = "user-a";
  const B = "user-b";
  const T0 = 1_000_000;
  const fail = (brake: VerificationBrake, userId: string, count: number) => {
    let next = brake;
    for (let i = 0; i < count; i++) next = recordVerificationFailure(next, userId, T0);
    return next;
  };

  it("stops an account for the cooldown after its run of failures, and a success clears it", () => {
    expect(isVerificationBlocked(fail(IDLE_BRAKE, A, VERIFY_MAX_FAILURES - 1), A, T0)).toBe(false);
    const engaged = fail(IDLE_BRAKE, A, VERIFY_MAX_FAILURES);
    expect(isVerificationBlocked(engaged, A, T0 + VERIFY_COOLDOWN_MS - 1)).toBe(true);
    expect(isVerificationBlocked(engaged, A, T0 + VERIFY_COOLDOWN_MS)).toBe(false);
    // The streak restarts once engaged: the next block needs a whole run.
    expect(isVerificationBlocked(recordVerificationFailure(engaged, A, T0 + VERIFY_COOLDOWN_MS), A, T0 + VERIFY_COOLDOWN_MS)).toBe(false);
    expect(recordVerificationSuccess(engaged, A)).toEqual(IDLE_BRAKE);
  });

  it("belongs to the account that earned it", () => {
    const engaged = fail(IDLE_BRAKE, A, VERIFY_MAX_FAILURES);
    expect(isVerificationBlocked(engaged, B, T0)).toBe(false);
    const bFirst = recordVerificationFailure(fail(IDLE_BRAKE, A, VERIFY_MAX_FAILURES - 1), B, T0);
    expect(bFirst).toEqual({ userId: B, failures: 1, blockedUntil: 0 });
    expect(isVerificationBlocked(recordVerificationSuccess(engaged, B), A, T0)).toBe(true);
  });
});
