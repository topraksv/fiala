/**
 * A row at the server boundary, both ways, checked against the columns
 * Drizzle declares rather than a second list of them: what the device sends
 * must be what its schema could have written, and what it takes must be what
 * its schema can hold. There are no per-table value checks: Postgres bounds
 * every value here.
 */

import { getTableColumns } from "drizzle-orm";
import { SYNCED_TABLES, type SyncedTableName } from "../db/schema";
import { isUuidShaped } from "./merge-policy";

/**
 * Every synced row is keyed by its person as well as its id on the server
 * (`00000000000003_sync.sql`): a row carries no `user_id` on the device, which
 * holds one account's workspace, and gets it here.
 */
export const keyColumns = (): readonly string[] => ["user_id", "id"];

interface Column {
  kind: "text" | "integer";
  notNull: boolean;
  /** What an insert naming the column not, or a migration adding it, gives a row. */
  empty: unknown;
}

const COLUMNS = new Map<SyncedTableName, Map<string, Column>>(
  (Object.keys(SYNCED_TABLES) as SyncedTableName[]).map((table) => [
    table,
    new Map(
      Object.values(getTableColumns(SYNCED_TABLES[table])).map((column) => [
        column.name,
        {
          kind: column.columnType === "SQLiteInteger" ? "integer" : "text",
          notNull: column.notNull,
          empty: column.default ?? null,
        },
      ]),
    ),
  ]),
);

function fits(column: Column, value: unknown): boolean {
  if (value == null) return !column.notNull;
  if (column.kind === "text") return typeof value === "string";
  return Number.isSafeInteger(value);
}

/**
 * An outbox payload as PostgREST takes it, or `null` for one the schema could
 * not have written. A column an event queued before it existed does not carry
 * is left out, never sent as its default: the server keeps what it holds,
 * which may be what another device wrote since (a photo, a receipt), and a new
 * row takes the server's default. Every column the server has no default for
 * was there from the table's first migration, so every event carries it.
 *
 * `unpulled` names the columns a migration added before the pull after it
 * finished: a row holding such a column's empty value may hold it only
 * because the device has not pulled the row since, so it is left out too.
 */
export function toServerRow(
  table: SyncedTableName,
  payload: Record<string, unknown>,
  owner: string,
  unpulled: ReadonlySet<string> = new Set(),
): Record<string, unknown> | null {
  const columns = COLUMNS.get(table)!;
  if (Object.keys(payload).some((key) => !columns.has(key)) || !isUuidShaped(payload.id)) return null;
  const out: Record<string, unknown> = {};
  for (const [name, column] of columns) {
    if (!(name in payload)) {
      if (column.notNull && column.empty == null) return null;
      continue;
    }
    const value = payload[name];
    if (!fits(column, value)) return null;
    if (unpulled.has(name) && (value ?? null) === column.empty) continue;
    out[name] = value;
  }
  if (Number(out.tombstone_version) < 0) return null;
  out.user_id = owner;
  return out;
}

/** Postgres answers `…00.123456+00:00`; the device writes and compares `…00.123Z`. */
function canonicalTimestamp(value: unknown): unknown {
  if (value == null) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error("invalid server timestamp");
  return new Date(parsed).toISOString();
}

/**
 * A pulled or acknowledged row in the shape SQLite stores, or a throw that
 * keeps the whole page from landing. A column the device does not have — the
 * person's id, one a newer server added — is dropped; the
 * id becomes the pull's keyset cursor, so its shape is checked.
 */
export function toLocalRow(table: SyncedTableName, raw: Record<string, unknown>, owner: string): Record<string, unknown> {
  if (raw.user_id !== owner) throw new Error(`pull ${table}: another owner's row`);
  if (!isUuidShaped(raw.id) || typeof raw.updated_at !== "string") throw new Error(`pull ${table}: invalid server row`);
  const out: Record<string, unknown> = {};
  for (const [name, column] of COLUMNS.get(table)!) {
    if (!(name in raw)) continue;
    // Every `_at` column is a timestamptz on the server.
    const value = name.endsWith("_at") ? canonicalTimestamp(raw[name]) : raw[name];
    if (!fits(column, value)) throw new Error(`pull ${table}: invalid ${name}`);
    out[name] = value;
  }
  if (Number(out.tombstone_version) < 0) throw new Error(`pull ${table}: invalid tombstone_version`);
  return out;
}
