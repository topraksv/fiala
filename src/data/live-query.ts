/**
 * Live queries: a read that re-runs when a table it reads changes, retries a
 * failure for ever on a capped backoff, and says which of those it is doing.
 * One query per key, however many screens watch it.
 */

import { addDatabaseChangeListener } from "expo-sqlite";
import type { SyncedTableName } from "../db/schema";

type LiveQueryStatus = "loading" | "ready" | "stale" | "error";

export interface LiveResult<T> {
  data: T[];
  status: LiveQueryStatus;
  /** The failed attempt, while a retry is pending; `null` once one succeeds. */
  error: { attempt: number } | null;
  /** When the query last answered. `undefined` means it never has, which is
   *  not the same as answering with nothing. */
  updatedAt: Date | undefined;
  /** Try again now, instead of waiting out the backoff. */
  retry: () => void;
}

type Snapshot<T> = Omit<LiveResult<T>, "retry">;

/**
 * The wait before attempt N+1. It never gives up: a fixed number of tries
 * froze screens on empty data behind a wedged worker; the ceiling keeps
 * "for ever" from being a tight loop.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 5000);
}

/** Bursts of change events, such as a row and its outbox event, run the query once. */
const COALESCE_MS = 60;

/**
 * A failure keeps the last good data and says it is `stale`; only a query that
 * never answered reports `error`. Rendering "no rows" from a query that has
 * not run is the lie this distinction exists to prevent.
 */
function startRunner<T>(
  query: () => PromiseLike<T[]>,
  tables: readonly SyncedTableName[],
  apply: (next: (previous: Snapshot<T>) => Snapshot<T>) => void,
): { retry: () => void; stop: () => void } {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // One read at a time. Two in flight could answer out of order, and two
  // failing each set a retry timer, leaving one that `stop` could not reach.
  let reading = false;
  let changedMeanwhile = false;

  const schedule = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  function run(): void {
    timer = null;
    if (reading) {
      changedMeanwhile = true;
      return;
    }
    reading = true;
    changedMeanwhile = false;
    // An answered query keeps what it showed until the next answer: no screen
    // reads a re-run, and announcing it redrew every one watching.
    apply((previous) => (previous.updatedAt ? previous : { ...previous, status: "loading", error: null }));
    query().then(
      (data) => {
        reading = false;
        if (stopped) return;
        attempt = 0;
        apply((previous) =>
          previous.status === "ready" && JSON.stringify(previous.data) === JSON.stringify(data)
            ? previous
            : { data, status: "ready", error: null, updatedAt: new Date() });
        if (changedMeanwhile) run();
      },
      () => {
        reading = false;
        if (stopped) return;
        attempt += 1;
        apply((previous) => ({ ...previous, status: previous.updatedAt ? "stale" : "error", error: { attempt } }));
        // The retry reads afresh, so a change seen meanwhile needs no run of its own.
        schedule(retryDelayMs(attempt));
      },
    );
  }

  const listener = addDatabaseChangeListener((event) => {
    // A platform that does not name the table re-runs everything, to be safe.
    if (event?.tableName && !(tables as readonly string[]).includes(event.tableName)) return;
    schedule(COALESCE_MS);
  });
  run();

  return {
    retry: () => {
      if (timer) clearTimeout(timer);
      run();
    },
    stop: () => {
      stopped = true;
      listener.remove();
      if (timer) clearTimeout(timer);
    },
  };
}

export interface LiveStore<T> {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => LiveResult<T>;
}

const NOT_YET: Snapshot<never> = { data: [], status: "loading", error: null, updatedAt: undefined };

/**
 * A store shaped for `useSyncExternalStore`. The query starts with the first
 * subscriber and stops with the last, so a tab screen and the screen pushed
 * over it read one query, not two — as long as they
 * hold the same store, which `hooks.ts` keeps at module scope.
 */
export function liveStore<T>(query: () => PromiseLike<T[]>, tables: readonly SyncedTableName[]): LiveStore<T> {
  const listeners = new Set<() => void>();
  let runner: { retry: () => void; stop: () => void } | null = null;
  const retry = () => runner?.retry();
  let state: LiveResult<T> = { ...NOT_YET, retry };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      if (!runner) {
        runner = startRunner(query, tables, (next) => {
          const after = next(state);
          if (after === state) return;
          state = { ...after, retry };
          for (const notify of listeners) notify();
        });
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0 || !runner) return;
        runner.stop();
        runner = null;
        // Its answer goes with it: the next screen reads the snapshot in its
        // first render, before it subscribes, and would draw what this one
        // last saw and then nothing while the query runs again.
        state = { ...NOT_YET, retry };
      };
    },
    getSnapshot: () => state,
  };
}
