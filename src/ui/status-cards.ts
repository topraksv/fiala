/**
 * Which of Durum's cards show, and in what order (`docs/TASKS.md` F1.26),
 * kept on this device: a layout is how one person reads their phone, not the
 * cabinet's data. The summary at the top is not among them: it holds the add
 * button, and a Durum without it would have no way in.
 */

import { kv } from "../services/kv";

export const STATUS_CARDS = ["doses", "lists", "expired", "soon", "opened", "stock", "undated", "boxes", "people", "recent"] as const;
export type StatusCard = (typeof STATUS_CARDS)[number];

export interface CardLayout {
  order: StatusCard[];
  hidden: StatusCard[];
}

const CARDS_KEY = "fiala.status.cards";

const isCard = (value: unknown): value is StatusCard => (STATUS_CARDS as readonly unknown[]).includes(value);

/**
 * What was stored, read defensively: an unknown or repeated card is dropped,
 * and a card this build added since joins at the end, shown.
 */
export function layoutFrom(stored: string | null): CardLayout {
  let parsed: { order?: unknown; hidden?: unknown } = {};
  try {
    parsed = (stored ? JSON.parse(stored) : {}) ?? {};
  } catch {
    // A layout that cannot be read is the default one, not a broken Durum.
  }
  const listed = (value: unknown) => [...new Set(Array.isArray(value) ? value.filter(isCard) : [])];
  const order = listed(parsed.order);
  return { order: [...order, ...STATUS_CARDS.filter((card) => !order.includes(card))], hidden: listed(parsed.hidden) };
}

export async function readCardLayout(): Promise<CardLayout> {
  return layoutFrom(await kv.get(CARDS_KEY));
}

export function saveCardLayout(layout: CardLayout): Promise<void> {
  return kv.set(CARDS_KEY, JSON.stringify(layout));
}

/** The order with `card` one place earlier or later; at either end it stays. */
export function moveCard(order: readonly StatusCard[], card: StatusCard, by: -1 | 1): StatusCard[] {
  const from = order.indexOf(card);
  const to = from + by;
  if (to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
