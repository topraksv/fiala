/**
 * The write layer. Every write goes through
 * `writeRows`, which in one transaction upserts the row and queues its outbox
 * event, so the screen never waits on the network and sync never misses a
 * write. Deletes are tombstones, which is also what undo restores from.
 *
 * Rows carry no `user_id`: a device holds one account's rows, and the push
 * stamps the person on each (`docs/ARCHITECTURE.md`).
 */

import { getTableColumns } from "drizzle-orm";
import type { SQLiteBindValue } from "expo-sqlite";
import { getSqliteAsync, withTransaction } from "./client";
import { SYNCED_TABLES, type SyncedTableName } from "./schema";

export interface RowWrite {
  table: SyncedTableName;
  /** The whole row in Drizzle's camelCase shape, id included. */
  row: Record<string, unknown>;
}

/** A row as SQLite stores it, snake_case, taken before a delete so undo can restore it. */
export type RowSnapshot = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * camelCase write → snake_case stored row, every column named: the upsert
 * updates only what a write supplies, so a column left out would keep what a
 * revived row held before its delete — a row written again would come back
 * with its old note. Left out, a column takes its default.
 */
function toDbShape(table: SyncedTableName, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(SYNCED_TABLES[table]))) {
    const value = key in row ? row[key] : column.default;
    out[column.name] = value == null ? null : column.mapToDriverValue(value);
  }
  return out;
}

/** snake_case stored row → camelCase write shape. */
export function fromDbShape(table: SyncedTableName, dbRow: object): Record<string, unknown> {
  // `object`, because a typed SELECT result is an interface and TypeScript
  // will not pass one as an index signature; the one narrowing lives here.
  const source = dbRow as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(SYNCED_TABLES[table]))) {
    // Drizzle's own mapping, so a boolean stored as 1 is the `true` an edit compares it with.
    if (column.name in source) out[key] = source[column.name] == null ? null : column.mapFromDriverValue(source[column.name]);
  }
  return out;
}

/**
 * A delete moves the generation on by exactly one; an edit or an undo keeps
 * the highest generation already seen. Kept here because it decides what a
 * write stores, and this layer may not import sync.
 */
function resolveTombstoneVersion(
  existing: { deletedAt: string | null; tombstoneVersion: number } | null,
  requestedDeletedAt: string | null,
  requestedVersion: number,
): number {
  if (!existing) return requestedDeletedAt ? Math.max(1, requestedVersion) : requestedVersion;
  const version = Math.max(existing.tombstoneVersion, requestedVersion);
  return requestedDeletedAt && existing.deletedAt == null ? version + 1 : version;
}

/** `created_at` is set once: an edit that re-supplied it would reset the row's age. */
const UPSERT_IMMUTABLE_COLUMNS = new Set(["id", "created_at"]);

function upsertSql(table: SyncedTableName, dbRow: Record<string, unknown>): { sql: string; args: SQLiteBindValue[] } {
  const keys = Object.keys(dbRow);
  const updates = keys
    .filter((key) => !UPSERT_IMMUTABLE_COLUMNS.has(key))
    .map((key) => `${key} = excluded.${key}`)
    .join(", ");
  return {
    sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
    args: keys.map((key) => dbRow[key] as SQLiteBindValue),
  };
}

type ExistingRow = { deleted_at: string | null; tombstone_version: number };

let localWriteListener: (() => void) | null = null;

/** Told after every write that queued something; sync sets it, since this layer may not import sync. */
export function onLocalWrite(listener: () => void): void {
  localWriteListener = listener;
}

/**
 * Upsert each row and queue its outbox event, all in one transaction. A write
 * that depends on what is stored passes a function: it reads inside the same
 * transaction, so no other local write can land between its read and the
 * commit, and it refuses by throwing.
 */
