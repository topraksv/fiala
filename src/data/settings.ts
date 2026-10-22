/**
 * What follows the person to every device (`docs/ARCHITECTURE.md`, "Tables"),
 * a key and its JSON value: whether the account is frozen, which is why a
 * frozen account locks every device, and each device's last sign-in.
 */

import { isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { editRow, findRow, writeRows, type RowWrite } from "../db/mutations";
import { settings } from "../db/schema";
import { LOGIN_KEY_PREFIX, type DeviceLogin } from "../domain/logins";
import type { LiveResult } from "./live-query";

const ACCOUNT_FROZEN = "account_frozen";

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

export const recordDeviceLogin = (device: string, login: DeviceLogin) => writeSetting(LOGIN_KEY_PREFIX + device, login);
