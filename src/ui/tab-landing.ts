/**
 * Where a thing leaving one tab for another goes (`docs/UI.md` section 7):
 * the tab bar writes where each tab sits after its layout, a screen reads it
 * to fly a row there, and the bar bounces the tab it landed on. Module state,
 * because the bar and the screen share no parent below the navigator. Kept
 * free of React Native so its sums are tested.
 */

interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  width: number;
  height: number;
}

const centres = new Map<string, Point>();
const listeners = new Set<(name: string) => void>();

/** `edge` is the bar's outline and padding, which the slots share nothing of. */
export function placeTabs(names: readonly string[], bar: Box, edge: number): void {
  const slot = (bar.width - edge * 2) / names.length;
  names.forEach((name, index) => centres.set(name, { x: bar.x + edge + slot * (index + 0.5), y: bar.y + bar.height / 2 }));
}

/** Window coordinates, or null before the bar has laid out. */
export function tabCentre(name: string): Point | null {
  return centres.get(name) ?? null;
}

/** How far a box's centre moves to land on `to`. */
export function flightTo(from: Box, to: Point): { dx: number; dy: number } {
  return { dx: to.x - (from.x + from.width / 2), dy: to.y - (from.y + from.height / 2) };
}

export function landTab(name: string): void {
  for (const listener of listeners) listener(name);
}

export function onLanding(listener: (name: string) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
