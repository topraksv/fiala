/**
 * What the phone is told to say, and when (`docs/TASKS.md` F1.24): a box's
 * expiry ahead and passed, an opened box's end, a box running low or out, a
 * box with no expiry, and the monthly cabinet check. Planned afresh each time
 * the app leaves the screen, so only what is ahead within the horizon counts.
 */

import { describe, expect, it } from "vitest";
import { REMINDER_GROUPS, REMINDER_HOUR, REMINDERS_MAX, pastReminders, planReminders, readTarget, routeOf, targetPayload, type ReminderBox, type ReminderInput } from "../../src/domain/reminders";

// Wednesday 2026-09-23, 20:00 local.
const now = new Date(2026, 8, 23, 20, 0);
const at = (day: number, month = 8) => new Date(2026, month, day, REMINDER_HOUR);
/** A uuidv7 minted at `minted`. */
const idAt = (minted: Date) => `${minted.getTime().toString(16).padStart(12, "0").replace(/^(.{8})/, "$1-")}-7000-8000-000000000000`;
const ADDED = idAt(new Date(2026, 8, 1, 12));
const box = (fields: Partial<ReminderBox> = {}): ReminderBox => ({
  id: ADDED,
  name: "Parol",
  movedAt: null,
  expiresOn: "2027-06-01",
  soonDays: null,
  openedOn: null,
  useWithinDays: null,
  lowMilli: null,
  remainingMilli: 0,
  counted: false,
  disposition: null,
  ...fields,
});
/** Said at nine, nothing silenced, unless a test says otherwise. */
const input = (fields: Partial<ReminderInput>): ReminderInput => ({ now, boxes: [], names: true, hour: REMINDER_HOUR, muted: [], ...fields });
const plan = (boxes: ReminderBox[], names = true, from = now) => planReminders(input({ now: from, boxes, names })).filter((reminder) => reminder.kind !== "check");
const onBox = (id = ADDED) => ({ kind: "box", id });

describe("an expiry", () => {
  it("warns as many days ahead as the box or its owner asks, else thirty, and says when it has passed", () => {
    expect(plan([box({ expiresOn: "2026-10-05", soonDays: 10 })])).toEqual([
      { kind: "expirySoon", at: at(25), name: "Parol", target: onBox() },
      { kind: "expired", at: at(6, 9), name: "Parol", target: onBox() },
    ]);
    expect(plan([box({ expiresOn: "2026-10-20" })]), "its warning has gone by").toEqual([{ kind: "expired", at: at(21, 9), name: "Parol", target: onBox() }]);
    expect(plan([box({ expiresOn: "2026-12-01" })]), "past the horizon").toEqual([]);
  });

  it("is not said for a box gone or empty", () => {
    expect(plan([box({ expiresOn: "2026-10-05", disposition: "disposed" })])).toEqual([]);
    expect(plan([box({ expiresOn: "2026-10-05", counted: true, remainingMilli: 0 })])).toEqual([]);
  });

  it("missing is said the morning after the box was added, once", () => {
    const today = idAt(new Date(2026, 8, 23, 10));
    expect(plan([box({ id: today, expiresOn: null }), box({ expiresOn: null })])).toEqual([{ kind: "undated", at: at(24), name: "Parol", target: onBox(today) }]);
  });
});

describe("an opened box", () => {
  it("warns a week before its last day and says the morning after", () => {
    expect(plan([box({ openedOn: "2026-09-20", useWithinDays: 14 })])).toEqual([
      { kind: "openSoon", at: at(26), name: "Parol", target: onBox() },
      { kind: "openEnded", at: at(4, 9), name: "Parol", target: onBox() },
    ]);
  });
});

describe("the amount", () => {
  const moved = new Date(2026, 8, 23, 18).toISOString();

  it("running low or out is said the morning after the move that did it", () => {
    expect(plan([box({ counted: true, remainingMilli: 1000, lowMilli: 2000, movedAt: moved })])).toEqual([{ kind: "low", at: at(24), name: "Parol", target: onBox() }]);
    expect(plan([box({ counted: true, remainingMilli: 0, lowMilli: 2000, movedAt: moved })])).toEqual([{ kind: "empty", at: at(24), name: "Parol", target: onBox() }]);
  });

  it("is said by no move but the last, and not above the box's limit", () => {
    expect(plan([box({ counted: true, remainingMilli: 1000, lowMilli: 2000, movedAt: new Date(2026, 8, 20).toISOString() })])).toEqual([]);
    expect(plan([box({ counted: true, remainingMilli: 3000, lowMilli: 2000, movedAt: moved })])).toEqual([]);
  });
});

