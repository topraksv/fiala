/** React's side of the live stores; what they decide lives in `live-query.ts`. */

import { useMemo, useSyncExternalStore } from "react";
import { liveStore, type LiveStore } from "./live-query";
import { readCabinet, readChanges, readMoves, readNamed, readPeople } from "./cabinet";
import { frozenFrom, readSettings } from "./settings";

function useStore<T>(store: LiveStore<T>) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const settingsStore = liveStore(readSettings, ["settings"]);
// A photo reaches the device after its row: a list watches them, or it would wait for the next edit to draw one.
const cabinetStore = liveStore(readCabinet, ["products", "packages", "package_moves", "people", "tags", "product_tags", "photos"]);
const peopleStore = liveStore(readPeople, ["people", "photos"]);
const locationsStore = liveStore(() => readNamed("locations"), ["locations"]);
const tagsStore = liveStore(() => readNamed("tags"), ["tags"]);
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

export function useCabinet() {
  return useStore(cabinetStore);
}

export function usePeople() {
  return useStore(peopleStore);
}

export function useLocations() {
  return useStore(locationsStore);
}

export function useTags() {
  return useStore(tagsStore);
}

export function useMoves(packageId: string) {
  const store = useMemo(() => liveStore(() => readMoves(packageId), ["package_moves"]), [packageId]);
  return useStore(store);
}

export function useChanges(packageId: string) {
  const store = useMemo(() => liveStore(() => readChanges(packageId), ["package_changes"]), [packageId]);
  return useStore(store);
}
