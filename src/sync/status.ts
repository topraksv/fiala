/** What sync is doing, for Ayarlar (SPEC 3.2): a failure is shown, never swallowed. */

import { create } from "zustand";

type SyncState = "idle" | "syncing" | "attention" | "error";

/** A sync that finished with records the server would not take is not a healthy one. */
export function completedSyncState(deadLetterCount: number): SyncState {
  return deadLetterCount > 0 ? "attention" : "idle";
}

export type RefreshOutcome = "refreshed" | "expired" | "unavailable";

/**
 * Only an answer from Auth retires a session. A refresh that never arrived
 * says nothing about it, and calling it "signed out" would stop the retries
 * that recover by themselves.
 */
export function classifyRefreshFailure(error: unknown): Exclude<RefreshOutcome, "refreshed"> {
  return isNetworkFailure(error instanceof Error ? `${error.name} ${error.message}` : String(error)) ? "unavailable" : "expired";
}

/** A request that never reached the server, or never came back from it. */
export function isNetworkFailure(text: string): boolean {
  return /retryable|network|fetch|timeout|timed out|offline|abort|socket|econn|dns|502|503|504/i.test(text);
}

interface SyncStatusStore {
  state: SyncState;
  lastSyncAt: string | null;
  error: string | null;
  set: (patch: Partial<Omit<SyncStatusStore, "set">>) => void;
}

export const useSyncStatus = create<SyncStatusStore>((set) => ({
  state: "idle",
  lastSyncAt: null,
  error: null,
  set: (patch) => set(patch),
}));

/**
 * Whether "nothing here" can be said yet: a device signed in again starts
 * empty, and until its first pull has answered — or failed — an empty screen
 * would tell a returning account it has nothing, and invite a duplicate.
 */
export function pulledOnce(status: Pick<SyncStatusStore, "state" | "lastSyncAt">): boolean {
  return status.lastSyncAt != null || status.state === "error" || status.state === "attention";
}
