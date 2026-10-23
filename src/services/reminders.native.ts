/**
 * Local notifications on the phone (`docs/TASKS.md` F1.24), Gital's service:
 * permission is asked only from Ayarlar, and every plan cancels and replaces
 * the last, so what is scheduled is always `planReminders` of the present.
 * Local notifications run in Expo Go; only remote push left it.
 */

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

import { readCabinet } from "../data/cabinet";
import { planReminders, readTarget, routeOf, targetPayload, type Reminder, type ReminderRoute } from "../domain/reminders";
import { tr } from "../i18n/tr";
import { readReminderPreferences, saveRemindersOn } from "./reminder-preferences";

export const remindersAvailable = true;

const CHANNEL = "fiala-reminders";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

function granted(status: Notifications.NotificationPermissionsStatus): boolean {
  if (Platform.OS !== "ios") return status.granted;
  const ios = status.ios?.status;
  return (
    ios === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    ios === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    ios === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL, { name: tr.reminders.title, importance: Notifications.AndroidImportance.DEFAULT });
}

/** Asked only from Ayarlar's switch; `false` when the phone refused. */
export async function enableReminders(): Promise<boolean> {
  await ensureChannel();
  const current = await Notifications.getPermissionsAsync();
  if (!granted(granted(current) ? current : await Notifications.requestPermissionsAsync())) {
    await disableReminders();
    return false;
  }
  await saveRemindersOn(true);
  await replanReminders();
  return true;
}

export async function disableReminders(): Promise<void> {
  try {
    await saveRemindersOn(false);
  } finally {
    await Notifications.cancelAllScheduledNotificationsAsync();
  }
}

async function planned(): Promise<Reminder[]> {
  const { names, hour, muted } = await readReminderPreferences();
  const cabinet = await readCabinet();
  const boxes = cabinet.flatMap((product) => product.boxes.map((box) => ({ ...box, name: tr.common.boxName(product, box) })));
  return planReminders({ now: new Date(), boxes, names, hour, muted });
}

// Planning at start and at every trip to the background can overlap; each waits for the last.
let queue: Promise<void> = Promise.resolve();

/** Cancel and schedule again from what is on the device now; nothing while off or refused. */
export function replanReminders(): Promise<void> {
  queue = queue.catch(() => {}).then(replace);
  return queue;
}

/**
 * Nothing left to ring, the switch left as it was: a sign-out takes the boxes
 * the reminders name, and the next account's first plan starts afresh.
 */
export function cancelReminders(): Promise<void> {
  queue = queue.catch(() => {}).then(() => Notifications.cancelAllScheduledNotificationsAsync());
  return queue;
}

async function replace(): Promise<void> {
  if (!(await readReminderPreferences()).on || !granted(await Notifications.getPermissionsAsync())) {
    await Notifications.cancelAllScheduledNotificationsAsync();
    return;
  }
  await ensureChannel();
  // Planned before anything is cancelled: a failed read keeps yesterday's reminders.
  const next = await planned();
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const reminder of next) {
    await Notifications.scheduleNotificationAsync({
      content: { title: tr.reminders.kinds[reminder.kind], body: tr.reminders.body(reminder.kind, reminder.name), data: targetPayload(reminder.target) },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminder.at, ...(Platform.OS === "android" ? { channelId: CHANNEL } : {}) },
    });
  }
}

/**
 * A tap on a reminder opens what it is about: the launch response is the tap that started a
 * cold app, the listener the taps that come while it runs. A handled launch
 * response is cleared, or it is replayed on every later read, after a sign-in
 * to another account too. Returns the unsubscribe.
 */
export function followReminderTaps(open: (route: ReminderRoute) => void): () => void {
  const handled = new Set<string>();
  const take = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const key = response.notification.request.identifier;
    const target = readTarget(response.notification.request.content.data);
    if (!target || handled.has(key)) return;
    handled.add(key);
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // Nothing to clear is no reason to stay where the tap did not mean.
    }
    open(routeOf(target));
  };
  try {
    take(Notifications.getLastNotificationResponse());
  } catch {
    // An OS that keeps no launch response still delivers the next tap.
  }
  const subscription = Notifications.addNotificationResponseReceivedListener(take);
  return () => subscription.remove();
}
