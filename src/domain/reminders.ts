/**
 * The reminders a phone is given (`docs/TASKS.md` F1.24), planned from what
 * is on the device. Every plan replaces the last and holds only moments still
 * ahead, each fixed by the box itself — its dates, its last move, its
 * addition — so a warning rings once and the next plan never repeats it. The
 * words are the service's; this says what, when, and what a tap opens.
 */

import { OPENED_SOON_DAYS, SOON_DAYS, isEmpty, isLow, lastOpenDay, localDay, type BoxFacts } from "./boxes";

/** Said in the morning, before the day's first dose, unless the person chose another hour. */
export const REMINDER_HOUR = 9;
/** The plan is renewed whenever the app leaves the screen; a month covers a phone left closed for weeks. */
const HORIZON_DAYS = 30;
/** iOS keeps 64 pending local notifications and silently drops the rest. */
export const REMINDERS_MAX = 60;

export interface ReminderBox extends BoxFacts {
  /** A uuidv7, so it says when the box was added. */
  id: string;
  name: string;
  /** When its amount last changed, as stored; null for a box never counted. */
  movedAt: string | null;
  /** When the person was asked to check it (F2.9); given only to the one asked. */
  askedAt?: string | null;
}

export type ReminderKind = "dose" | "doseRenew" | "expirySoon" | "expired" | "openSoon" | "openEnded" | "low" | "empty" | "undated" | "check" | HouseholdKind;
/** Said in the centre alone, of the person's households (F2.9, F2.11). */
export type HouseholdKind = "asked" | "memberJoined" | "boxAdded" | "boxLeft";

/** What a person can silence (F1.29): a warning and its passing are one subject. */
export const REMINDER_GROUPS = {
  dose: ["dose", "doseRenew"],
  expiry: ["expirySoon", "expired"],
  opened: ["openSoon", "openEnded"],
  stock: ["low", "empty"],
  undated: ["undated"],
  check: ["check"],
  household: ["asked", "memberJoined", "boxAdded", "boxLeft"],
} as const satisfies Record<string, readonly ReminderKind[]>;
export type ReminderGroup = keyof typeof REMINDER_GROUPS;

/** `name` is null when the words may not name the medicine. */
export interface Reminder {
  kind: ReminderKind;
  at: Date;
  name: string | null;
  target: NotificationTarget;
  /** Of a household's: the member who did it, and how many boxes it was. */
  by?: string;
  count?: number;
}

/**
 * What a notification is about, by kind and record id, never by route
 * (Helix's decision, `docs/ARCHITECTURE.md`): a route read back from the OS
 * would be a destination this app follows from outside its own code. It never
 * carries a name either: the payload is readable by whatever reads the
 * notification.
 */
// A household is never a phone's target: what the centre alone says may open one.
export type NotificationTarget = { kind: "box"; id: string } | { kind: "cabinet" } | { kind: "doses" } | { kind: "household"; id: string };

const TARGET_KEY = "fialaTarget";

export function targetPayload(target: NotificationTarget): Record<string, unknown> {
  return { [TARGET_KEY]: target };
}

/** A payload this build did not write, or an older one's, opens nothing. */
export function readTarget(data: unknown): NotificationTarget | null {
  const raw = (data as Record<string, unknown> | null)?.[TARGET_KEY] as { kind?: unknown; id?: unknown } | undefined;
  if (raw?.kind === "cabinet" || raw?.kind === "doses") return { kind: raw.kind };
  return raw?.kind === "box" && typeof raw.id === "string" && raw.id !== "" ? { kind: "box", id: raw.id } : null;
}

export type ReminderRoute = { pathname: "/cabinet" | "/doses" } | { pathname: "/box/[id]" | "/household/[id]"; params: { id: string } };

/** A box gone since opens its page, which says so. */
export function routeOf(target: NotificationTarget): ReminderRoute {
  if (target.kind === "cabinet" || target.kind === "doses") return { pathname: target.kind === "cabinet" ? "/cabinet" : "/doses" };
  return { pathname: target.kind === "box" ? "/box/[id]" : "/household/[id]", params: { id: target.id } };
}

function momentOf(day: string, shift: number, hour: number): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date + shift, hour);
}

/** The time a uuidv7 was minted, its first 48 bits. */
const mintedAt = (id: string) => new Date(parseInt(id.replace(/-/g, "").slice(0, 12), 16));

/** Each day a box asks to be spoken of, and how many days from it, whether or not it is still ahead; null asks nothing. */
function boxMoments(box: ReminderBox): [ReminderKind, string | null, number][] {
  // Counted, so moved: a box is empty or low only by its moves.
  const movedDay = () => localDay(new Date(box.movedAt!));
  // An empty box asks for nothing but to be replaced, as Durum counts it.
  if (isEmpty(box)) return [["empty", movedDay(), 1]];
  const lastDay = lastOpenDay(box.openedOn, box.useWithinDays);
  return [
    ["expirySoon", box.expiresOn, -(box.soonDays ?? SOON_DAYS)],
    ["expired", box.expiresOn, 1],
    ["undated", box.expiresOn ? null : localDay(mintedAt(box.id)), 1],
    ["openSoon", lastDay, -OPENED_SOON_DAYS],
    ["openEnded", lastDay, 1],
    ["low", isLow(box) ? movedDay() : null, 1],
  ];
}

