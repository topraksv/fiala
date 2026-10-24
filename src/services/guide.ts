/**
 * Rehber's public data, asked of the server (`docs/TASKS.md` F1.9, F5.1,
 * F5.3, F5.6; migrations 16 and 17): TİTCK's medicine list and
 * OpenStreetMap's pharmacies. Both live on the server, not on the device:
 * 23,000 medicines and 25,000 pharmacies would outweigh the cabinet, so each
 * question needs a connection. Every question goes in a POST body, never a
 * URL: what a person looks up is health data, and where they stand is
 * personal. A position never leaves the device; a box of map rounded wider
 * than it does (`boxAround`).
 *
 * What a person opened and starred here is kept on this device alone, and
 * forgotten when it passes to another account.
 */

import { tr } from "../i18n/tr";
import { getSupabase } from "../sync/supabase";
import { kv, kvList } from "./kv";

export interface CatalogueEntry {
  id: string;
  /** GTIN-14, as `products.gtin` keeps it. */
  gtin: string | null;
  name: string;
  activeSubstance: string | null;
  atc: string | null;
  holder: string | null;
  suspended: boolean;
  /** The TİTCK list's date, a local day: what the screen cites. */
  listedOn: string;
}

interface CatalogueRow {
  id: string;
  gtin: string | null;
  name: string;
  active_substance: string | null;
  atc: string | null;
  holder: string | null;
  suspended: boolean;
  listed_on: string;
}

export interface Pharmacy {
  /** OpenStreetMap's: "node/123". */
  id: string;
  name: string | null;
  province: string;
  district: string | null;
  neighbourhood: string | null;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  lat: number;
  lon: number;
  /** The load that last saw it, a local day. */
  seenOn: string;
}

interface PharmacyRow extends Omit<Pharmacy, "openingHours" | "seenOn"> {
  opening_hours: string | null;
  seen_on: string;
}

export interface Place {
  province: string;
  district: string | null;
  pharmacies: number;
}

/** The rows a function returns; `null` when the server cannot be asked, or refused. */
async function ask<Row>(name: string, args: Record<string, unknown>): Promise<Row[] | null> {
  let answer;
  try {
    // No server throws here as a refused call does: either way the question could not be asked.
    answer = await getSupabase()!.rpc(name, args);
  } catch {
    return null;
  }
  return answer.error || !Array.isArray(answer.data) ? null : (answer.data as Row[]);
}

const entryOf = (row: CatalogueRow): CatalogueEntry => ({
  id: row.id,
  gtin: row.gtin,
  name: row.name,
  activeSubstance: row.active_substance,
  atc: row.atc,
  holder: row.holder,
  suspended: row.suspended,
  listedOn: row.listed_on,
});

const pharmacyOf = ({ opening_hours, seen_on, ...row }: PharmacyRow): Pharmacy => ({ ...row, openingHours: opening_hours, seenOn: seen_on });

/** Fewer letters find half the list. */
export const SEARCH_FROM = 2;
const SHOWN = 20;

/** The entries every word of `query` is in, licensed first; `null` when the catalogue cannot be asked. */
export async function searchCatalogue(query: string): Promise<CatalogueEntry[] | null> {
  if (query.trim().length < SEARCH_FROM) return [];
  return (await ask<CatalogueRow>("search_catalogue", { query, max_rows: SHOWN }))?.map(entryOf) ?? null;
}

/** The products the list gives this GTIN, usually one; a search's barcode match, held to the whole code. */
export async function catalogueByGtin(gtin: string): Promise<CatalogueEntry[] | null> {
  const found = await searchCatalogue(gtin.replace(/^0/, ""));
  return found && found.filter((entry) => entry.gtin === gtin);
}

/** One entry; `undefined` when the list no longer has it. */
export async function catalogueEntry(id: string): Promise<CatalogueEntry | null | undefined> {
  const found = await ask<CatalogueRow>("catalogue_entry", { entry_id: id });
  return found && (found.map(entryOf)[0] ?? undefined);
}

