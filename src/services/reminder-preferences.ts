/**
 * Whether reminders are on, whether they may name a medicine
 * (`docs/TASKS.md` F1.24), their hour and what is silenced (F1.29), and when
 * the notification centre was last read
 * (F1.25), kept on this device: a reminder is this phone's,
 * and a name on a lock screen is health data in sight of whoever holds it, so
 * naming is an opt-in, as Helix's notification details are. Neither is in the
 * synced `settings` table for that reason.
 */

import { REMINDER_GROUPS, REMINDER_HOUR, type ReminderGroup } from "../domain/reminders";
import { kv } from "./kv";

const KEYS = {
  on: "fiala.reminders.on",
  names: "fiala.reminders.names",
  hour: "fiala.reminders.hour",
  muted: "fiala.reminders.muted",
  seen: "fiala.notices.seenAt",
} as const;

/**
 * Back to `REMINDER_DEFAULTS` when the device passes to another account: the
 * names opt-in was the last account's, and the next one has not given it.
 */
export async function forgetReminderPreferences(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => kv.remove(key)));
}

/** The hours offered: early, the default morning, midday, evening and night. */
export const REMINDER_HOURS = [7, REMINDER_HOUR, 12, 18, 21] as const;

export interface ReminderPreferences {
  on: boolean;
  names: boolean;
  hour: number;
  muted: ReminderGroup[];
}

/** Off, unnamed, in the morning, nothing silenced: what a phone starts with. */
export const REMINDER_DEFAULTS: ReminderPreferences = { on: false, names: false, hour: REMINDER_HOUR, muted: [] };

/** Read defensively: an hour not offered is the default, and an unknown or repeated group is dropped. */
export async function readReminderPreferences(): Promise<ReminderPreferences> {
  const [on, names, hour, muted] = await Promise.all([kv.get(KEYS.on), kv.get(KEYS.names), kv.get(KEYS.hour), kv.get(KEYS.muted)]);
  return {
    on: on === "true",
    names: names === "true",
    hour: REMINDER_HOURS.find((offered) => String(offered) === hour) ?? REMINDER_HOUR,
    muted: (Object.keys(REMINDER_GROUPS) as ReminderGroup[]).filter((group) => muted?.split(",").includes(group)),
  };
}

export function saveRemindersOn(on: boolean): Promise<void> {
  return kv.set(KEYS.on, String(on));
}

export function saveReminderNames(names: boolean): Promise<void> {
  return kv.set(KEYS.names, String(names));
}

export function saveReminderHour(hour: number): Promise<void> {
  return kv.set(KEYS.hour, String(hour));
}

export function saveReminderMuted(muted: readonly ReminderGroup[]): Promise<void> {
  return kv.set(KEYS.muted, muted.join(","));
}

/** Everything said up to this moment has been read; null when the centre was never opened. */
export async function readNoticesSeenAt(): Promise<Date | null> {
  const stored = Number(await kv.get(KEYS.seen));
  return stored > 0 ? new Date(stored) : null;
}

export function saveNoticesSeenAt(at: Date): Promise<void> {
  return kv.set(KEYS.seen, String(at.getTime()));
}