export interface ReminderInput {
  now: Date;
  boxes: readonly ReminderBox[];
  /** Whether the words may name a medicine; off, they say only what kind of thing is due. */
  names: boolean;
  /** The hour of the day every reminder is said at. */
  hour: number;
  /** What the person silenced: neither planned nor listed in the centre. */
  muted: readonly ReminderGroup[];
  /** What happened in the person's households, for the centre: never planned. */
  events?: readonly Reminder[];
  /** The doses this phone says (`dosesToSay`), each at its own moment, not the hour: never in the centre. */
  doses?: readonly { at: Date; name: string }[];
}

/**
 * Every reminder within a horizon of `now`, ahead or behind, the same words
 * at the same moment once, as Helix's `uniqueNotifications`. Without names,
 * one per kind and moment, opening the cabinet: one naming a box would hand
 * back the identity just hidden (Helix's `privateNotificationTarget`).
 */
function remindersAround({ now, boxes, names, hour, muted, events = [], doses = [] }: ReminderInput, ahead: boolean): Reminder[] {
  const edge = new Date(now);
  edge.setDate(edge.getDate() + (ahead ? HORIZON_DAYS : -HORIZON_DAYS));
  const [from, to] = ahead ? [now, edge] : [edge, now];
  const home = boxes.filter((box) => box.disposition == null);
  const about = (kind: ReminderKind, at: Date, box: ReminderBox): Reminder =>
    names ? { kind, at, name: box.name, target: { kind: "box", id: box.id } } : { kind, at, name: null, target: { kind: "cabinet" } };
  const all: Reminder[] = home.flatMap((box) =>
    boxMoments(box)
      .filter(([, day]) => day != null)
      .map(([kind, day, shift]) => about(kind, momentOf(day!, shift, hour), box)),
  );
  // An ask is said when it came, not at the hour, and only by the centre: one from a clock ahead is not the phone's to plan.
  if (!ahead) for (const box of home) if (box.askedAt) all.push(about("asked", new Date(box.askedAt), box));
  if (!ahead) all.push(...events);
  // A dose opens the day's doses, named or not: the list is where it is answered.
  if (ahead) for (const dose of doses) all.push({ kind: "dose", at: dose.at, name: names ? dose.name : null, target: { kind: "doses" } });
  // The cabinet check, on the first of each month, of a cabinet with something in it: thirty days either way hold two at most.
  if (home.length > 0) {
    for (const month of [-1, 0, 1, 2]) all.push({ kind: "check", at: new Date(now.getFullYear(), now.getMonth() + month, 1, hour), name: null, target: { kind: "cabinet" } });
  }
  const quiet = new Set<ReminderKind>(muted.flatMap((group) => REMINDER_GROUPS[group]));
  const said = new Set<string>();
  return all.filter((reminder) => {
    const key = `${reminder.kind} ${reminder.at.getTime()} ${reminder.name}`;
    if (reminder.at <= from || reminder.at > to || quiet.has(reminder.kind) || said.has(key)) return false;
    said.add(key);
    return true;
  });
}

const soonest = (a: Reminder, b: Reminder) => a.at.getTime() - b.at.getTime();

/**
 * What the phone is to say, soonest first; this very moment has gone. Doses
 * and the rest each keep half of what iOS holds and take what the other
 * leaves: soonest first alone, a week of doses would push out every warning.
 */
export function planReminders(input: ReminderInput): Reminder[] {
  const all = remindersAround(input, true).sort(soonest);
  const doses = all.filter((reminder) => reminder.kind === "dose");
  const others = all.filter((reminder) => reminder.kind !== "dose");
  const kept = doses.slice(0, Math.max(REMINDERS_MAX / 2, REMINDERS_MAX - others.length) - 1);
  // A minute after the last dose planned, the phone says the plan has run out
  // (F7.13): with many doses a day the slots last days, not the week, and a
  // phone left unopened would otherwise go quiet without a word. Every open
  // plans again, so on a phone in use it never rings.
  const last = kept.at(-1);
  if (last) kept.push({ kind: "doseRenew", at: new Date(last.at.getTime() + 60_000), name: null, target: { kind: "doses" } });
  return [...kept, ...others.slice(0, REMINDERS_MAX - kept.length)].sort(soonest);
}

/**
 * The notification centre (`docs/TASKS.md` F1.25): what the cabinet has said
 * over the last thirty days, newest first, worked out from the boxes as they
 * are now rather than logged — a phone records no notification it showed
 * while the app was closed, and the web shows none. Named: the app is open.
 */
export function pastReminders(input: Omit<ReminderInput, "names">): Reminder[] {
  return remindersAround({ ...input, names: true }, false).sort((a, b) => b.at.getTime() - a.at.getTime());
}
