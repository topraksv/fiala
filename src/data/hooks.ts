/** React's side of the live stores; what they decide lives in `live-query.ts`. */

import { useSyncExternalStore } from "react";
import { liveStore, type LiveStore } from "./live-query";
import { frozenFrom, readSettings } from "./settings";

function useStore<T>(store: LiveStore<T>) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const settingsStore = liveStore(readSettings, ["settings"]);
const unwatched = () => () => {};

export function useSettings() {
  return useStore(settingsStore);
}

/**
 * Whether the account is frozen; watched only while signed in, since the reset
 * page opens no database. Unwatched is unknown: the store keeps the last
 * account's answer until the unsubscribe that follows its sign-out.
 */
export function useAccountFrozen(watching: boolean): boolean | null {
  const snapshot = useSyncExternalStore(watching ? settingsStore.subscribe : unwatched, settingsStore.getSnapshot, settingsStore.getSnapshot);
  return watching ? frozenFrom(snapshot) : null;
}
