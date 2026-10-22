/** Pauses password re-verification after VERIFY_MAX_FAILURES; keyed to the account that earned it, so another account's streak never blocks this one. Pure. */

export const VERIFY_MAX_FAILURES = 5;
export const VERIFY_COOLDOWN_MS = 30_000;

export interface VerificationBrake {
  /** Account the streak belongs to; `null` means no streak is recorded. */
  userId: string | null;
  failures: number;
  /** Epoch ms until which verification is paused. */
  blockedUntil: number;
}

export const IDLE_BRAKE: VerificationBrake = { userId: null, failures: 0, blockedUntil: 0 };

/** A brake only applies to the account that earned it. */
function ownedBy(brake: VerificationBrake, userId: string): boolean {
  return brake.userId === userId;
}

export function isVerificationBlocked(brake: VerificationBrake, userId: string, now: number): boolean {
  return ownedBy(brake, userId) && now < brake.blockedUntil;
}

/**
 * Record a failed attempt. Reaching the limit engages the cooldown and restarts
 * the streak, so the next block needs another full run of failures.
 */
export function recordVerificationFailure(
  brake: VerificationBrake,
  userId: string,
  now: number,
): VerificationBrake {
  // A different owner means the previous streak is irrelevant, not additive.
  const failures = (ownedBy(brake, userId) ? brake.failures : 0) + 1;
  if (failures >= VERIFY_MAX_FAILURES) {
    return { userId, failures: 0, blockedUntil: now + VERIFY_COOLDOWN_MS };
  }
  return { userId, failures, blockedUntil: ownedBy(brake, userId) ? brake.blockedUntil : 0 };
}

/** A correct password clears this account's streak and any pending cooldown. */
export function recordVerificationSuccess(brake: VerificationBrake, userId: string): VerificationBrake {
  return ownedBy(brake, userId) ? IDLE_BRAKE : brake;
}
