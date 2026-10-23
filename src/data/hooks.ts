/** React's side of the live stores; what they decide lives in `live-query.ts`. */

import { useMemo, useSyncExternalStore } from "react";
import { liveStore, type LiveStore } from "./live-query";
import { useSession } from "../auth/session";
import { readActivity, readCabinet, readHouseholdEvents, readChanges, readHouseholds, readMoves, readNamed, readPeople, writes } from "./cabinet";
import { frozenFrom, openHouseholdOf, profileChoice, readSettings } from "./settings";

function useStore<T>(store: LiveStore<T>) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const settingsStore = liveStore(readSettings, ["settings"]);
// A photo reaches the device after its row: a list watches them, or it would wait for the next edit to draw one.
// And each the cabinets, whose deletion takes a household's rows out of every read.
const cabinetStore = liveStore(readCabinet, ["products", "packages", "package_moves", "people", "tags", "product_tags", "photos", "cabinets"]);
const peopleStore = liveStore(readPeople, ["people", "photos", "cabinets"]);
const locationsStore = liveStore(() => readNamed("locations"), ["locations", "cabinets"]);
const tagsStore = liveStore(() => readNamed("tags"), ["tags", "cabinets"]);
const householdsStore = liveStore(readHouseholds, ["cabinets", "cabinet_members", "photos"]);
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

/** The person's own cabinet, the households on the device, and the one open beside it. */
export function useHouseholds() {
  const me = useSession((s) => s.userId);
  const households = useStore(householdsStore);
  const open = openHouseholdOf(useStore(settingsStore).data, households.data);
  /**
   * What Dolabım and Durum list: the person's own cabinet and the household
   * open. A box's or a product's own page, and the reminders, reach every one.
   */
  const shows = (cabinetId: string) => cabinetId === me || cabinetId === open?.id;
  return { me, households, open, shows, writes: (cabinetId: string) => writes(households.data, me, cabinetId) };
}

/** The name the person goes by in a household: the one they joined with, else their profile's; `null` until there is one to ask. */
export function useMemberName(): string | null {
  const { me, households } = useHouseholds();
  const people = useStore(peopleStore).data;
  const settings = useStore(settingsStore).data;
  const joined = households.data.flatMap((household) => household.members).find((member) => member.userId === me && member.name)?.name;
  return joined ?? people.find((person) => person.id === profileChoice(settings, "me", me, people))?.name ?? null;
}

export function useShownCabinet() {
  const cabinet = useCabinet();
  const { shows } = useHouseholds();
  return { ...cabinet, data: cabinet.data.filter((product) => shows(product.cabinetId)) };
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

export function useActivity(cabinetId: string) {
  const store = useMemo(() => liveStore(() => readActivity(cabinetId), ["package_moves", "package_changes", "packages", "products"]), [cabinetId]);
  return useStore(store);
}

export function useHouseholdEvents() {
  const me = useSession((s) => s.userId);
  const store = useMemo(
    () => liveStore(() => (me ? readHouseholdEvents(me) : Promise.resolve([])), ["cabinet_members", "cabinets", "package_moves", "package_changes", "packages", "products"]),
    [me],
  );
  return useStore(store);
}

export function useChanges(packageId: string) {
  const store = useMemo(() => liveStore(() => readChanges(packageId), ["package_changes"]), [packageId]);
  return useStore(store);
}