/** The same name in other strengths and forms, then the same substance under other names. */
export async function catalogueRelated(id: string): Promise<CatalogueEntry[] | null> {
  return (await ask<CatalogueRow>("catalogue_related", { entry_id: id }))?.map(entryOf) ?? null;
}

export const pharmacyPlaces = (): Promise<Place[] | null> => ask<Place>("pharmacy_places", {});

export async function pharmaciesOf(province: string, district: string | null): Promise<Pharmacy[] | null> {
  return (await ask<PharmacyRow>("pharmacies_of", { province, district }))?.map(pharmacyOf) ?? null;
}

export async function pharmaciesIn(box: Box): Promise<Pharmacy[] | null> {
  return (await ask<PharmacyRow>("pharmacies_in", { ...box }))?.map(pharmacyOf) ?? null;
}

export async function pharmaciesById(ids: readonly string[]): Promise<Pharmacy[] | null> {
  return (await ask<PharmacyRow>("pharmacies_by_id", { ids }))?.map(pharmacyOf) ?? null;
}

export interface Point {
  lat: number;
  lon: number;
}

export interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

const KM_PER_DEGREE = 111.32;
const MAX_SPAN = 0.99;
/** A hundredth of a degree, about a kilometre: where on the grid a box's edges fall. */
const GRID = 100;

/**
 * A box at least `km` around `at`, its edges on a grid a kilometre wide, so
 * the server learns the square kilometre a person is in, not their position.
 * Never more than a degree a side, as the server takes, its rounding outward included.
 */
export function boxAround(at: Point, km: number): Box {
  const lat = Math.min(km / KM_PER_DEGREE, 0.49);
  const lon = Math.min(km / (KM_PER_DEGREE * Math.cos((at.lat * Math.PI) / 180)), 0.49);
  const down = (value: number) => Math.floor(value * GRID) / GRID;
  const up = (value: number) => Math.ceil(value * GRID) / GRID;
  return { south: down(at.lat - lat), west: down(at.lon - lon), north: up(at.lat + lat), east: up(at.lon + lon) };
}

/** A map's visible region as a box, cut under the degree a side the server takes, around its middle. */
export function boxOfRegion(middle: Point, latitudeDelta: number, longitudeDelta: number): Box {
  // Not 1: near 32° east a degree's edges subtract to a hair over 1, which the server refuses.
  const lat = Math.min(latitudeDelta, MAX_SPAN) / 2;
  const lon = Math.min(longitudeDelta, MAX_SPAN) / 2;
  return { south: middle.lat - lat, west: middle.lon - lon, north: middle.lat + lat, east: middle.lon + lon };
}

/** Kilometres between two points over the earth's surface (haversine). */
export function distanceKm(from: Point, to: Point): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(to.lat - from.lat);
  const dLon = radians(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** The pharmacies whose name, neighbourhood or address holds every word of `query`, nearest first when `from` is known, else by name. */
export function pharmaciesShown(pharmacies: readonly Pharmacy[], query: string, from: Point | null): Pharmacy[] {
  const fold = (text: string) => text.toLocaleLowerCase("tr-TR");
  const words = fold(query).split(" ");
  const kept = pharmacies.filter((pharmacy) => {
    const text = fold([pharmacy.name, pharmacy.neighbourhood, pharmacy.address, pharmacy.district].join(" "));
    return words.every((word) => text.includes(word));
  });
  const named = (a: Pharmacy, b: Pharmacy) => (a.name ?? "").localeCompare(b.name ?? "", "tr");
  return kept.sort(from ? (a, b) => distanceKm(from, a) - distanceKm(from, b) || named(a, b) : named);
}

const DAY = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)";
const SPAN = "\\d{1,2}:\\d\\d\\s*-\\s*\\d{1,2}:\\d\\d";
const RULE = new RegExp(`^(${DAY}(?:[-,]${DAY})*)?\\s*(off|closed|${SPAN}(?:,${SPAN})*)$`, "iu");
/** `mo` is written as often as `Mo`, and `9:00` as `09:00`. */
const dayCode = (day: string) => (day.toUpperCase() === "PH" ? "PH" : day[0]!.toUpperCase() + day[1]!.toLowerCase());
const clock = (time: string) => time.trim().padStart(5, "0");

