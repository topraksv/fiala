/**
 * The phone's reminder service (`docs/TASKS.md` F1.24) over a stubbed
 * `expo-notifications`: it asks permission only when switched on, schedules
 * only while on and allowed, names a medicine only when asked to, and
 * replaces the whole plan, never erasing yesterday's reminders on a failed
 * read. Gital's suite, on Fiala's boxes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const payloads = vi.hoisted(() => [] as unknown[]);
const moments = vi.hoisted(() => [] as Date[]);
const taps = vi.hoisted(() => ({ last: null as unknown, cleared: 0, listener: null as ((response: unknown) => void) | null, removed: 0 }));
const phone = vi.hoisted(() => ({ handler: null as { handleNotification: () => Promise<unknown> } | null, os: "android", granted: true, ios: 0 as number | null, stored: new Map<string, string>(), readFails: false, boxes: [] as Record<string, unknown>[] }));

vi.mock("react-native", () => ({ Platform: { get OS() { return phone.os; } } }));
vi.mock("expo-notifications", () => ({
  SchedulableTriggerInputTypes: { DATE: "date" },
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
  setNotificationHandler: (handler: typeof phone.handler) => void (phone.handler = handler),
  setNotificationChannelAsync: async (id: string, channel: { name: string; importance: number }) => void calls.push(`channel ${id}`, `${channel.name} ${channel.importance}`),
  getPermissionsAsync: async () => ({ granted: phone.granted, ios: phone.ios == null ? undefined : { status: phone.ios } }),
  requestPermissionsAsync: async () => {
    calls.push("ask");
    return { granted: phone.granted, ios: phone.ios == null ? undefined : { status: phone.ios } };
  },
  cancelAllScheduledNotificationsAsync: async () => void calls.push("cancel"),
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  getLastNotificationResponse: () => taps.last,
  clearLastNotificationResponse: () => {
    taps.cleared++;
    taps.last = null;
  },
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    taps.listener = listener;
    return { remove: () => void taps.removed++ };
  },
  scheduleNotificationAsync: async (request: { content: { title: string; body: string; data: unknown }; trigger: { type: string; date: Date; channelId?: string } }) => {
    moments.push(request.trigger.date);
    calls.push(`${request.trigger.type}${request.trigger.channelId ? ` ${request.trigger.channelId}` : ""}: ${request.content.title} — ${request.content.body}`);
    payloads.push(request.content.data);
  },
}));
vi.mock("../../src/services/kv", () => ({
  kv: { get: async (key: string) => phone.stored.get(key) ?? null, set: async (key: string, value: string) => void phone.stored.set(key, value) },
}));
vi.mock("../../src/data/cabinet", () => ({
  readCabinet: async () => {
    if (phone.readFails) throw new Error("SQLITE_BUSY");
    return [{ name: "Parol", strength: "500 mg", boxes: phone.boxes }];
  },
}));

const { cancelReminders, disableReminders, enableReminders, followReminderTaps, remindersAvailable, replanReminders } = await import("../../src/services/reminders.native");
const { REMINDER_DEFAULTS, readNoticesSeenAt, readReminderPreferences, saveNoticesSeenAt, saveReminderHour, saveReminderMuted, saveReminderNames } = await import("../../src/services/reminder-preferences");
const { localDay } = await import("../../src/domain/boxes");

const inDays = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return localDay(day);
};
const box = (fields: Record<string, unknown> = {}) => ({
  id: "0199d000-0000-7000-8000-000000000000",
  nickname: null,
  expiresOn: inDays(3),
  soonDays: null,
  openedOn: null,
  useWithinDays: null,
  lowMilli: null,
  remainingMilli: 0,
  counted: false,
  disposition: null,
  movedAt: null,
  ...fields,
});
const EXPIRED = "date fiala-reminders: Son kullanma tarihi doldu — ";
const CHANNEL = ["channel fiala-reminders", "Hatırlatmalar 3"];

beforeEach(() => {
  calls.length = 0;
  payloads.length = 0;
  moments.length = 0;
  Object.assign(phone, { os: "android", granted: true, ios: 0, readFails: false, boxes: [box()] });
  phone.stored.clear();
});

describe("reminders on the phone", () => {
  it("schedule nothing, and clear what was, while switched off", async () => {
    await replanReminders();
    expect(calls).toEqual(["cancel"]);
  });

  it("ask once switched on, then schedule the plan without a medicine's name", async () => {
    phone.granted = false;
    expect(await enableReminders()).toBe(false);
    expect(calls).toEqual([...CHANNEL, "ask", "cancel"]);
    expect(phone.stored.get("fiala.reminders.on")).toBe("false");
    calls.length = 0;
    phone.granted = true;
    expect(await enableReminders()).toBe(true);
    expect(calls.slice(0, 6)).toEqual([...CHANNEL, ...CHANNEL, "cancel", `${EXPIRED}Bir kutunun son kullanma tarihi doldu; elden çıkarmayı düşün.`]);
    expect(payloads[0]).toEqual({ fialaTarget: { kind: "cabinet" } });
  });

  it("name the box, and open it, once names are allowed", async () => {
    await saveReminderNames(true);
    phone.boxes = [box(), box({ id: "0199d000-0001-7000-8000-000000000000", nickname: "Çocuğun şurubu" })];
    await enableReminders();
    expect(calls).toContain(`${EXPIRED}Parol · 500 mg kutusunun son kullanma tarihi doldu; elden çıkarmayı düşün.`);
    expect(calls).toContain(`${EXPIRED}Çocuğun şurubu kutusunun son kullanma tarihi doldu; elden çıkarmayı düşün.`);
    expect(payloads[0]).toEqual({ fialaTarget: { kind: "box", id: "0199d000-0000-7000-8000-000000000000" } });
  });

  it("keep yesterday's reminders when the plan cannot be read", async () => {
    await enableReminders();
    calls.length = 0;
    phone.readFails = true;
    await expect(replanReminders()).rejects.toThrow("SQLITE_BUSY");
    expect(calls).toEqual(CHANNEL);
    phone.readFails = false;
    await replanReminders();
    expect(calls.slice(2, 5)).toEqual([...CHANNEL, "cancel"]);
  });

  it("clear everything when switched off, or when the phone took the permission back", async () => {
    await enableReminders();
    calls.length = 0;
    await disableReminders();
    expect(calls).toEqual(["cancel"]);
    await replanReminders();
    expect(calls).toEqual(["cancel", "cancel"]);

    await enableReminders();
    calls.length = 0;
    phone.granted = false;
    await replanReminders();
    expect(calls).toEqual(["cancel"]);
  });

  it("clear everything at a sign-out, and keep the switch for the next account", async () => {
    await enableReminders();
    calls.length = 0;
    await cancelReminders();
    expect(calls).toEqual(["cancel"]);
    calls.length = 0;
    await replanReminders();
    expect(calls[2]).toBe("cancel");
    expect(calls.length).toBeGreaterThan(3);
  });

  it("on iOS, take an allowed, provisional or brief permission, give no Android channel, and stop at a refusal", async () => {
    phone.os = "ios";
    phone.granted = false;
    for (const status of [2, 3, 4]) {
      phone.ios = status;
      calls.length = 0;
      expect(await enableReminders(), String(status)).toBe(true);
      expect(calls.slice(0, 2)).toEqual(["cancel", "date: Son kullanma tarihi doldu — Bir kutunun son kullanma tarihi doldu; elden çıkarmayı düşün."]);
    }
    for (const status of [1, null]) {
      phone.ios = status;
      phone.granted = true;
      calls.length = 0;
      expect(await enableReminders(), String(status)).toBe(false);
      expect(calls).toEqual(["ask", "cancel"]);
    }
  });

  it("show a reminder that comes while the app is open, silently and without a badge", async () => {
    expect(remindersAvailable).toBe(true);
    expect(await phone.handler!.handleNotification()).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
  });
});

describe("what the person chose", () => {
  it("is off, unnamed, at nine and nothing silenced until chosen", async () => {
    expect(await readReminderPreferences()).toEqual({ on: false, names: false, hour: 9, muted: [] });
    expect(REMINDER_DEFAULTS).toEqual({ on: false, names: false, hour: 9, muted: [] });
  });

  it("keeps an hour offered and the groups known, each once, in their own order", async () => {
    await saveReminderHour(18);
    await saveReminderMuted(["check", "expiry"]);
    expect(await readReminderPreferences()).toMatchObject({ hour: 18, muted: ["expiry", "check"] });
    phone.stored.set("fiala.reminders.hour", "10");
    phone.stored.set("fiala.reminders.muted", "stock,weather,stock");
    expect(await readReminderPreferences(), "an hour not offered, a group this build does not know").toMatchObject({ hour: 9, muted: ["stock"] });
    await saveReminderMuted([]);
    expect((await readReminderPreferences()).muted).toEqual([]);
  });

  it("plans at the hour chosen and leaves out what was silenced", async () => {
    await saveReminderHour(21);
    await saveReminderMuted(["check"]);
    await enableReminders();
    expect(calls.filter((call) => call.startsWith("date"))).toEqual([`${EXPIRED}Bir kutunun son kullanma tarihi doldu; elden çıkarmayı düşün.`]);
    expect(moments.map((at) => [localDay(at), at.getHours()])).toEqual([[inDays(4), 21]]);
    await saveReminderMuted(["expiry", "check"]);
    calls.length = 0;
    await replanReminders();
    expect(calls.filter((call) => call.startsWith("date"))).toEqual([]);
  });
});

describe("the notification centre's read mark", () => {
  it("is none until the centre is first opened, then the moment it was", async () => {
    expect(await readNoticesSeenAt()).toBeNull();
    phone.stored.set("fiala.notices.seenAt", "not a time");
    expect(await readNoticesSeenAt()).toBeNull();
    await saveNoticesSeenAt(new Date(2026, 8, 23, 20));
    expect(await readNoticesSeenAt()).toEqual(new Date(2026, 8, 23, 20));
  });
});

describe("a tap on a reminder", () => {
  const tap = (identifier: string, target: unknown, actionIdentifier = "expo.modules.notifications.actions.DEFAULT") => ({
    actionIdentifier,
    notification: { request: { identifier, content: { data: { fialaTarget: target } } } },
  });

  it("opens what the reminder is about, the launch tap once, and stops listening when asked", () => {
    taps.last = tap("launch", { kind: "cabinet" });
    taps.cleared = 0;
    taps.removed = 0;
    const opened: unknown[] = [];
    const stop = followReminderTaps((route) => opened.push(route));
    expect(opened).toEqual([{ pathname: "/cabinet" }]);
    expect(taps.cleared, "a handled launch tap is not replayed").toBe(1);

    taps.listener!(tap("launch", { kind: "cabinet" }));
    taps.listener!(tap("later", { kind: "box", id: "b" }));
    taps.listener!(tap("dismissed", { kind: "cabinet" }, "expo.modules.notifications.actions.DISMISS"));
    taps.listener!(tap("unknown", { kind: "settings" }));
    taps.listener!(null);
    expect(opened).toEqual([{ pathname: "/cabinet" }, { pathname: "/box/[id]", params: { id: "b" } }]);

    stop();
    expect(taps.removed).toBe(1);
  });

  it("listens even with no launch tap to read", () => {
    taps.last = null;
    const opened: unknown[] = [];
    followReminderTaps((route) => opened.push(route));
    taps.listener!(tap("first", { kind: "cabinet" }));
    expect(opened).toEqual([{ pathname: "/cabinet" }]);
  });
});

// `expo-notifications` schedules on phones only; Ayarlar hides the switch on this answer.
describe("on the web", () => {
  it("has no reminders: switching on is refused and nothing is scheduled", async () => {
    const web = await import("../../src/services/reminders");
    expect(web.remindersAvailable).toBe(false);
    await expect(web.enableReminders()).resolves.toBe(false);
    await expect(web.disableReminders()).resolves.toBeUndefined();
    await expect(web.replanReminders()).resolves.toBeUndefined();
    await expect(web.cancelReminders()).resolves.toBeUndefined();
    const open = vi.fn();
    const stop = web.followReminderTaps(open);
    expect(stop).toBeTypeOf("function");
    stop();
    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