export async function writeRows(writes: readonly RowWrite[] | (() => Promise<readonly RowWrite[]>)): Promise<void> {
  const sqlite = await getSqliteAsync();
  let queued = 0;
  await withTransaction(async () => {
    for (const { table, row } of typeof writes === "function" ? await writes() : writes) {
      queued += 1;
      const id = row.id;
      if (typeof id !== "string" || id === "") throw new Error(`Write row id is invalid in ${table}`);
      const existing = await sqlite.getFirstAsync<ExistingRow>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
      const timestamp = nowIso();
      const deletedAt = "deletedAt" in row ? ((row.deletedAt as string | null | undefined) ?? null) : (existing?.deleted_at ?? null);
      const requestedVersion = Number.isSafeInteger(row.tombstoneVersion) && Number(row.tombstoneVersion) >= 0
        ? Number(row.tombstoneVersion)
        : 0;
      const dbRow = toDbShape(table, {
        ...row,
        createdAt: row.createdAt ?? timestamp,
        updatedAt: timestamp,
        deletedAt,
        tombstoneVersion: resolveTombstoneVersion(
          existing ? { deletedAt: existing.deleted_at, tombstoneVersion: existing.tombstone_version } : null,
          deletedAt,
          requestedVersion,
        ),
      });
      const { sql, args } = upsertSql(table, dbRow);
      await sqlite.runAsync(sql, args);
      // The same row written twice in one millisecond shares a key; the newer
      // payload replaces the older, or the stale one would be pushed and echoed
      // back over the edit. The table is in the key because the index is global.
      await sqlite.runAsync(
        `INSERT INTO outbox (table_name, row_id, op, payload, idempotency_key, created_at)
         VALUES (?, ?, 'upsert', ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
        [table, id, JSON.stringify(dbRow), `${table}:${id}:${timestamp}`, timestamp],
      );
    }
  });
  if (queued > 0) localWriteListener?.();
}

/**
 * The write an edit makes: the whole stored row with `patch` over it, or none
 * when every patched column already holds its value. Nothing new is not an
 * edit: stamped as one, it would beat a real change made elsewhere under
 * last-writer-wins. The whole row, never the changed columns alone, because
 * the server may meet this event before it has the row.
 */
export function editRow(table: SyncedTableName, stored: RowSnapshot, patch: Record<string, unknown>): RowWrite[] {
  const row = fromDbShape(table, stored);
  return Object.entries(patch).every(([key, value]) => row[key] === value) ? [] : [{ table, row: { ...row, ...patch } }];
}

/** The row under `id`, live or a tombstone. */
export async function findRow(table: SyncedTableName, id: string): Promise<RowSnapshot | null> {
  const sqlite = await getSqliteAsync();
  return sqlite.getFirstAsync<RowSnapshot>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

async function findLiveRow(table: SyncedTableName, id: string): Promise<RowSnapshot | null> {
  const row = await findRow(table, id);
  return row?.deleted_at == null ? row : null;
}

/** What undoing a write needs: each row it wrote, and that row as it was before, or `null` when it made it. */
export interface RowsWritten {
  writes: readonly RowWrite[];
  before: readonly (RowSnapshot | null)[];
}

/** `writeRows`, keeping each row as the transaction found it, for `revertRows`. */
async function writeUndoable(build: () => Promise<readonly RowWrite[]>): Promise<RowsWritten> {
  let written!: RowsWritten;
  await writeRows(async () => {
    const writes = await build();
    const before: (RowSnapshot | null)[] = [];
    for (const { table, row } of writes) before.push(await findRow(table, String(row.id)));
    written = { writes, before };
    return writes;
  });
  return written;
}

/** Columns the write layer stamps; every other column is what the caller wrote. */
const STAMPED = new Set(["createdAt", "updatedAt", "tombstoneVersion"]);

/**
 * Undo a `writeUndoable` write: each row back as it was, and a row it made
 * tombstoned. Refused, whole, when any of them has changed since — a tick, an
 * edit, a sync — because the snapshot would overwrite the newer write. The
 * same row written twice in one write is refused too. `check` runs first, in
 * the same transaction.
 */
function revertRows({ writes, before }: RowsWritten, check: () => Promise<unknown>): Promise<void> {
  return writeRows(async () => {
    await check();
    const reverts: RowWrite[] = [];
    for (const [at, { table, row }] of writes.entries()) {
      const stored = await findRow(table, String(row.id));
      const current = stored && fromDbShape(table, stored);
      if (!current || !Object.entries(row).every(([key, value]) => STAMPED.has(key) || current[key] === value)) {
        throw new Error(`Cannot undo: the ${table} row has changed since`);
      }
      const was = before[at];
      reverts.push({ table, row: was ? fromDbShape(table, was) : { ...current, deletedAt: nowIso() } });
    }
    return reverts;
  });
}

/**
 * Tombstone rows in one write, for `revertRows` to take back whole; `null`
 * when every one was already gone. Each is read inside the transaction: read
 * before it, a write that landed in between would be reverted by this one.
 * What is gone is skipped rather than refused, since a selection outlives
 * the rows a sync takes from under it; an id named twice is written once,
 * because `revertRows` refuses the same row twice. The undo is refused once
 * any tombstone has changed, as any undo is, so it cannot overwrite a row
 * that came back another way.
 */
export async function deleteRows(table: SyncedTableName, ids: readonly string[]): Promise<RowsWritten | null> {
  const written = await writeUndoable(async () => {
    const deletedAt = nowIso();
    const writes: RowWrite[] = [];
    for (const id of new Set(ids)) {
      const live = await findLiveRow(table, id);
      if (live) writes.push({ table, row: { ...fromDbShape(table, live), deletedAt } });
    }
    return writes;
  });
  return written.writes.length > 0 ? written : null;
}

/** Take back a write that needs nothing else to be true. */
export function undoRows(written: RowsWritten): Promise<void> {
  return revertRows(written, async () => {});
}

/** Writes this device has made and the server has not yet taken. */
export async function pendingOutboxCount(): Promise<number> {
  const sqlite = await getSqliteAsync();
  return (await sqlite.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))?.n ?? 0;
}

/**
 * Every row this device holds, for a sign-out, a deleted account or another
 * account signing in. One transaction, so a failure leaves the
 * workspace whole and its account still signed in.
 */
export async function resetLocalWorkspace(): Promise<void> {
  const sqlite = await getSqliteAsync();
  // One script rather than a statement per table: on the web every call is a
  // round trip to the SQLite worker, and a sign-out waited on each of them.
  const tables = [...Object.keys(SYNCED_TABLES), "outbox", "sync_dead_letters", "sync_state"];
  await withTransaction(() => sqlite.execAsync(tables.map((table) => `DELETE FROM ${table};`).join("\n")));
}
