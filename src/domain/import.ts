/**
 * A file of boxes added at once (`docs/TASKS.md` F1.13): a CSV as a
 * spreadsheet saves it — comma, semicolon or tab — or a JSON list of objects,
 * one box a row. Columns are found by their header, Turkish or English, in any
 * order; a header this reader does not know is named back and left out.
 */

import { foldName, parseAmount, parseDay, readBoxCode } from "./boxes";

export const IMPORT_FIELDS = [
  "name",
  "brand",
  "activeSubstance",
  "strength",
  "form",
  "pack",
  "manufacturer",
  "barcode",
  "unit",
  "expiresOn",
  "openedOn",
  "amount",
  "person",
  "place",
  "serial",
  "lot",
  "nickname",
  "note",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Headers by their folded spelling. "Adet" is a unit, so it names no column. */
const HEADERS: Readonly<Record<string, ImportField>> = {
  ad: "name", ilac: "name", "ilac adi": "name", urun: "name", "urun adi": "name", name: "name",
  marka: "brand", brand: "brand",
  "etken madde": "activeSubstance", "etkin madde": "activeSubstance", substance: "activeSubstance", "active substance": "activeSubstance",
  guc: "strength", strength: "strength",
  form: "form",
  ambalaj: "pack", pack: "pack",
  uretici: "manufacturer", "ruhsat sahibi": "manufacturer", manufacturer: "manufacturer",
  barkod: "barcode", karekod: "barcode", gtin: "barcode", barcode: "barcode",
  birim: "unit", unit: "unit",
  skt: "expiresOn", "son kullanma": "expiresOn", "son kullanma tarihi": "expiresOn", expiry: "expiresOn",
  acilma: "openedOn", "acilma tarihi": "openedOn", opened: "openedOn",
  miktar: "amount", kalan: "amount", amount: "amount", quantity: "amount",
  kisi: "person", sahip: "person", kimin: "person", person: "person", owner: "person",
  yer: "place", konum: "place", place: "place", location: "place",
  seri: "serial", "seri no": "serial", serial: "serial",
  parti: "lot", "parti no": "lot", lot: "lot",
  "takma ad": "nickname", nickname: "nickname",
  not: "note", note: "note",
};

/** The server's ceiling for each text, so a row it would refuse is caught here, where it can be fixed. */
const LONGEST: Readonly<Partial<Record<ImportField, number>>> = {
  name: 200, brand: 200, activeSubstance: 500, strength: 100, form: 100, pack: 100, manufacturer: 200,
  person: 80, place: 80, serial: 20, lot: 20, nickname: 80, note: 2000,
};

/** More rows than a household's cabinet holds is a file of something else. */
export const IMPORT_MAX_ROWS = 2000;

export type ImportRaw = Partial<Record<ImportField, string>>;

export type ImportFile =
  | { ok: true; rows: ImportRaw[]; ignored: string[] }
  | { ok: false; reason: "unreadable" | "noName" | "empty" | "tooMany" };

// Folding collapses the spaces punctuation leaves.
const columnOf = (header: string) => HEADERS[foldName(header.replace(/[^\p{L}\p{N}]/gu, " "))];

/** The records of a CSV, quotes and doubled quotes as a spreadsheet writes them, a newline inside quotes kept. */
function records(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[at + 1] === '"') cell += text[++at];
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      rows.push([...row, cell]);
      row = [];
      cell = "";
    } else cell += char; // a CR before the newline is trimmed with the cell
  }
  rows.push([...row, cell]);
  return rows.filter((each) => each.some((value) => value.trim() !== ""));
}

/** The separator the header line uses most; a Turkish spreadsheet writes `;`, since `,` is its decimal mark. */
function separatorOf(text: string): string {
  const header = text.split("\n", 1)[0]!;
  return [";", ",", "\t"].reduce((best, each) => (header.split(each).length > header.split(best).length ? each : best));
}

function table(headers: readonly string[], cells: readonly (readonly string[])[]): ImportFile {
  const fields = headers.map(columnOf);
  if (!fields.includes("name")) return { ok: false, reason: "noName" };
  if (cells.length === 0) return { ok: false, reason: "empty" };
  if (cells.length > IMPORT_MAX_ROWS) return { ok: false, reason: "tooMany" };
  const rows = cells.map((values) => {
    const raw: ImportRaw = {};
    // A header named twice: the first column with a value is the one read.
    fields.forEach((field, at) => {
      const value = values[at]?.trim();
      if (field && value && raw[field] == null) raw[field] = value;
    });
    return raw;
  });
  return { ok: true, rows, ignored: headers.filter((header, at) => header.trim() && !fields[at]) };
}

