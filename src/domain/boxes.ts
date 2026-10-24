/**
 * A medicine box's fields as a person or a scanner gives them.
 *
 * What a box's code says (`docs/TASKS.md` F1.7). The karekod is a GS1
 * DataMatrix carrying the GTIN (AI 01), expiry (17), lot (10) and serial (21);
 * the plain barcode is the GTIN alone. Read on the phone and never checked
 * against İTS.
 *
 * Scanners differ in what they keep of the symbol: some prefix the symbology
 * identifier, some keep the leading FNC1 as a GS, and some lose the GS that
 * ends a variable field. Each is tolerated; the order of the fields is free.
 */

export interface BoxCode {
  /** Always 14 digits, so a box's barcode and its karekod name one product. */
  gtin: string;
  /** A local day, `YYYY-MM-DD`. */
  expiresOn: string | null;
  lot: string | null;
  serial: string | null;
}

const GS = "\u001d";
const FIXED: Readonly<Record<string, number>> = { "01": 14, "11": 6, "17": 6 };
const VARIABLE = new Set(["10", "21"]);
/** GS1's ceiling for a lot or a serial, which the server holds too. */
const VARIABLE_MAX = 20;

/** GS1's mod-10 check: weights 3, 1, 3… leftwards from the digit before the check digit. */
function checks(digits: string): boolean {
  let sum = 0;
  for (let back = 1; back < digits.length; back++) sum += Number(digits.at(-1 - back)) * (back % 2 === 1 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** A GTIN of 8, 12, 13 or 14 digits as the 14 a karekod carries; `null` for anything else. */
export function normalGtin(text: string): string | null {
  const digits = text.trim();
  if (!/^(?:\d{8}|\d{12,14})$/.test(digits) || !checks(digits)) return null;
  return digits.padStart(14, "0");
}

/** A GTIN-14 as the box prints it: a 13-digit barcode carries one leading zero more. */
export function printedGtin(gtin: string): string {
  return gtin.startsWith("0") ? gtin.slice(1) : gtin;
}

/** GS1's `YYMMDD`, this century's years; day `00` is the month's last. */
function day(yymmdd: string): string | null {
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const date = Number(yymmdd.slice(4, 6)) || last;
  if (date > last) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

/**
 * The fields from `from` on, or `null` when the text there is not a run of
 * fields this reader knows. An unknown AI ends the run, and what came before
 * it stands, unless `whole` asks for every character to be read.
 */
function fields(text: string, from: number, whole: boolean): Map<string, string> | null {
  const found = new Map<string, string>();
  let at = from;
  while (at < text.length) {
    if (text[at] === GS) {
      at++;
      continue;
    }
    const ai = text.slice(at, at + 2);
    const length = FIXED[ai];
    if (length) {
      const value = text.slice(at + 2, at + 2 + length);
      if (!/^\d+$/.test(value) || value.length !== length || (ai !== "01" && !day(value))) return null;
      found.set(ai, value);
      at += 2 + length;
    } else if (VARIABLE.has(ai)) {
      const end = variableEnd(text, at + 2);
      found.set(ai, text.slice(at + 2, end));
      at = end;
    } else {
      return whole ? null : found;
    }
  }
  return found;
}

/**
 * Where a lot or serial ends: at its GS; with the GS lost, where the rest
 * reads whole as fields, or else at the end of the text.
 */
function variableEnd(text: string, from: number): number {
  const separator = text.indexOf(GS, from);
  if (separator !== -1) return separator;
  // At the text's end the rest is no fields, which reads whole: the field runs to the end.
  for (let at = from + 1; at <= from + VARIABLE_MAX; at++) {
    if (fields(text, at, true)) return at;
  }
  return text.length;
}

/** A scanned code as a box's fields, or `null` when it is no medicine code this reader can trust. */
export function readBoxCode(raw: string): BoxCode | null {
  const text = raw.trim().replace(/^\][A-Za-z]\d/, "");
  const plain = normalGtin(text);
  if (plain) return { gtin: plain, expiresOn: null, lot: null, serial: null };
  const found = fields(text, 0, false);
  if (!found) return null;
  const gtin = normalGtin(String(found.get("01")));
  if (!gtin) return null;
  const lot = found.get("10") || null;
  const serial = found.get("21") || null;
  if ((lot?.length ?? 0) > VARIABLE_MAX || (serial?.length ?? 0) > VARIABLE_MAX) return null;
  const expiry = found.get("17");
  return { gtin, expiresOn: expiry ? day(expiry) : null, lot, serial };
}

/** A box holds at most a million of its unit; more is a typing slip, and the server refuses it. */
export const AMOUNT_MAX_MILLI = 1_000_000_000;

/**
 * A typed amount in thousandths of the unit: `2,5` or `2.5` is 2500. `null`
 * for what is not a number of at most three decimals, or past the ceiling.
 */
export function parseAmount(text: string): number | null {
  const match = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!match) return null;
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return milli <= AMOUNT_MAX_MILLI ? milli : null;
}

/** Thousandths of a unit as a person writes them: 2500 is `2,5`. */
export function formatAmount(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const rest = String(Math.abs(milli) % 1000).padStart(3, "0").replace(/0+$/, "");
  return rest ? `${whole},${rest}` : String(whole);
}

function calendarDay(year: number, month: number, date: number | null): string | null {
  if (year < 2000 || year > 2099 || month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const chosen = date ?? last;
  if (chosen < 1 || chosen > last) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(chosen).padStart(2, "0")}`;
}

/**
 * A typed day as `YYYY-MM-DD`. A box prints its expiry as a month or a day:
 * `03/2027` is the month's last day, `31.03.2027` that day; `2027-03` and
 * `2027-03-31` read too. `null` for anything not on the calendar.
 */
export function parseDay(text: string): string | null {
  const typed = text.trim();
  const local = /^(?:(\d{1,2})[./-])?(\d{1,2})[./-](\d{4})$/.exec(typed);
  if (local) return calendarDay(Number(local[3]), Number(local[2]), local[1] ? Number(local[1]) : null);
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(typed);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), iso[3] ? Number(iso[3]) : null);
  return null;
}

/** `YYYY-MM-DD` as a Turkish reader writes it: `31.03.2027`. */
export function formatDay(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

/** Today on the device's own calendar, as `YYYY-MM-DD`: an expiry is a local day. */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Days from `today` to `day`, both `YYYY-MM-DD`; negative once it has passed. */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** How near a box's expiry is: within `SOON_DAYS` is soon, the day itself still good. */
export const SOON_DAYS = 30;
export type ExpiryState = "expired" | "soon" | "ok" | "unknown";

export function expiryState(expiresOn: string | null, today: string, soonDays = SOON_DAYS): ExpiryState {
  if (!expiresOn) return "unknown";
  const left = daysUntil(expiresOn, today);
  return left < 0 ? "expired" : left <= soonDays ? "soon" : "ok";
}

/** The most days of notice ahead of an expiry the server takes: a year. */
export const WARN_DAYS_MAX = 365;

/** A number of days as typed: a whole number from one up to `most`, ten years unless said. */
export function parseDays(text: string, most = 3650): number | null {
  const typed = text.trim();
  // `Number` alone takes "1e3" and "0x1C".
  const days = /^\d{1,4}$/.test(typed) ? Number(typed) : 0;
  return days >= 1 && days <= most ? days : null;
}

/** An opened box is good for weeks, not months: thirty days' notice would warn the day a drop bottle is opened. */
export const OPENED_SOON_DAYS = 7;

/** The last day an opened box is good for, the day it was opened being its first; none until both are known. */
export function lastOpenDay(openedOn: string | null, useWithinDays: number | null): string | null {
  if (!openedOn || useWithinDays == null) return null;
  return new Date(Date.parse(`${openedOn}T00:00:00Z`) + (useWithinDays - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** What the cabinet list reads a box by. Open, empty and expired are worked out; only why a box left is stored. */
export interface BoxFacts {
  expiresOn: string | null;
  /** How many days ahead its expiry is near: its own, else its owner's; none is `SOON_DAYS`. */
  soonDays: number | null;
  openedOn: string | null;
  useWithinDays: number | null;
  lowMilli: number | null;
  remainingMilli: number;
  counted: boolean;
  disposition: string | null;
}

const WORST_FIRST: readonly ExpiryState[] = ["expired", "soon", "ok", "unknown"];

/** The nearer of a box's two ends: its printed expiry, and its last day once opened. */
export function boxExpiry(box: Pick<BoxFacts, "expiresOn" | "soonDays" | "openedOn" | "useWithinDays">, today: string): ExpiryState {
  const printed = expiryState(box.expiresOn, today, box.soonDays ?? SOON_DAYS);
  const opened = expiryState(lastOpenDay(box.openedOn, box.useWithinDays), today, OPENED_SOON_DAYS);
  return WORST_FIRST.find((state) => state === printed || state === opened)!;
}

export const BOX_VIEWS = ["home", "open", "unopened", "low", "empty", "soon", "expired", "undated", "gone"] as const;
export type BoxView = (typeof BOX_VIEWS)[number];

export const isEmpty = (box: BoxFacts) => box.counted && box.remainingMilli === 0;
export const isLow = (box: BoxFacts) => box.counted && box.remainingMilli > 0 && box.remainingMilli <= (box.lowMilli ?? 0);

/** Every view but "gone" is of the boxes still at home. */
const VIEWS: Record<Exclude<BoxView, "home" | "gone">, (box: BoxFacts, today: string) => boolean> = {
  open: (box) => box.openedOn != null && !isEmpty(box),
  unopened: (box) => box.openedOn == null,
  low: isLow,
  empty: isEmpty,
  soon: (box, today) => boxExpiry(box, today) === "soon",
  expired: (box, today) => boxExpiry(box, today) === "expired",
  undated: (box) => box.expiresOn == null,
};

export function inView(view: BoxView, box: BoxFacts, today: string): boolean {
  if (view === "gone") return box.disposition != null;
  return box.disposition == null && (view === "home" || VIEWS[view](box, today));
}

/**
 * The key a search compares: case, Turkish marks and spacing folded away, so
 * "İBUPROFEN", "ibuprofen" and "Ibuprofen" are one. Gital's `foldName`.
 */
export function foldName(name: string): string {
  return name
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** With fewer letters, one slip would match half the cabinet: "par" is Parol as much as Majezik's "mar". Gital's. */
export const TYPO_FROM = 4;

/**
 * Whether two strings are one letter apart at most: one changed, missing,
 * extra, or two swapped. Gital's, read from where they first differ: what
 * follows must then be the same.
 */
export function nearly(a: string, b: string): boolean {
  if (a === b) return true;
  let at = 0;
  while (a[at] === b[at]) at++;
  const rest = (skipA: number, skipB: number) => a.slice(at + skipA) === b.slice(at + skipB);
  return rest(1, 1) || rest(1, 0) || rest(0, 1) || (a[at] === b[at + 1] && a[at + 1] === b[at] && rest(2, 2));
}

/** Whether a word begins with what is typed but for one slip, however long that makes its start. Gital's. */
function nearlyBegins(word: string, typed: string): boolean {
  return [typed.length - 1, typed.length, typed.length + 1].some((length) => nearly(word.slice(0, length), typed));
}

/**
 * Whether every word typed is in one of the product's names or its barcode,
 * in any order: "parol 500" finds "Parol 500 mg Tablet". A printed 13-digit
 * barcode is inside the stored GTIN-14. A word of `TYPO_FROM` letters or more
 * also finds a word it begins but for one slip: "majezk" finds Majezik.
 */
export function matchesSearch(fields: readonly (string | null | undefined)[], query: string): boolean {
  const haystack = foldName(fields.join(" "));
  const words = haystack.split(" ");
  return foldName(query)
    .split(" ")
    .every((typed) => haystack.includes(typed) || (typed.length >= TYPO_FROM && words.some((word) => nearlyBegins(word, typed))));
}

export type ProductSort = "expiry" | "name" | "added" | "amount" | "owner";

interface SortedBox {
  id: string;
  expiresOn: string | null;
  remainingMilli: number;
  counted: boolean;
  personId: string | null;
}

const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name, "tr");

/**
 * Products in a sort's order, each read by the boxes it shows: soonest
 * expiry, newest box, least left of what was counted, or its first owner by
 * name. What is not known goes last; a tie, and the name sort, go by name.
 */
export function sortProducts<P extends { name: string; boxes: readonly SortedBox[] }>(products: readonly P[], sort: ProductSort, ownerOf: (personId: string | null) => string | undefined): P[] {
  const soonest = (product: P) => product.boxes.map((box) => box.expiresOn ?? "9999-12-31").sort()[0]!;
  // A box's id is a uuidv7, minted when it was added, so the newest is the greatest.
  const newest = (product: P) => String(product.boxes.map((box) => box.id).sort().at(-1));
  const counted = (product: P) => {
    const boxes = product.boxes.filter((box) => box.counted);
    // Two unknowns differ by NaN, which ties like 0.
    return boxes.length > 0 ? boxes.reduce((sum, box) => sum + box.remainingMilli, 0) : Infinity;
  };
  const owner = (product: P) => product.boxes.flatMap((box) => ownerOf(box.personId) ?? []).sort((x, y) => x.localeCompare(y, "tr"))[0];
  const compare: Record<ProductSort, (a: P, b: P) => number> = {
    expiry: (a, b) => soonest(a).localeCompare(soonest(b)),
    name: byName,
    added: (a, b) => newest(b).localeCompare(newest(a)),
    amount: (a, b) => counted(a) - counted(b),
    owner: (a, b) => {
      const [x, y] = [owner(a), owner(b)];
      return Number(x === undefined) - Number(y === undefined) || String(x).localeCompare(String(y), "tr");
    },
  };
  return [...products].sort((a, b) => compare[sort](a, b) || byName(a, b));
}

/**
 * A word of a strength: a number, a percentage, a unit, a unit per amount
 * ("MG/2"), or a number with its unit on it ("10MG"), as TİTCK writes them;
 * grams also as GR, units also as I.U.
 */
const BARE = /^\d[\d.,]*$/u;
const UNIT = "(?:MCG|MG|µG|GR|G|ML|L|M?I\\.?U\\.?|DOZ)(?:\\/[\\d.,]*(?:MCG|MG|GR|G|ML|L|DOZ)?)?";
const STRENGTH_WORD = new RegExp(`^(?:%?\\d[\\d.,]*(?:${UNIT})?%?\\+?|%|\\+|\\/|${UNIT})$`, "iu");
// TİTCK writes a Latin name's i as a plain I ("MAJEZIK"), so an I lowers to i, not to a dotless ı.
const lowered = (words: string) => words.replace(/İ/g, "i").toLowerCase();
const titled = (words: string) => lowered(words).replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toLocaleUpperCase("tr-TR"));
const lower = (words: string) => lowered(words) || null;

/** A bare number after the strength's unit, before a word that is none: the pack's count, "200 MG 25 TABLET" (478 of the list's names). */
const isCount = (words: readonly string[], at: number, first: number) =>
  at > first && BARE.test(words[at]!) && /[a-zµ]/iu.test(words[at - 1]!) && !STRENGTH_WORD.test(words[at + 1]!);

/**
 * A catalogue name split into the form's fields (F1.10): "PAROL 500 MG
 * TABLET, 20 ADET" is Parol, 500 mg, tablet, 20 adet. The name is the words
 * before the first number or percentage; the strength the number and unit
 * words that follow, only if a unit or a percentage is among them; the form
 * the rest; the pack what follows the last comma, or a closing parenthesis.
 * A name that begins with its strength stays whole: there is no name to cut.
 */
export function catalogueFields(listed: string): { name: string; strength: string | null; form: string | null; pack: string | null } {
  // Untrimmed: the list's names arrive trimmed (`text` in scripts/import-catalogue.mjs), and each part cut from one is trimmed again.
  const text = listed.replace(/\s+/g, " ");
  // The pack is optional, so this matches every text, and lazily from its first letter: no `^` to hold it there.
  const [, before, comma, bracket] = /(.*?)(?:, ([^,]+)|\s*\(([^()]+)\))?$/u.exec(text)!;
  const packed = comma ?? bracket;
  const head = before!.trim() || text;
  const pack = packed ? lower(packed.trim()) : null;
  const words = head.split(" ");
  const first = words.findIndex((word) => /^[%\d]/u.test(word));
  if (first <= 0) return { name: titled(head), strength: null, form: null, pack };
  let end = first;
  // Past the last word the test reads `undefined` as text, which is no strength word.
  while (STRENGTH_WORD.test(words[end]!) && !isCount(words, end, first)) end++;
  const measured = words.slice(first, end);
  const hasUnit = measured.some((word) => /%|[a-zµ]/iu.test(word));
  const count = isCount(words, end, first) ? words[end]! : null;
  const form = words.slice(count ? end + 1 : hasUnit ? end : first).join(" ");
  return {
    name: titled(words.slice(0, first).join(" ")),
    // "500MG" reads as "500 mg", so two medicines' strengths compare as written alike.
    strength: hasUnit ? lowered(measured.join(" ")).replace(/(\d)(?=(?:mcg|mg|µg|gr|g|ml|l|m?i\.?u\.?|doz)(?![a-zµ]))/gu, "$1 ") : null,
    form: lower(form),
    pack: pack ?? (count ? lower(`${count} ${form}`.trim()) : null),
  };
}
