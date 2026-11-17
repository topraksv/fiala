/** What a status pill says about a box or a product, and how full a box still is: pure, so a test holds the words. */

import { OPENED_SOON_DAYS, SOON_DAYS, boxExpiry, daysUntil, expiryState, formatDay, isEmpty, lastOpenDay, type BoxFacts } from "../domain/boxes";
import { tr } from "../i18n/tr";

export type PillTone = "error" | "warning" | "ok";

export interface Pill {
  tone: PillTone;
  label: string;
}

const RANK: Record<PillTone, number> = { error: 0, warning: 1, ok: 2 };

/**
 * The state of the nearer of a box's two ends, said by the day that makes it:
 * days past or days left, and for a box still good, its printed day. A box
 * that left the cabinet, or has nothing left, asks for nothing, as on Durum.
 */
export function boxPill(box: BoxFacts, today: string): Pill | null {
  if (box.disposition != null || isEmpty(box)) return null;
  const state = boxExpiry(box, today);
  if (state === "unknown") return null;
  const openDay = lastOpenDay(box.openedOn, box.useWithinDays);
  const printed = expiryState(box.expiresOn, today, box.soonDays ?? SOON_DAYS) === state ? box.expiresOn : null;
  const opened = expiryState(openDay, today, OPENED_SOON_DAYS) === state ? openDay : null;
  const day = [printed, opened].filter((each): each is string => each != null).sort()[0]!;
  const days = daysUntil(day, today);
  if (state === "expired") return { tone: "error", label: tr.status.daysAgo(-days) };
  if (state === "soon") return { tone: "warning", label: tr.status.daysLeft(days) };
  return { tone: "ok", label: day === printed ? tr.cabinet.expires(formatDay(day)) : tr.cabinet.openUntil(formatDay(day)) };
}

/** The worst of a product's boxes, the soonest first among equals. */
export function productPill(boxes: readonly BoxFacts[], today: string): Pill | null {
  const pills = boxes.map((box) => boxPill(box, today)).filter((pill): pill is Pill => pill != null);
  return pills.reduce<Pill | null>((worst, pill) => (worst == null || RANK[pill.tone] < RANK[worst.tone] ? pill : worst), null);
}

/** What is left of what ever went into a box, 0 to 1; none while no move says how much that was. */
export function stockShare(remainingMilli: number, moves: readonly { quantityMilli: number }[]): number | null {
  const intake = moves.reduce((sum, move) => (move.quantityMilli > 0 ? sum + move.quantityMilli : sum), 0);
  return intake > 0 ? Math.min(1, Math.max(0, remainingMilli / intake)) : null;
}