describe("the plan", () => {
  it("leaves out this very moment and keeps the horizon's edge", () => {
    const morning = at(23);
    const boxes = [box({ id: idAt(new Date(2026, 8, 22, 10)), expiresOn: null }), box({ expiresOn: "2026-10-22" })];
    expect(plan(boxes, true, morning)).toEqual([{ kind: "expired", at: at(23, 9), name: "Parol", target: onBox() }]);
  });

  it("checks a cabinet with something at home on the first of each month ahead, across a year's end", () => {
    const held = [box({ expiresOn: "2030-01-01" })];
    expect(planReminders(input({ boxes: held }))).toEqual([{ kind: "check", at: at(1, 9), name: null, target: { kind: "cabinet" } }]);
    expect(planReminders(input({ now: new Date(2026, 11, 15), boxes: held })).map((reminder) => reminder.at)).toEqual([new Date(2027, 0, 1, REMINDER_HOUR)]);
    expect(planReminders(input({ now: new Date(2027, 0, 31), boxes: held })).map((reminder) => reminder.at), "a short month: two firsts ahead").toEqual([new Date(2027, 1, 1, REMINDER_HOUR), new Date(2027, 2, 1, REMINDER_HOUR)]);
    expect(planReminders(input({})), "an empty cabinet").toEqual([]);
    expect(planReminders(input({ boxes: [box({ disposition: "used" })] })), "nothing at home").toEqual([]);
  });

  it("says the same words once a morning: two boxes of one name are one notification", () => {
    const other = idAt(new Date(2026, 8, 2));
    expect(plan([box({ expiresOn: "2026-10-05" }), box({ id: other, expiresOn: "2026-10-05" }), box({ id: other, name: "Majezik", expiresOn: "2026-10-05" })])).toEqual([
      { kind: "expired", at: at(6, 9), name: "Parol", target: onBox() },
      { kind: "expired", at: at(6, 9), name: "Majezik", target: onBox(other) },
    ]);
  });

  it("names nothing when names are off, and says each kind once a morning, opening the cabinet", () => {
    const other = idAt(new Date(2026, 8, 2));
    expect(plan([box({ expiresOn: "2026-10-05", soonDays: 10 }), box({ id: other, name: "Majezik", expiresOn: "2026-10-05", soonDays: 10 })], false)).toEqual([
      { kind: "expirySoon", at: at(25), name: null, target: { kind: "cabinet" } },
      { kind: "expired", at: at(6, 9), name: null, target: { kind: "cabinet" } },
    ]);
  });

  it("is soonest first, and no longer than iOS keeps", () => {
    const boxes = Array.from({ length: REMINDERS_MAX + 5 }, (_, day) => box({ id: idAt(new Date(2026, 8, 1, 0, day)), name: `İlaç ${day}`, expiresOn: `2026-10-${String((day % 20) + 1).padStart(2, "0")}`, soonDays: 1 }));
    const planned = planReminders(input({ boxes }));
    expect(planned).toHaveLength(REMINDERS_MAX);
    expect(planned.map((reminder) => reminder.at.getTime())).toEqual([...planned.map((reminder) => reminder.at.getTime())].sort((a, b) => a - b));
  });
});

