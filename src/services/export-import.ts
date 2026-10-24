/**
 * The JSON backup and the inventory workbook (`docs/TASKS.md` F4.3, F4.5),
 * Helix's `export-import.ts` on Fiala's cabinets: manual backup and restore,
 * not an integration. A backup holds the cabinets the person owns, their own
 * and the households they made, every row with its tombstones, so its rows
 * are each one's newest copy when it was written. A restore writes a row only
 * where the device's copy is older, only into a cabinet the person may write,
 * and all of it in one transaction or none.
 */

import { getSqliteAsync } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { fromDbShape, writeRows, type RowWrite } from "../db/mutations";
import type { SyncedTableName } from "../db/schema";
import { readHouseholds, writes, type CabinetBox, type CabinetProduct } from "../data/cabinet";
import { formatAmount, formatDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { toServerRow } from "../sync/rows";
import { UserFacingError } from "./picked-file";

const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 15 * 1024 * 1024;
const MAX_BACKUP_ROWS = 100_000;

/**
 * What a backup holds. Not the settings, which are a device's and hold the
 * health consent a restore must not give back; not the memberships, which
 * only the server writes; files stay in Storage, a row naming them.
 */
const BACKUP_TABLES = [
  "cabinets",
  "people",
  "locations",
  "tags",
  "products",
  "packages",
  "package_moves",
  "package_changes",
  "product_tags",
  "documents",
  "document_links",
  "dose_plans",
  "dose_logs",
] as const satisfies readonly SyncedTableName[];
type BackupTable = (typeof BACKUP_TABLES)[number];

/** A column naming a row of another table; a backup row may name only one the file or the device holds. */
const NAMES: Record<string, BackupTable> = {
  product_id: "products",
  package_id: "packages",
  document_id: "documents",
  person_id: "people",
  location_id: "locations",
  tag_id: "tags",
  plan_id: "dose_plans",
  move_id: "package_moves",
};

type Row = Record<string, unknown>;
export interface Backup {
  version: number;
  exportedAt: string;
  /** The account that wrote it: its own cabinet's id, which a restore into another account moves to its own. */
  account: string;
  tables: Partial<Record<BackupTable, Row[]>>;
}

type Reason = keyof typeof tr.backup.reasons;

/** Refuse the file, saying where: the table and the 1-based row are the file's own coordinates. */
function invalid(reason: Reason, table?: BackupTable, row = 0): never {
  throw new UserFacingError(table == null ? tr.backup.invalid(tr.backup.reasons[reason]) : tr.backup.invalidAt(tr.backup.tables[table], row + 1, tr.backup.reasons[reason]));
}

/** The cabinets a backup holds: the person's own, and each live household they made. */
const OWNED = "(cabinet_id = ? OR cabinet_id IN (SELECT id FROM cabinets WHERE owner_id = ? AND id <> owner_id AND deleted_at IS NULL))";

/** One table at a time into the text, so no table's rows outlive its turn. */
export async function buildBackupText(me: string): Promise<string> {
  const sqlite = await getSqliteAsync();
  const parts: string[] = [];
  let count = 0;
  for (const table of BACKUP_TABLES) {
    const rows = await sqlite.getAllAsync<Row>(
      table === "cabinets" ? "SELECT * FROM cabinets WHERE owner_id = ? AND id <> owner_id AND deleted_at IS NULL" : `SELECT * FROM ${table} WHERE ${OWNED}`,
      table === "cabinets" ? [me] : [me, me],
    );
    count += rows.length;
    if (count > MAX_BACKUP_ROWS) throw new UserFacingError(tr.backup.tooLarge);
    // An empty table is left out: a restore merges what is there, so absent and empty read alike.
    if (rows.length > 0) parts.push(`${JSON.stringify(table)}:${JSON.stringify(rows)}`);
  }
  const text = `{"version":${BACKUP_VERSION},"exportedAt":${JSON.stringify(new Date().toISOString())},"account":${JSON.stringify(me)},"tables":{${parts.join(",")}}}`;
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new UserFacingError(tr.backup.tooLarge);
  return text;
}

const isTimestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * The file, checked whole before anything is written: its envelope, then every
 * row as the server would take it (`toServerRow`: the schema's columns and
 * types, a uuid's shape), its timestamp and that no id comes twice.
 */
export function readBackup(text: string): Backup {
  if (text.length > MAX_BACKUP_BYTES) throw new UserFacingError(tr.backup.tooLarge);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid("json");
  }
  const backup = raw as Partial<Backup> | null;
  if (!backup || backup.version !== BACKUP_VERSION || !isTimestamp(backup.exportedAt) || typeof backup.account !== "string" || !backup.tables || typeof backup.tables !== "object") {
    invalid("envelope");
  }
  const known = new Set<string>(BACKUP_TABLES);
  if (Object.keys(backup.tables).some((table) => !known.has(table))) invalid("unknownTable");
  let count = 0;
  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table];
    if (rows == null) continue;
    if (!Array.isArray(rows)) invalid("shape", table);
    count += rows.length;
    if (count > MAX_BACKUP_ROWS) throw new UserFacingError(tr.backup.tooLarge);
    const ids = new Set<unknown>();
    rows.forEach((row: unknown, index) => {
      if (!row || typeof row !== "object" || !toServerRow(table, row as Row, backup.account!) || !isTimestamp((row as Row).updated_at)) invalid("shape", table, index);
      if (ids.has((row as Row).id)) invalid("duplicate", table, index);
      ids.add((row as Row).id);
    });
  }
  return backup as Backup;
}

