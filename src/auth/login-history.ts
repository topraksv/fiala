/** Device-local record of the sign-in before this one, for the account screen. */

import { uuidv7 } from "uuidv7";

export interface LoginHistoryStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const APP = "fiala";

function currentKey(userId: string): string {
  return `${APP}.login.current.${userId}`;
}

function previousKey(userId: string): string {
  return `${APP}.login.previous.${userId}`;
}

/**
 * Advance history only after a complete successful sign-in. The timestamp
 * returned is the login before the one being recorded, never this session.
 */
export async function recordSuccessfulLogin(
  storage: LoginHistoryStorage,
  userId: string,
  signedInAt: string,
): Promise<string | null> {
  const previous = await storage.get(currentKey(userId));
  if (previous) await storage.set(previousKey(userId), previous);
  else await storage.remove(previousKey(userId));
  await storage.set(currentKey(userId), signedInAt);
  return previous;
}

/** A fresh account starts a history but has no prior login to display. */
export async function startLoginHistory(
  storage: LoginHistoryStorage,
  userId: string,
  signedInAt: string,
): Promise<void> {
  await storage.remove(previousKey(userId));
  await storage.set(currentKey(userId), signedInAt);
}

/** The stored sign-in before the current one; offline reopening reads it without advancing. */
export function loadPreviousLogin(storage: LoginHistoryStorage, userId: string): Promise<string | null> {
  return storage.get(previousKey(userId));
}

/**
 * This install's own id, made once and kept across sign-outs: the key of the
 * one sign-in row each device writes to the account (`src/domain/logins.ts`).
 */
export async function deviceId(storage: LoginHistoryStorage): Promise<string> {
  const key = `${APP}.device.id`;
  const known = await storage.get(key);
  if (known) return known;
  const made = uuidv7();
  await storage.set(key, made);
  return made;
}
