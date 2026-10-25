/**
 * Which doses a plan asks for, what became of each, and when the phone says
 * one (`src/domain/doses.ts`). 2026-10-19 is a Monday; every day and time is
 * the device's local one.
 */

import { describe, expect, it } from "vitest";

import { dosesOfDay, dosesToSay, EVERY_DAY, isTime, momentOf, plannedOn, runsOn, shiftDay, timesOf, weekdayOf, type DoseAnswer, type PlanFacts } from "../../src/domain/doses";

const PLAN: PlanFacts = { id: "p1", times: '["20:00","08:00"]', weekdays: EVERY_DAY, startsOn: "2026-10-19", endsOn: null, paused: false };
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const answer = (dueOn: string, dueTime: string, status: DoseAnswer["status"], snoozedUntil: string | null = null): DoseAnswer => ({ planId: "p1", dueOn, dueTime, status, snoozedUntil });

describe("a plan's times and days", () => {
  it("reads its times defensively: times of day only, once each, earliest first", () => {
    expect(timesOf('["20:00","08:00","08:00"]')).toEqual(["08:00", "20:00"]);
    expect(timesOf('["24:00","7:30","08:60",8,null,"23:59","00:00"]')).toEqual(["00:00", "23:59"]);
    expect(timesOf("{")).toEqual([]);
    expect(timesOf('{"08:00":1}')).toEqual([]);
    expect([isTime("19:05"), isTime("19:5"), isTime(" 19:05"), isTime("19:05 ")]).toEqual([true, false, false, false]);
  });

  it("knows each weekday's bit and walks days across a month", () => {
    expect(["2026-10-19", "2026-10-20", "2026-10-24", "2026-10-25"].map(weekdayOf)).toEqual([1, 2, 32, 64]);
    expect([shiftDay("2026-10-31", 1), shiftDay("2026-03-01", -1), shiftDay("2026-10-19", 0)]).toEqual(["2026-11-01", "2026-02-28", "2026-10-19"]);
    expect(momentOf({ dueOn: "2026-10-19", dueTime: "08:30" })).toEqual(at(19, 8, 30));
  });

  it("asks on its weekdays from its first day to its last, both included, and never while paused", () => {
    const weekend = { ...PLAN, weekdays: 32 | 64, endsOn: "2026-10-25" };
    expect(["2026-10-18", "2026-10-19", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-31"].map((day) => plannedOn(weekend, day))).toEqual([false, false, false, true, true, false]);
    expect(plannedOn({ ...PLAN, startsOn: "2026-10-24" }, "2026-10-24")).toBe(true);
    expect(plannedOn({ ...PLAN, paused: true }, "2026-10-20")).toBe(false);
  });

  it("runs from its first day to its last whatever the weekday, and not while paused: the emergency card's current medicines", () => {
    const weekend = { ...PLAN, weekdays: 32 | 64, endsOn: "2026-10-25" };
    expect(["2026-10-18", "2026-10-19", "2026-10-21", "2026-10-25", "2026-10-26"].map((day) => runsOn(weekend, day))).toEqual([false, true, true, true, false]);
    expect(runsOn({ ...PLAN, paused: true }, "2026-10-20")).toBe(false);
  });
});

describe("a day's doses", () => {
  it("lists each by time with its state: answered, due, still to come, or left unanswered", () => {
    const now = at(20, 12);
    expect(dosesOfDay([PLAN], [answer("2026-10-20", "08:00", "taken")], "2026-10-20", now).map((dose) => [dose.dueTime, dose.state])).toEqual([
      ["08:00", "taken"],
      ["20:00", "upcoming"],
    ]);
    expect(dosesOfDay([PLAN], [], "2026-10-20", now).map((dose) => dose.state), "today's passed one is due").toEqual(["due", "upcoming"]);
    expect(dosesOfDay([PLAN], [], "2026-10-19", now).map((dose) => dose.state), "yesterday's is unanswered").toEqual(["unanswered", "unanswered"]);
    expect(dosesOfDay([PLAN], [], "2026-10-21", now).map((dose) => dose.state)).toEqual(["upcoming", "upcoming"]);
    expect(dosesOfDay([PLAN], [], "2026-10-18", now), "before it began").toEqual([]);
  });

  it("keeps an answer whatever the plan says now, and a plan's answers apart from another's", () => {
    const paused = { ...PLAN, paused: true };
    const other = { ...PLAN, id: "p2", times: '["08:00"]' };
    const days = dosesOfDay([paused, other], [answer("2026-10-20", "09:15", "skipped"), answer("2026-10-21", "08:00", "taken")], "2026-10-20", at(22, 9));
    expect(days).toEqual([
      { planId: "p2", dueOn: "2026-10-20", dueTime: "08:00", state: "unanswered", answer: null },
      { planId: "p1", dueOn: "2026-10-20", dueTime: "09:15", state: "skipped", answer: answer("2026-10-20", "09:15", "skipped") },
    ]);
  });

  it("orders two plans' doses at one time by plan", () => {
    const other = { ...PLAN, id: "p0" };
    expect(dosesOfDay([PLAN, other], [], "2026-10-21", at(20, 0)).map((dose) => `${dose.dueTime} ${dose.planId}`)).toEqual(["08:00 p0", "08:00 p1", "20:00 p0", "20:00 p1"]);
  });
});

describe("what the phone says", () => {
  it("says each dose still unanswered at its time, from now on, over the days asked", () => {
    const said = dosesToSay([PLAN], [answer("2026-10-20", "20:00", "taken")], at(20, 12), 1);
    expect(said).toEqual([
      { planId: "p1", at: at(21, 8) },
      { planId: "p1", at: at(21, 20) },
    ]);
  });

  it("says a dose put off when it was put off until, past midnight too, and never one already said", () => {
    const until = at(21, 0, 15).toISOString();
    const said = dosesToSay([{ ...PLAN, times: '["23:45"]' }], [answer("2026-10-20", "23:45", "snoozed", until)], at(21, 0, 5), 0);
    expect(said).toEqual([
      { planId: "p1", at: at(21, 0, 15) },
      { planId: "p1", at: at(21, 23, 45) },
    ]);
    expect(dosesToSay([{ ...PLAN, times: '["23:45"]' }], [answer("2026-10-20", "23:45", "snoozed", until)], at(21, 0, 20), 0)).toEqual([{ planId: "p1", at: at(21, 23, 45) }]);
  });

  it("says nothing of a plan not given or paused, nor of one answered other than put off", () => {
    const putOff = [answer("2026-10-21", "08:00", "snoozed", at(21, 8, 30).toISOString())];
    expect(dosesToSay([], putOff, at(21, 8, 10), 0)).toEqual([]);
    expect(dosesToSay([{ ...PLAN, times: '["08:00"]', paused: true }], putOff, at(21, 8, 10), 0)).toEqual([]);
    expect(dosesToSay([{ ...PLAN, times: '["08:00"]' }], [answer("2026-10-21", "08:00", "missed")], at(21, 7), 0)).toEqual([]);
  });
});