describe("the person's choices", () => {
  it("say everything at the hour chosen, the monthly check too, and the centre lists them at it", () => {
    const boxes = [box({ expiresOn: "2026-10-05", soonDays: 10 })];
    expect(planReminders(input({ boxes, hour: 18 })).map((reminder) => [reminder.kind, reminder.at])).toEqual([
      ["expirySoon", new Date(2026, 8, 25, 18)],
      ["check", new Date(2026, 9, 1, 18)],
      ["expired", new Date(2026, 9, 6, 18)],
    ]);
    expect(pastReminders(input({ now: new Date(2026, 9, 1, 12), boxes, hour: 18 })).map((notice) => notice.kind), "not yet said today").toEqual(["expirySoon", "check"]);
  });

  it("leave out what was silenced, a warning together with its passing, ahead and behind", () => {
    const boxes = [
      box({ expiresOn: "2026-10-05", soonDays: 10 }),
      box({ id: idAt(new Date(2026, 8, 2)), name: "Majezik", expiresOn: null, openedOn: "2026-09-20", useWithinDays: 14, counted: true, remainingMilli: 1000, lowMilli: 2000, movedAt: new Date(2026, 8, 23, 18).toISOString() }),
    ];
    const kinds = (muted: ReminderInput["muted"]) => planReminders(input({ boxes, muted })).map((reminder) => reminder.kind);
    expect(kinds([])).toEqual(["low", "expirySoon", "openSoon", "check", "openEnded", "expired"]);
    expect(kinds(["expiry"])).toEqual(["low", "openSoon", "check", "openEnded"]);
    expect(kinds(["opened", "stock", "check"])).toEqual(["expirySoon", "expired"]);
    expect(kinds(Object.keys(REMINDER_GROUPS) as ReminderInput["muted"])).toEqual([]);
    expect(pastReminders(input({ now: new Date(2026, 9, 7), boxes, muted: ["check"] })).map((notice) => notice.kind)).toEqual(["expired", "openEnded", "openSoon", "expirySoon", "low"]);
  });

  it("silence the undated warning on its own", () => {
    const today = idAt(new Date(2026, 8, 23, 10));
    expect(plan([box({ id: today, expiresOn: null })]).map((reminder) => reminder.kind)).toEqual(["undated"]);
    expect(planReminders(input({ boxes: [box({ id: today, expiresOn: null })], muted: ["undated", "check"] }))).toEqual([]);
  });
});

describe("the notification centre", () => {
  it("lists what was said over the last thirty days, newest first, named, this very moment among them", () => {
    const today = idAt(new Date(2026, 8, 23, 10));
    const boxes = [box({ expiresOn: "2026-09-10", soonDays: 10 }), box({ id: today, name: "Majezik", expiresOn: null }), box({ expiresOn: "2026-07-01", disposition: "used" })];
    expect(pastReminders(input({ boxes }))).toEqual([
      { kind: "expired", at: at(11), name: "Parol", target: onBox() },
      { kind: "check", at: at(1), name: null, target: { kind: "cabinet" } },
      { kind: "expirySoon", at: at(31, 7), name: "Parol", target: onBox() },
    ]);
    expect(pastReminders(input({ now: at(24), boxes })).map((notice) => notice.name), "said at nine, read at nine").toEqual(["Majezik", "Parol", null, "Parol"]);
    expect(pastReminders(input({ now: new Date(2026, 9, 1, 8), boxes: [box({ expiresOn: "2030-01-01" })] })).map((notice) => notice.at), "before nine on the first, last month's check").toEqual([at(1)]);
  });
});

describe("an ask to check a box", () => {
  it("is listed when it came, at its own minute, for a box at home, and never planned ahead", () => {
    const asked = new Date(2026, 8, 23, 18, 42).toISOString();
    const boxes = [box({ askedAt: asked }), box({ id: idAt(now), name: "Majezik", askedAt: asked, disposition: "used" })];
    expect(pastReminders(input({ boxes })).filter((notice) => notice.kind === "asked")).toEqual([{ kind: "asked", at: new Date(asked), name: "Parol", target: onBox() }]);
    expect(planReminders(input({ now: new Date(2026, 8, 23, 18), boxes })).some((reminder) => reminder.kind === "asked"), "ahead of it, nothing").toBe(false);
  });
});

describe("what happened in a household", () => {
  it("is listed with the rest over thirty days, silenced as one, and never planned", () => {
    const joined = { kind: "memberJoined" as const, at: at(20), name: "Ev", by: "Ali", count: 1, target: { kind: "household" as const, id: "ev" } };
    const old = { ...joined, kind: "boxAdded" as const, at: at(20, 7) };
    expect(pastReminders(input({ events: [joined, old] })), "a month ago is gone").toEqual([joined]);
    expect(pastReminders(input({ events: [joined], muted: ["household"] }))).toEqual([]);
    expect(planReminders(input({ now: at(19), events: [joined] }))).toEqual([]);
  });
});

