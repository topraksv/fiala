/**
 * Rotating examples: a field shows a realistic example that changes
 * every few seconds while it is empty, instead of one frozen sample. Three
 * rules about how are kept:
 *
 * 1. One module-level beat. A screen with three fields on three timers
 *    changed them at three moments, which reads as twitching rather than as
 *    one set of examples refreshing.
 * 2. No timer while nothing shows a sample. A field with a value draws no
 *    placeholder, and a tick into a filled form re-rendered it for nothing;
 *    `active` says when the sample is visible, and the clock stops with the
 *    last field to go quiet.
 * 3. Reduced motion holds the sample still: text changing on its own is the
 *    movement that setting exists to stop.
 */

import { useState, useSyncExternalStore } from "react";
import { tr } from "../i18n/tr";
import { useReducedMotion } from "./motion";

const ROTATE_MS = 4000;

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(() => {
      tick += 1;
      for (const notify of listeners) notify();
    }, ROTATE_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const still = () => () => {};
const read = () => tick;

/** An example from `pool`, starting at a random one, with the app's one "Ör." before it. */
export function useRotatingPlaceholder(pool: readonly string[], active = true): string {
  const [start] = useState(() => Math.floor(Math.random() * pool.length));
  const reducedMotion = useReducedMotion();
  const offset = useSyncExternalStore(active && !reducedMotion ? subscribe : still, read, read);
  const sample = pool[(start + offset) % pool.length];
  return sample ? tr.placeholders.example(sample) : "";
}
