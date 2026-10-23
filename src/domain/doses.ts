/**
 * Doses (`docs/TASKS.md` F3.7–F3.10): which doses a plan asks for on a day,
 * what became of each, and when the phone is to say one. A plan's days and
 * times are the person's local ones, as a box's days are, so a dose at 08:00
 * is at 08:00 wherever the phone is.
 */

import type { DoseStatus } from "../db/schema";
import { localDay } from "./boxes";

/** All seven weekdays, Monday's bit first. */
export const EVERY_DAY = 127;
/** A plan says a dose this many times a day at most. */
export const TIMES_MAX = 8;
/** What "Ertele" puts a dose off by. */
export const SNOOZE_MINUTES = 30;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isTime = (text: string) => TIME.test(text);

export interface PlanFacts {
  id: string;
  /** As stored: a JSON array of `HH:MM`. */
  times: string;
  weekdays: number;
  startsOn: string;
  endsOn: string | null;
  paused: boolean;
}

/** A plan's times, read defensively: what is not a time of day is left out, the rest once each, earliest first. */
export function timesOf(stored: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? [...new Set(parsed.filter((time): time is string => typeof time === "string" && isTime(time)))].sort() : [];
}

const dateOf = (day: string, time = "00:00") => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return new Date(year, month - 1, date, hour, minute);
};

/** The weekday's bit of a local day: Monday 1 … Sunday 64. */
export const weekdayOf = (day: string) => 1 << ((dateOf(day).getDay() + 6) % 7);

/** The local day `days` after `day`. */
export function shiftDay(day: string, days: number): string {
  const date = dateOf(day);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

/** Whether a plan asks for its doses on a local day; a paused one asks for none. */
export function plannedOn(plan: PlanFacts, day: string): boolean {
  return !plan.paused && day >= plan.startsOn && (plan.endsOn == null || day <= plan.endsOn) && (plan.weekdays & weekdayOf(day)) !== 0;
}

export interface Dose {
  planId: string;
  dueOn: string;
  dueTime: string;
}

/** The moment a dose is due, on this device's clock. */
export const momentOf = (dose: Pick<Dose, "dueOn" | "dueTime">) => dateOf(dose.dueOn, dose.dueTime);

const keyOf = (dose: Dose) => `${dose.planId} ${dose.dueOn} ${dose.dueTime}`;

export interface DoseAnswer extends Dose {
  status: DoseStatus;
  snoozedUntil: string | null;
}

/** A dose and its answer; `due` has come and not been answered, `upcoming` has not come. */
export type DoseState = DoseStatus | "due" | "upcoming" | "unanswered";

export interface DayDose extends Dose {
  state: DoseState;
  answer: DoseAnswer | null;
}

/**
 * The doses of a day, by time: those the plans ask for, and those answered
 * that day whatever the plan says now — an answer outlives a plan edited,
 * paused or deleted since. Unanswered, one whose time has passed is `due` on
 * its own day and `unanswered` after it.
 */
export function dosesOfDay(plans: readonly PlanFacts[], answers: readonly DoseAnswer[], day: string, now: Date): DayDose[] {
  const doses = new Map<string, Dose>();
  for (const plan of plans) if (plannedOn(plan, day)) for (const dueTime of timesOf(plan.times)) doses.set(keyOf({ planId: plan.id, dueOn: day, dueTime }), { planId: plan.id, dueOn: day, dueTime });
  const answered = new Map(answers.filter((answer) => answer.dueOn === day).map((answer) => [keyOf(answer), answer]));
  for (const [key, answer] of answered) doses.set(key, { planId: answer.planId, dueOn: day, dueTime: answer.dueTime });
  return [...doses.entries()]
    .map(([key, dose]) => {
      const answer = answered.get(key) ?? null;
      const state: DoseState = answer ? answer.status : momentOf(dose) > now ? "upcoming" : day === localDay(now) ? "due" : "unanswered";
      return { ...dose, state, answer };
    })
    .sort((a, b) => a.dueTime.localeCompare(b.dueTime) || a.planId.localeCompare(b.planId));
}

/**
 * When the phone is to say each dose still unanswered, over `days` days from
 * `now`: at its time, or a dose put off at the moment it was put off until.
 * Yesterday's are read too, for one put off past midnight. Only the plans
 * given and not paused are said, their answers included.
 */
export function dosesToSay(plans: readonly PlanFacts[], answers: readonly DoseAnswer[], now: Date, days: number): { planId: string; at: Date }[] {
  // Paused, a plan says nothing, a dose put off before the pause included: as a deleted plan's.
  const given = new Set(plans.filter((plan) => !plan.paused).map((plan) => plan.id));
  const theirs = answers.filter((answer) => given.has(answer.planId));
  const said: { planId: string; at: Date }[] = [];
  for (let shift = -1; shift <= days; shift += 1) {
    for (const dose of dosesOfDay(plans, theirs, shiftDay(localDay(now), shift), now)) {
      const until = dose.state === "snoozed" ? dose.answer!.snoozedUntil : null;
      const at = dose.answer == null ? momentOf(dose) : until ? new Date(until) : null;
      if (at && at > now) said.push({ planId: dose.planId, at });
    }
  }
  return said;
}