describe("a dose", () => {
  it("is said at its own minute, not the hour, named or not, opening the day's doses, and never in the centre", () => {
    const doses = [{ at: new Date(2026, 8, 23, 20, 30), name: "Coraspin" }, { at: new Date(2026, 8, 23, 20, 30), name: "Coraspin" }, { at: new Date(2026, 8, 23, 19, 30), name: "Parol" }];
    expect(planReminders(input({ doses }))).toEqual([{ kind: "dose", at: new Date(2026, 8, 23, 20, 30), name: "Coraspin", target: { kind: "doses" } }]);
    expect(planReminders(input({ doses, names: false })).map((reminder) => reminder.name)).toEqual([null]);
    expect(planReminders(input({ doses, muted: ["dose"] }))).toEqual([]);
    expect(pastReminders(input({ doses }))).toEqual([]);
  });

  it("keeps half of what iOS holds for the boxes' warnings, and takes what they leave", () => {
    // Latest first, and among the warnings' days: the plan keeps the soonest of each and says them in time order.
    const doses = Array.from({ length: REMINDERS_MAX }, (_, at) => ({ at: new Date(2026, 9, 5, 0, REMINDERS_MAX - at), name: "Coraspin" }));
    const boxes = Array.from({ length: REMINDERS_MAX }, (_, day) => box({ id: idAt(new Date(2026, 8, 1, 0, day)), name: `İlaç ${day}`, expiresOn: `2026-10-${String((day % 20) + 1).padStart(2, "0")}`, soonDays: 1 }));
    const count = (planned: readonly { kind: string }[]) => planned.filter((reminder) => reminder.kind === "dose").length;
    const crowded = planReminders(input({ doses, boxes }));
    expect([crowded.length, count(crowded)]).toEqual([REMINDERS_MAX, REMINDERS_MAX / 2]);
    expect(crowded.filter((reminder) => reminder.kind === "dose").at(-1)!.at, "the soonest half of the doses").toEqual(new Date(2026, 9, 5, 0, REMINDERS_MAX / 2));
    expect(crowded.map((reminder) => reminder.at.getTime())).toEqual([...crowded.map((reminder) => reminder.at.getTime())].sort((a, b) => a - b));
    expect(count(planReminders(input({ doses, boxes: boxes.slice(0, 5) }))), "what the warnings leave").toBe(REMINDERS_MAX - planReminders(input({ boxes: boxes.slice(0, 5) })).length);
    expect(count(planReminders(input({ doses }))), "with no box, no monthly check either").toBe(REMINDERS_MAX);
  });
});

describe("a tap", () => {
  it("opens the box, the cabinet, the day's doses or the household the notice names", () => {
    expect(routeOf(readTarget(targetPayload({ kind: "box", id: "b" }))!)).toEqual({ pathname: "/box/[id]", params: { id: "b" } });
    expect(readTarget(targetPayload({ kind: "cabinet" }))).toEqual({ kind: "cabinet" });
    expect(routeOf({ kind: "cabinet" })).toEqual({ pathname: "/cabinet" });
    expect(routeOf(readTarget(targetPayload({ kind: "doses" }))!)).toEqual({ pathname: "/doses" });
    expect(routeOf({ kind: "household", id: "ev" })).toEqual({ pathname: "/household/[id]", params: { id: "ev" } });
    expect(readTarget(targetPayload({ kind: "household", id: "ev" })), "never a phone's").toBeNull();
  });

  it("opens nothing from a payload this build did not write", () => {
    for (const data of [null, "box", {}, { route: { pathname: "/cabinet" } }, targetPayload({ kind: "box", id: "" }), { fialaTarget: { kind: "box", id: 5 } }, { fialaTarget: { kind: "settings" } }]) {
      expect(readTarget(data), JSON.stringify(data)).toBeNull();
    }
  });
});