/**
 * A backup moved to another account: its own cabinet's rows into this one's.
 * A product's id is a hash of its cabinet and GTIN, and a tag on it or a link
 * to it a hash of that id, so each is minted again for the new cabinet, and
 * every row naming one follows; an id is rewritten only where the old hash
 * proves what it was made of. Households stay where they are: the restore
 * writes into one only if the person may.
 */
export async function movedTo(backup: Backup, me: string): Promise<Backup["tables"]> {
  if (backup.account === me) return backup.tables;
  const from = backup.account;
  const renamed = new Map<string, string>();
  const own = (rows: Row[] | undefined) => (rows ?? []).filter((row) => row.cabinet_id === from);
  const remint = async (row: Row, before: string, after: string) => {
    if (row.id === (await deterministicId(before))) renamed.set(row.id as string, await deterministicId(after));
  };
  for (const product of own(backup.tables.products)) {
    if (typeof product.gtin === "string") await remint(product, naturalKeys.product(from, product.gtin), naturalKeys.product(me, product.gtin));
  }
  const now = (id: unknown) => renamed.get(id as string) ?? id;
  for (const tag of own(backup.tables.product_tags)) {
    await remint(tag, naturalKeys.productTag(tag.product_id as string, tag.tag_id as string), naturalKeys.productTag(now(tag.product_id) as string, tag.tag_id as string));
  }
  // A link is in its document's cabinet, which may be a household naming a product of the own one.
  for (const link of backup.tables.document_links ?? []) {
    const target = (link.product_id ?? link.package_id) as string;
    await remint(link, naturalKeys.documentLink(link.document_id as string, target), naturalKeys.documentLink(link.document_id as string, now(target) as string));
  }
  const tables: Backup["tables"] = {};
  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table];
    if (!rows) continue;
    tables[table] = rows.map((row) => {
      const moved: Row = { ...row, id: now(row.id), ...(row.cabinet_id === from && { cabinet_id: me }) };
      for (const column of Object.keys(NAMES)) if (column in moved) moved[column] = now(moved[column]);
      return moved;
    });
  }
  return tables;
}

type Held = Map<BackupTable, Map<string, { cabinetId: string; updatedAt: number }>>;

/** Every row the device holds, by table: its cabinet and when it last changed. */
async function heldRows(): Promise<Held> {
  const sqlite = await getSqliteAsync();
  const held: Held = new Map();
  for (const table of BACKUP_TABLES) {
    const rows = await sqlite.getAllAsync<{ id: string; cabinet_id: string; updated_at: string }>(`SELECT id, ${table === "cabinets" ? "id AS cabinet_id" : "cabinet_id"}, updated_at FROM ${table}`);
    held.set(table, new Map(rows.map((row) => [row.id, { cabinetId: row.cabinet_id, updatedAt: Date.parse(row.updated_at) }])));
  }
  return held;
}

interface Candidate {
  table: BackupTable;
  row: Row;
  /** Its place in the file's table, which a refusal names. */
  index: number;
}

/**
 * A row to be written may name only what the file or the device holds:
 * SQLite has no foreign keys, since tombstones sync. A row not written names
 * nothing here, so one of a household the device has not pulled refuses nothing.
 */
function checkNames(candidates: readonly Candidate[], tables: Backup["tables"], held: Held): void {
  const inFile = new Map(BACKUP_TABLES.map((table) => [table, new Set((tables[table] ?? []).map((row) => row.id))]));
  for (const { table, row, index } of candidates) {
    for (const [column, target] of Object.entries(NAMES)) {
      const id = row[column];
      if (typeof id === "string" && !held.get(target)!.has(id) && !inFile.get(target)!.has(id)) invalid("link", table, index);
    }
  }
}

export interface Restored {
  /** Rows written. */
  restored: number;
  /** Rows the device already holds as new or newer, or under another cabinet. */
  kept: number;
  /** Rows of a cabinet the person may not write: one they left, one deleted, one they only view. */
  closed: number;
}

/**
 * Restore a backup. A written row is a new write, stamped now and pushed, and
 * the server keeps the last push, so "older" is judged after a pull: without
 * it a device that had not pulled took back every edit made elsewhere since.
 * Offline the restore still runs, into the person's own cabinet alone, which
 * no other account writes; a household's rows wait for a pull.
 */
