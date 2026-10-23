/**
 * What follows the person to every device (`docs/ARCHITECTURE.md`, "Tables"),
 * a key and its JSON value: whether the account is frozen, which is why a
 * frozen account locks every device, and each device's last sign-in.
 */

import { isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { editRow, findRow, nowIso, writeRows, type RowWrite } from "../db/mutations";
import { settings } from "../db/schema";
import { LOGIN_KEY_PREFIX, type DeviceLogin } from "../domain/logins";
import type { LiveResult } from "./live-query";

const ACCOUNT_FROZEN = "account_frozen";
/** Explicit consent to keep health data (KVKK m. 6), apart from the notice's acceptance at sign-up. */
export const HEALTH_CONSENT = "health_consent";
/** Raised when the consent's text changes what it covers, so it is asked again. */
const HEALTH_CONSENT_VERSION = 1;

interface Setting {
  key: string;
  /** JSON, as written. */
  value: string;
}

export function readSettings(): Promise<Setting[]> {
  return getDb().select({ key: settings.key, value: settings.value }).from(settings).where(isNull(settings.deletedAt));
}

export const isFrozen = (all: readonly Setting[]) => all.some(({ key, value }) => key === ACCOUNT_FROZEN && value === "true");

/**
 * What the lock reads from the live settings: `null` until the device knows,
 * so a frozen account's data never shows for a frame. A read that failed opens
 * the app, whose screens then say what failed, rather than a blank for ever.
 */
export function frozenFrom({ data, status, updatedAt }: Pick<LiveResult<Setting>, "data" | "status" | "updatedAt">): boolean | null {
  if (updatedAt) return isFrozen(data);
  return status === "error" ? false : null;
}

async function settingWrite(key: string, json: unknown): Promise<RowWrite[]> {
  const id = await deterministicId(naturalKeys.setting(key));
  const value = JSON.stringify(json);
  const there = await findRow("settings", id);
  return there ? editRow("settings", there, { value, deletedAt: null }) : [{ table: "settings", row: { id, key, value, deletedAt: null } }];
}

export const writeSetting = (key: string, json: unknown) => writeRows(() => settingWrite(key, json));

export const setAccountFrozen = (frozen: boolean) => writeSetting(ACCOUNT_FROZEN, frozen);

/** Missing, unreadable or of another version, there is no consent. */
export function hasHealthConsent(all: readonly Setting[]): boolean {
  try {
    return (JSON.parse(String(all.find(({ key }) => key === HEALTH_CONSENT)?.value)) as { version?: unknown }).version === HEALTH_CONSENT_VERSION;
  } catch {
    return false;
  }
}

/** Kept with its version and moment: the controller is the one who must show it was given. */
export const giveHealthConsent = () => writeSetting(HEALTH_CONSENT, { version: HEALTH_CONSENT_VERSION, at: nowIso() });

/**
 * Who the account is among the cabinet's people, and whose and where a new
 * box is unless chosen otherwise (`docs/TASKS.md` F1.28): ids, so a renamed
 * person stays chosen, and one deleted is no choice.
 */
const PROFILE = { me: "profile_person", owner: "default_person", place: "default_location" } as const;
export type ProfileChoice = keyof typeof PROFILE;

/** The id chosen among `named`, or null: none chosen, one deleted since, or a value this build cannot read. */
export function profileChoice(all: readonly Setting[], choice: ProfileChoice, named: readonly { id: string }[]): string | null {
  try {
    const id: unknown = JSON.parse(String(Object.fromEntries(all.map(({ key, value }) => [key, value]))[PROFILE[choice]]));
    return named.some((each) => each.id === id) ? (id as string) : null;
  } catch {
    return null;
  }
}

export const chooseProfile = (choice: ProfileChoice, id: string | null) => writeSetting(PROFILE[choice], id);

export const recordDeviceLogin = (device: string, login: DeviceLogin) => writeSetting(LOGIN_KEY_PREFIX + device, login);
