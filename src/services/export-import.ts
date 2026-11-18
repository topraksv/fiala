/**
 * The backup and the inventory workbook (`docs/TASKS.md` F4.3, F4.5, F4.10),
 * Helix's `export-import.ts` on Fiala's cabinets: manual backup and restore,
 * not an integration. A backup holds the cabinets the person owns, their own
 * and the households they made, every row with its tombstones, so its rows
 * are each one's newest copy when it was written. A restore writes a row only
 * where the device's copy is older, only into a cabinet the person may write,
 * and all of it in one transaction or none.
 */

import { getSqliteAsync } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { fromDbShape, nowIso, writeRows, type RowWrite } from "../db/mutations";
import type { DocumentFileType, SyncedTableName } from "../db/schema";
import { readHouseholds, writes, type CabinetBox, type CabinetProduct } from "../data/cabinet";
import { DOCUMENT_BYTES, fileTypeOf } from "../data/documents";
import { formatAmount, formatDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { documentPath, fetchDocumentFile } from "../sync/documents";
import { base64Of, bytesOf, PHOTO_TABLES } from "../sync/photos";
import { toServerRow } from "../sync/rows";
import { getSupabase } from "../sync/supabase";
import { UserFacingError } from "./picked-file";

const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 15 * 1024 * 1024;
const MAX_BACKUP_ROWS = 100_000;

/**
 * What a backup holds. Not the settings, which are a device's and hold the
 * health consent a restore must not give back; not the memberships, which
 * only the server writes. Files go beside the rows in the archive (F4.10).
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

/** A column naming a file in Storage. */
const FILE_COLUMNS = ["photo_id", "file_id"] as const;

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
  // Storage holds a file under its sender, and a row may name only one its writer may (migration 23): it is sent again under an id of this account's.
  for (const table of BACKUP_TABLES) {
    for (const row of backup.tables[table] ?? []) {
      for (const column of FILE_COLUMNS) if (typeof row[column] === "string") renamed.set(row[column], await movedFileId(backup, me, row[column]));
    }
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
      for (const column of [...Object.keys(NAMES), ...FILE_COLUMNS]) if (column in moved) moved[column] = now(moved[column]);
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

/**
 * The id a backup's file takes in this account: its own where the backup is
 * this account's, else one minted from it, the same for its row and its
 * archive entry.
 */
const movedFileId = (backup: Backup, me: string, id: string) => (backup.account === me ? Promise.resolve(id) : deterministicId(`backup-file:${me}:${id}`));

const ARCHIVE_JSON = "backup.json";
/** A zip's end-of-directory record, with no comment after it. */
const END_BYTES = 22;
/** A photo is two shrunk JPEGs (`src/data/photos.ts`); one far past this is not Fiala's. */
const PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_ENTRY = /^photos\/([0-9a-f-]{36})\/(full|thumb)\.jpg$/;
const DOCUMENT_ENTRY = /^documents\/([0-9a-f-]{36})\.(pdf|jpeg)$/;
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
/** The photos a live row names on the device, as `src/sync/photos.ts` asks. */
const NAMED_PHOTOS = [...PHOTO_TABLES].map((table) => `SELECT photo_id FROM ${table} WHERE deleted_at IS NULL`).join(" UNION ");

/** Each file a live row of the backup names, once. */
function namedFiles(tables: Backup["tables"]): { photos: Set<string>; documents: Map<string, DocumentFileType> } {
  const photos = new Set<string>();
  for (const table of BACKUP_TABLES) {
    if (!PHOTO_TABLES.has(table)) continue;
    for (const row of tables[table] ?? []) if (row.deleted_at == null && typeof row.photo_id === "string") photos.add(row.photo_id);
  }
  const documents = new Map<string, DocumentFileType>();
  for (const row of tables.documents ?? []) if (row.deleted_at == null && typeof row.file_id === "string") documents.set(row.file_id, row.file_type as DocumentFileType);
  return { photos, documents };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc;
});

/** CRC-32 as a zip entry carries it. */
export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** Little-endian fields, each a value and its width in bytes. */
function fields(...values: readonly (readonly [number, 2 | 4])[]): Uint8Array {
  const bytes = new Uint8Array(values.reduce((sum, [, width]) => sum + width, 0));
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const [value, width] of values) {
    if (width === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += width;
  }
  return bytes;
}

/**
 * A zip of stored entries, each header stating its size and CRC. fflate's
 * streaming writer leaves both to a trailer, and a reader then finds an
 * entry's end by searching its bytes for a signature that a JPEG or a PDF can
 * hold: the file came back cut short, and nothing said so.
 */
function zipWriter(put: (chunk: Uint8Array) => Promise<void>) {
  const central: Uint8Array[] = [];
  let offset = 0;
  const write = async (chunk: Uint8Array) => {
    await put(chunk);
    offset += chunk.length;
  };
  return {
    async add(name: string, data: Uint8Array) {
      const path = new TextEncoder().encode(name);
      // Version 2.0, names in UTF-8, stored, dated 1980-01-01, then CRC and both sizes.
      const common = fields([20, 2], [0x0800, 2], [0, 2], [0, 2], [0x21, 2], [crc32(data), 4], [data.length, 4], [data.length, 4], [path.length, 2], [0, 2]);
      central.push(fields([0x02014b50, 4], [20, 2]), common, fields([0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]), path);
      await write(fields([0x04034b50, 4]));
      await write(common);
      await write(path);
      await write(data);
    },
    async end() {
      // Past these a zip needs Zip64, which this writer does not write: refused rather than wrapped.
      if (central.length / 4 > 0xffff || offset > 0xffffffff) throw new UserFacingError(tr.backup.tooLarge);
      const start = offset;
      for (const part of central) await write(part);
      const entries = central.length / 4;
      await write(fields([0x06054b50, 4], [0, 2], [0, 2], [entries, 2], [entries, 2], [offset - start, 4], [start, 4], [0, 2]));
    },
  };
}

/**
 * The backup with its files (F4.10): a zip of `backup.json`, then each photo
 * and document file a live row names, stored as they are, since a JPEG or a
 * PDF does not shrink. Written an entry at a time to `put`, so no more than
 * one file is held at once. A document's file is mostly not on the device
 * (it is fetched when opened), so it is fetched here and not kept; one that
 * neither the device nor Storage gives is counted in `missing`, never left
 * out unsaid.
 */
export async function writeBackupArchive(me: string, put: (chunk: Uint8Array) => Promise<void>): Promise<{ missing: number }> {
  const text = await buildBackupText(me);
  const { photos, documents } = namedFiles((JSON.parse(text) as Backup).tables);
  const zip = zipWriter(put);
  await zip.add(ARCHIVE_JSON, new TextEncoder().encode(text));
  const sqlite = await getSqliteAsync();
  let missing = 0;
  for (const id of photos) {
    const photo = await sqlite.getFirstAsync<{ data: string; thumb: string }>("SELECT data, thumb FROM photos WHERE id = ?", [id]);
    if (!photo) missing += 1;
    else {
      await zip.add(`photos/${id}/full.jpg`, bytesOf(photo.data));
      await zip.add(`photos/${id}/thumb.jpg`, bytesOf(photo.thumb));
    }
  }
  for (const [id, type] of documents) {
    const data = await fetchDocumentFile(id, type, false).catch(() => null);
    if (data) await zip.add(`documents/${id}.${type}`, bytesOf(data));
    else missing += 1;
  }
  await zip.end();
  return { missing };
}

export interface RestoredArchive extends Restored {
  /** Files written to the device. */
  files: number;
  /** Entries no live row names, past their bound, or not the file their name says. */
  skipped: number;
  /** The archive broke off after its rows were restored, so what followed is not here. */
  damaged: boolean;
}

/**
 * Restore an archive `writeBackupArchive` wrote, read a chunk at a time from
 * `next` (`null` at its end). `backup.json` comes first; once `accept` has
 * agreed to it, its rows are restored, and only then each file, so a file
 * lands only where a live row on the device names it, and the sweep, which
 * removes a file no row names, finds it named. Past that point nothing is
 * refused whole: the rows are in, so a broken rest is reported, not hidden
 * behind "not an archive".
 */
export async function restoreArchive(
  me: string,
  next: () => Promise<Uint8Array | null>,
  accept: (backup: Backup) => Promise<boolean>,
  pull: () => Promise<boolean>,
): Promise<RestoredArchive | null> {
  const { Unzip } = await import("fflate");
  const entries = readEntries(Unzip);
  let restored: RestoredArchive | null = null;
  let files: ReturnType<typeof fileSink> | null = null;
  try {
    for (;;) {
      const chunk = await next();
      for (const { name, bytes } of entries.push(chunk)) {
        if (files) {
          await files.take(name, bytes);
          continue;
        }
        if (name !== ARCHIVE_JSON) invalid("archive");
        if (!bytes) throw new UserFacingError(tr.backup.tooLarge);
        const backup = readBackup(new TextDecoder().decode(bytes));
        if (!(await accept(backup))) return null;
        restored = { ...(await restoreBackup(me, backup, pull)), files: 0, skipped: 0, damaged: false };
        files = fileSink(backup, me, restored);
      }
      if (chunk == null) break;
    }
  } catch (error) {
    if (!restored) throw error;
    restored.damaged = true;
    return restored;
  }
  if (!restored || !files) invalid("archive");
  files.end();
  // Cut where an entry ended, or followed by something else: nothing threw, but the directory is not there.
  if (!entries.whole()) restored.damaged = true;
  return restored;
}

/** Where a restore's files go once its rows are in, each counted as kept or skipped. */
function fileSink(backup: Backup, me: string, restored: RestoredArchive) {
  /** A full size waits for its thumbnail, which the writer puts right after it. */
  let waiting: { id: string; bytes: Uint8Array | null } | null = null;
  const tally = (kept: boolean) => {
    if (kept) restored.files += 1;
    else restored.skipped += 1;
  };
  return {
    async take(name: string, bytes: Uint8Array | null) {
      const photo = PHOTO_ENTRY.exec(name);
      if (!photo) return tally(await keepDocument(backup, me, DOCUMENT_ENTRY.exec(name), bytes));
      if (photo[2] === "full") {
        if (waiting) restored.skipped += 1;
        waiting = { id: photo[1]!, bytes };
        return;
      }
      const full = waiting && waiting.id === photo[1] ? waiting : null;
      if (full) waiting = null;
      tally(await keepPhoto(backup, me, photo[1]!, full?.bytes ?? null, bytes));
    },
    end() {
      if (waiting) restored.skipped += 1;
    },
  };
}

/**
 * A zip's entries, whole, as its chunks arrive. Only an entry whose header
 * states its size is read: its end is then counted, never searched for. One
 * past what it may be is passed over unheld, its bytes `null`.
 */
function readEntries(Unzip: typeof import("fflate").Unzip) {
  const done: { name: string; bytes: Uint8Array | null }[] = [];
  let seen = 0;
  /** The last bytes read, where the writer's end-of-directory record is. */
  let tail = new Uint8Array(0);
  const unzip = new Unzip((entry) => {
    seen += 1;
    // An entry squeezed by another tool, or one that leaves its size to a trailer.
    if (entry.size == null || entry.compression !== 0) invalid("archive");
    const bound = entry.name === ARCHIVE_JSON ? MAX_BACKUP_BYTES : entry.name.startsWith("photos/") ? PHOTO_BYTES : DOCUMENT_BYTES;
    const keep = entry.size <= bound;
    const parts: Uint8Array[] = [];
    entry.ondata = (error, part, final) => {
      if (error) throw error;
      if (keep) parts.push(part);
      if (final) done.push({ name: entry.name, bytes: keep ? joined(parts) : null });
    };
    entry.start();
  });
  return {
    push(chunk: Uint8Array | null) {
      if (chunk) tail = joined([tail, chunk.subarray(-END_BYTES)]).slice(-END_BYTES);
      try {
        unzip.push(chunk ?? new Uint8Array(0), chunk == null);
      } catch {
        invalid("archive");
      }
      return done.splice(0);
    },
    /** Whether the archive ended on its directory, naming as many entries as were read. */
    whole() {
      const view = new DataView(tail.buffer, tail.byteOffset);
      return view.getUint32(0, true) === 0x06054b50 && view.getUint16(10, true) === seen;
    },
  };
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/**
 * Write a restored file where a live row on the device names it. Into the
 * same account, one Storage already holds is written as sent: a household
 * member's file is theirs to place, and the person's own needs no second
 * upload. Anything else, or Storage unreachable, waits unsent.
 */
async function keepFile(backup: Backup, me: string, bucket: string, path: string, insert: (sentAt: string | null) => Promise<number>): Promise<boolean> {
  let sentAt: string | null = null;
  if (backup.account === me) {
    const held = await getSupabase()?.storage.from(bucket).exists(path).catch(() => null);
    if (held?.data === true) sentAt = nowIso();
  }
  return (await insert(sentAt)) > 0;
}

/** A photo where a live row names it and the device holds none of that id. */
async function keepPhoto(backup: Backup, me: string, entryId: string, full: Uint8Array | null, thumb: Uint8Array | null): Promise<boolean> {
  if (!full || !thumb || !isJpeg(full) || !isJpeg(thumb)) return false;
  const id = await movedFileId(backup, me, entryId);
  const sqlite = await getSqliteAsync();
  // The thumbnail is sent second, so with it in Storage the photo is whole there.
  return keepFile(backup, me, "photos", `${id}/thumb.jpg`, async (sentAt) => (await sqlite.runAsync(
    `INSERT OR IGNORE INTO photos (id, data, thumb, created_at, uploaded_at) SELECT ?, ?, ?, ?, ? WHERE ? IN (${NAMED_PHOTOS})`,
    [id, `data:image/jpeg;base64,${base64Of(full)}`, `data:image/jpeg;base64,${base64Of(thumb)}`, nowIso(), sentAt, id],
  )).changes);
}

/** A document's file where a live row names it as that type and its bytes say so too. */
async function keepDocument(backup: Backup, me: string, entry: RegExpExecArray | null, bytes: Uint8Array | null): Promise<boolean> {
  if (!entry || !bytes) return false;
  const base64 = base64Of(bytes);
  const type = entry[2] as DocumentFileType;
  if (fileTypeOf(base64) !== type) return false;
  const id = await movedFileId(backup, me, entry[1]!);
  const sqlite = await getSqliteAsync();
  return keepFile(backup, me, "documents", documentPath(id, type), async (sentAt) => (await sqlite.runAsync(
    `INSERT OR IGNORE INTO document_files (id, data, created_at, uploaded_at) SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM documents WHERE file_id = ? AND file_type = ? AND deleted_at IS NULL)`,
    [id, base64, nowIso(), sentAt, id, type],
  )).changes);
}
