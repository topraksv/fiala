/**
 * One-at-a-time request queue for the promise-based overlays.
 *
 * `appError` and `appPrompt` hand a `resolve` to a store and await it, so a
 * store that keeps a SINGLE slot loses a promise as soon as two requests
 * overlap: the second overwrites `current`, the first `resolve` is dropped, and
 * its `await` never settles.
 *
 * The reducer lives here, outside the component file, for one reason: `dialog.tsx`
 * imports react-native and cannot be loaded by vitest, so the logic could only be
 * covered by a copy of itself in the test. Two hosts plus a test copy is three
 * places for the same four lines to drift; this is the one place.
 */

export interface RequestQueue<T> {
  /** The request currently on screen; `null` when nothing is open. */
  current: T | null;
  /** Requests waiting behind it, oldest first. */
  queue: T[];
}

export function emptyRequestQueue<T>(): RequestQueue<T> {
  return { current: null, queue: [] };
}

/** Show `request` immediately when idle, otherwise park it behind the queue. */
export function enqueueRequest<T>(state: RequestQueue<T>, request: T): RequestQueue<T> {
  return state.current == null
    ? { current: request, queue: state.queue }
    : { current: state.current, queue: [...state.queue, request] };
}

/** Drop the open request and promote the next one. */
export function advanceRequestQueue<T>(state: RequestQueue<T>): RequestQueue<T> {
  return { current: state.queue[0] ?? null, queue: state.queue.slice(1) };
}

/** What closing needs of a store: zustand's, or the test's. */
interface QueueStore<T> {
  getState: () => RequestQueue<T>;
  setState: (next: RequestQueue<T>) => void;
}

/**
 * Close `request` if it is still the one open, then settle it.
 *
 * Only that request: a double tap reaches the old control before the host has
 * re-rendered, and closing whatever is open then would settle the next prompt
 * with the first one's answer. And settling comes AFTER the store has moved
 * on, so a handler that opens another request enqueues against the advanced
 * state instead of being overwritten by it.
 */
export function closeRequest<T>(store: QueueStore<T>, request: T, settle: (request: T) => void): void {
  if (store.getState().current !== request) return;
  store.setState(advanceRequestQueue(store.getState()));
  settle(request);
}

/** A modal the overlays can be drawn inside: a sheet holds either, a prompt only a dialog above it. */
export interface OpenModal {
  id: number;
  kind: "sheet" | "prompt" | "dialog";
  /** Closed in React and still animating out on the phone. */
  leaving?: boolean;
}

/**
 * Which open modal presents the next overlay of `kind`: the newest that may
 * hold it, `null` for the root, or "wait" while any modal is leaving. iOS
 * presents one modal from a controller at a time, so an overlay drawn beside an
 * open sheet rather than inside it is refused, and one presented while another
 * leaves is stranded on screen, unseen, taking every touch.
 */
export function presenterOf(open: readonly OpenModal[], kind: "prompt" | "dialog"): number | null | "wait" {
  if (open.some((modal) => modal.leaving)) return "wait";
  const holds = kind === "prompt" ? ["sheet"] : ["sheet", "prompt"];
  return open.findLast((modal) => holds.includes(modal.kind))?.id ?? null;
}