export async function restoreBackup(me: string, backup: Backup, pull: () => Promise<boolean>): Promise<Restored> {
  const pulled = await pull().catch(() => false);
  const households = await readHouseholds();
  const writable = (cabinetId: string) => cabinetId === me || (pulled && writes(households, me, cabinetId));
  const tables = await movedTo(backup, me);
  const held = await heldRows();
  const result: Restored = { restored: 0, kept: 0, closed: 0 };
  const candidates: Candidate[] = [];
  for (const table of BACKUP_TABLES) {
    for (const [index, row] of (tables[table] ?? []).entries()) {
      const cabinetId = (table === "cabinets" ? row.id : row.cabinet_id) as string;
      // A household is written back only by its owner, and never made again: a deleted one stays so. The person's own cabinet is the server's.
      if (!writable(cabinetId) || (table === "cabinets" && (row.owner_id !== me || cabinetId === me || !held.get(table)!.has(cabinetId)))) {
        result.closed += 1;
        continue;
      }
      const there = held.get(table)!.get(row.id as string);
      // The device's copy under another cabinet is another row, which this one would move.
      if (there && (there.cabinetId !== cabinetId || there.updatedAt >= Date.parse(row.updated_at as string))) {
        result.kept += 1;
        continue;
      }
      candidates.push({ table, row, index });
    }
  }
  checkNames(candidates, tables, held);
  result.restored = candidates.length;
  await writeRows(candidates.map(({ table, row }): RowWrite => ({ table, row: fromDbShape(table, row) })));
  return result;
}

/** A box's details that say whose it is and where it came from, each left out of a shared inventory at will (F4.3). */
export const PERSONAL_COLUMNS = ["person", "note", "serial", "source"] as const;
export type PersonalColumn = (typeof PERSONAL_COLUMNS)[number];

interface InventoryNames {
  households: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
  locations: ReadonlyMap<string, string>;
}

/**
 * The inventory as a sheet: one row per box still at home, in the cabinets
 * the device shows, its days as the app writes them. Cells stay strings, so a
 * day or a lot number never becomes an Excel number.
 */
export function inventoryGrid(products: readonly CabinetProduct[], names: InventoryNames, hidden: ReadonlySet<PersonalColumn>): string[][] {
  const columns: [header: string, cell: (product: CabinetProduct, box: CabinetBox) => string | null | undefined, personal?: PersonalColumn][] = [
    [tr.inventory.household, (product) => names.households.get(product.cabinetId) ?? tr.inventory.own],
    [tr.inventory.medicine, (product) => product.name],
    [tr.inventory.substance, (product) => product.activeSubstance],
    [tr.inventory.strength, (product) => product.strength],
    [tr.inventory.form, (product) => product.form],
    [tr.inventory.barcode, (product) => product.gtin],
    [tr.inventory.nickname, (_, box) => box.nickname],
    [tr.inventory.remaining, (_, box) => (box.counted ? `${formatAmount(box.remainingMilli)} ${tr.units[box.unit]}` : null)],
    [tr.inventory.expires, (_, box) => box.expiresOn && formatDay(box.expiresOn)],
    [tr.inventory.opened, (_, box) => box.openedOn && formatDay(box.openedOn)],
    [tr.inventory.place, (_, box) => box.locationId && names.locations.get(box.locationId)],
    [tr.inventory.person, (_, box) => box.personId && names.people.get(box.personId), "person"],
    [tr.inventory.note, (product, box) => [product.note, box.note].filter(Boolean).join(" · "), "note"],
    [tr.inventory.serial, (_, box) => [box.serial, box.lot].filter(Boolean).join(" · "), "serial"],
    [tr.inventory.source, (_, box) => [box.acquiredFrom, box.acquiredOn && formatDay(box.acquiredOn)].filter(Boolean).join(" · "), "source"],
  ];
  const shown = columns.filter(([, , personal]) => !personal || !hidden.has(personal));
  const rows = products.flatMap((product) => product.boxes.filter((box) => box.disposition == null).map((box) => shown.map(([, cell]) => cell(product, box) || "")));
  return [shown.map(([header]) => header), ...rows];
}

/** One sheet, sized and filtered as Helix's; `xlsx` is loaded here, by the person who exports. */
export async function workbookBytes(grid: string[][]): Promise<Uint8Array> {
  const xlsx = await import("xlsx");
  const sheet = xlsx.utils.aoa_to_sheet(grid);
  sheet["!cols"] = grid[0]!.map((_, column) => ({ wch: Math.min(46, Math.max(11, ...grid.map((row) => row[column]!.length + 2))) }));
  sheet["!autofilter"] = { ref: xlsx.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: grid.length - 1, c: grid[0]!.length - 1 } }) };
  const book = xlsx.utils.book_new();
  book.Props = { Title: "Fiala" };
  xlsx.utils.book_append_sheet(book, sheet, tr.inventory.sheet);
  return new Uint8Array(xlsx.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}