/**
 * OpenStreetMap's `opening_hours` in Turkish, for the forms nearly every
 * pharmacy carries (`Mo-Sa 09:00-19:00; Su off`, `24/7`; 1,955 of the 1,979
 * that have one, measured 24.10.2026). Anything else is shown as written: a
 * half-read rule would state hours the pharmacy does not keep.
 */
export function hoursInTurkish(written: string): string {
  const { days, closed, allDay, always, everyDay, joiner } = tr.pharmacies.openingHours;
  if (written.trim() === "24/7") return always;
  const rules = written.split(";").map((rule) => RULE.exec(rule.trim()));
  if (rules.some((rule) => !rule)) return written;
  return rules
    .map((rule) => {
      const [, when, hours] = rule!;
      const spans = hours!.split(",").map((span) => span.split("-").map(clock).join("–")).join(", ");
      const said = /off|closed/iu.test(hours!) ? closed : spans === "00:00–24:00" ? allDay : spans;
      const named = when ? when.replace(new RegExp(DAY, "giu"), (day) => days[dayCode(day) as keyof typeof days]).replaceAll("-", "–").replaceAll(",", ", ") : everyDay;
      return `${named} ${said}`;
    })
    .join(joiner);
}

const RECENT_MEDICINES_KEY = "fiala.guide.recentMedicines";
const STARRED_MEDICINES_KEY = "fiala.guide.starredMedicines";
const RECENT_PHARMACIES_KEY = "fiala.guide.recentPharmacies";
const STARRED_PHARMACIES_KEY = "fiala.guide.starredPharmacies";
const PLACE_KEY = "fiala.guide.place";
const LOCATION_KEY = "fiala.guide.location";

export const recentMedicines = kvList(RECENT_MEDICINES_KEY, 10);
export const starredMedicines = kvList(STARRED_MEDICINES_KEY, 15);
export const recentPharmacies = kvList(RECENT_PHARMACIES_KEY, 10);
export const starredPharmacies = kvList(STARRED_PHARMACIES_KEY, 15);

/** The province and district last chosen by hand, so the screen opens on it. */
export async function readPlace(): Promise<{ province: string; district: string | null } | null> {
  try {
    const place = JSON.parse((await kv.get(PLACE_KEY)) ?? "null") as { province?: unknown; district?: unknown } | null;
    return typeof place?.province === "string" ? { province: place.province, district: typeof place.district === "string" ? place.district : null } : null;
  } catch {
    return null;
  }
}

export function savePlace(place: { province: string; district: string | null }): Promise<void> {
  return kv.set(PLACE_KEY, JSON.stringify(place)).catch(() => {});
}

export function forgetPlace(): Promise<void> {
  return kv.remove(PLACE_KEY).catch(() => {});
}

/** Whether Eczaneler may ask for the device's location: on until it is turned off in Ayarlar. */
export const readLocationOn = (): Promise<boolean> => kv.get(LOCATION_KEY).then((value) => value !== "off", () => true);

export function saveLocationOn(on: boolean): Promise<void> {
  return (on ? kv.remove(LOCATION_KEY) : kv.set(LOCATION_KEY, "off")).catch(() => {});
}

/** The device passes to another account: what this one opened, starred and chose goes. */
export async function forgetGuide(): Promise<void> {
  await Promise.all([...[recentMedicines, starredMedicines, recentPharmacies, starredPharmacies].map((list) => list.forget()), kv.remove(PLACE_KEY), kv.remove(LOCATION_KEY)]);
}