/** A file's rows by column, or why it cannot be read as boxes. */
export function readImportFile(text: string): ImportFile {
  // `trim` takes a BOM with the spaces.
  const body = text.trim();
  if (body.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    const objects = (parsed as unknown[]).filter((each): each is Record<string, unknown> => typeof each === "object" && each != null && !Array.isArray(each));
    if (objects.length !== (parsed as unknown[]).length) return { ok: false, reason: "unreadable" };
    const headers = [...new Set(objects.flatMap(Object.keys))];
    const cell = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
    return table(headers, objects.map((object) => headers.map((header) => cell(object[header]))));
  }
  const [headers, ...cells] = records(body, separatorOf(body));
  return headers ? table(headers, cells) : { ok: false, reason: "empty" };
}

export interface ImportedBox<U extends string> {
  product: { name: string; brand: string | null; activeSubstance: string | null; strength: string | null; form: string | null; pack: string | null; manufacturer: string | null; gtin: string | null };
  box: { unit: U; expiresOn: string | null; openedOn: string | null; serial: string | null; lot: string | null; nickname: string | null; note: string | null };
  amountMilli: number;
  person: string | null;
  place: string | null;
}

export type ImportCheck<U extends string> = { box: ImportedBox<U>; problems: [] } | { box: null; problems: ImportField[] };

const text = (raw: ImportRaw, field: ImportField) => raw[field]?.trim() || null;
const codeOf = (raw: ImportRaw) => (text(raw, "barcode") ? readBoxCode(String(raw.barcode)) : null);
const dayOf = (raw: ImportRaw, field: "expiresOn" | "openedOn") => (text(raw, field) ? parseDay(String(raw[field])) : null);
const amountOf = (raw: ImportRaw) => (text(raw, "amount") ? parseAmount(String(raw.amount)) : 0);
const unitOf = <U extends string>(raw: ImportRaw, units: readonly [U, ...U[]]) =>
  text(raw, "unit") ? units.find((each) => foldName(each) === foldName(String(raw.unit))) : units[0];

/** The fields of a row the cabinet cannot take, each once. */
function problemsOf<U extends string>(raw: ImportRaw, units: readonly [U, ...U[]]): ImportField[] {
  const given = (field: ImportField) => text(raw, field) != null;
  const refused: readonly [ImportField, boolean][] = [
    ["name", !given("name")],
    ["barcode", given("barcode") && !codeOf(raw)],
    ["unit", !unitOf(raw, units)],
    ["expiresOn", given("expiresOn") && !dayOf(raw, "expiresOn")],
    ["openedOn", given("openedOn") && !dayOf(raw, "openedOn")],
    ["amount", amountOf(raw) == null],
  ];
  const tooLong = IMPORT_FIELDS.filter((field) => (raw[field]?.trim().length ?? 0) > (LONGEST[field] ?? Infinity));
  return [...new Set([...tooLong, ...refused.filter(([, no]) => no).map(([field]) => field)])];
}

const NO_CODE = { gtin: null, expiresOn: null, lot: null, serial: null };

/**
 * One row as a box, or the fields that keep it from being one. A barcode cell
 * may hold a whole karekod: its expiry, lot and serial fill the cells left
 * empty. A unit left empty is the first of `units`; an amount left empty is
 * none counted.
 */
export function checkImportRow<U extends string>(raw: ImportRaw, units: readonly [U, ...U[]]): ImportCheck<U> {
  const problems = problemsOf(raw, units);
  if (problems.length > 0) return { box: null, problems };
  const code = codeOf(raw) ?? NO_CODE;
  return {
    box: {
      product: {
        name: String(text(raw, "name")),
        brand: text(raw, "brand"),
        activeSubstance: text(raw, "activeSubstance"),
        strength: text(raw, "strength"),
        form: text(raw, "form"),
        pack: text(raw, "pack"),
        manufacturer: text(raw, "manufacturer"),
        gtin: code.gtin,
      },
      box: {
        unit: unitOf(raw, units)!,
        expiresOn: dayOf(raw, "expiresOn") ?? code.expiresOn,
        openedOn: dayOf(raw, "openedOn"),
        serial: text(raw, "serial") ?? code.serial,
        lot: text(raw, "lot") ?? code.lot,
        nickname: text(raw, "nickname"),
        note: text(raw, "note"),
      },
      amountMilli: amountOf(raw)!,
      person: text(raw, "person"),
      place: text(raw, "place"),
    },
    problems: [],
  };
}

/** Which rows name a box an earlier row of the file already named, by GTIN and serial. */
export function repeatedInFile(boxes: readonly (ImportedBox<string> | null)[]): boolean[] {
  const seen = new Set<string>();
  return boxes.map((each) => {
    if (!each?.product.gtin || !each.box.serial) return false;
    const key = `${each.product.gtin}|${each.box.serial}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}
