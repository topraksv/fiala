/**
 * What Rehber's screens share (`docs/TASKS.md` F5.1, F5.3, F5.6): an answer
 * from the server held with its question, the remembered lists, a pharmacy's
 * row, and the links out to a phone call, a map and an official page.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import MapPin from "lucide-react-native/icons/map-pin";

import { tr } from "../i18n/tr";
import { distanceKm, type Pharmacy, type Point } from "../services/guide";
import type { kvList } from "../services/kv";
import { appError } from "./dialog";
import { ListRow } from "./components";

export interface Answer<T> {
  status: "loading" | "error" | "ready";
  data?: T;
  /** While the next answer loads, the last one: a screen that keeps it on screen does not jump. */
  previous?: T;
  retry: () => void;
}

/**
 * What `ask` answers for `key`, held with it so an earlier answer arriving
 * late is never drawn as this one's; `null` from `ask` is an error the screen
 * offers to retry. No key asks nothing. `ask` is a module's function, so it
 * never changes between renders.
 */
export function useAnswer<T>(key: string | null, ask: (key: string) => Promise<T | null>): Answer<T> {
  const [held, setHeld] = useState<{ key: string; round: number; data: T | null } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (key == null) return;
    let live = true;
    void ask(key).then((data) => {
      if (live) setHeld({ key, round, data });
    });
    return () => {
      live = false;
    };
  }, [key, ask, round]);
  const retry = () => setRound((current) => current + 1);
  if (key == null) return { status: "loading", retry };
  if (held?.key !== key || held.round !== round) return { status: "loading", previous: held?.data ?? undefined, retry };
  return held.data === null ? { status: "error", retry } : { status: "ready", data: held.data, retry };
}

/** A remembered list as a screen reads it, redrawn when it changes. */
export function useRemembered(list: ReturnType<typeof kvList>) {
  return useSyncExternalStore(list.subscribe, list.get, list.get);
}

/** A link out, said when the device has nothing to open it with. */
export async function openLink(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    await appError(tr.guide.linkFailed);
  }
}

export const pharmacyName = (pharmacy: Pick<Pharmacy, "name">) => pharmacy.name ?? tr.pharmacies.unnamed;

/** Where the pharmacy is, in the device's own map: Apple's on iOS, the platform's on Android, Google's on the web. */
export function mapLink(pharmacy: Pharmacy): string {
  const at = `${pharmacy.lat},${pharmacy.lon}`;
  const label = encodeURIComponent(pharmacyName(pharmacy));
  if (Platform.OS === "ios") return `https://maps.apple.com/?ll=${at}&q=${label}`;
  if (Platform.OS === "android") return `geo:${at}?q=${at}(${label})`;
  return `https://www.google.com/maps/search/?api=1&query=${at}`;
}

export function directionsLink(pharmacy: Pharmacy): string {
  const at = `${pharmacy.lat},${pharmacy.lon}`;
  return Platform.OS === "ios" ? `https://maps.apple.com/?daddr=${at}` : `https://www.google.com/maps/dir/?api=1&destination=${at}`;
}

export const correctionLink = (pharmacy: Pharmacy) => `https://www.openstreetmap.org/${pharmacy.id}`;

/** A phone number as dialled: what OpenStreetMap holds, its first when it holds several. */
export const callLink = (phone: string) => `tel:${phone.split(/[;,]/)[0]!.replace(/[^\d+]/g, "")}`;

export function PharmacyRow({ pharmacy, from, onPress }: { pharmacy: Pharmacy; from: Point | null; onPress: () => void }) {
  return (
    <ListRow
      icon={MapPin}
      title={pharmacyName(pharmacy)}
      subtitle={tr.common.joined(from ? tr.pharmacies.distance(distanceKm(from, pharmacy)) : undefined, pharmacy.neighbourhood ?? undefined, pharmacy.district ?? undefined)}
      chevron
      onPress={onPress}
    />
  );
}
