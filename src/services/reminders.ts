/**
 * The web has no reminders: `expo-notifications` schedules on Android and iOS
 * only. `reminders.native.ts` is the phone's; this file is what the web
 * bundles in its place, so the package never reaches the web entry. Gital's.
 */

import type { ReminderRoute } from "../domain/reminders";

export const remindersAvailable = false;

export async function enableReminders(): Promise<boolean> {
  return false;
}

export async function disableReminders(): Promise<void> {}

export async function replanReminders(): Promise<void> {}

export async function cancelReminders(): Promise<void> {}

export function followReminderTaps(_open: (route: ReminderRoute) => void): () => void {
  return () => {};
}
