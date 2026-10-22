/**
 * The outbox engine (SPEC 3.1): push, then pull, one run at a time, last
 * writer wins on the server's clock, a delete generation over any clock. A
 * failure is shown in the status store and retried with backoff; a late
 * answer from a session that has ended is dropped by the epoch.
 *
 * Beyond that (`docs/ARCHITECTURE.md`): a row is keyed by its person on the
 * server; a batch the server refuses is sent row by row, so one bad row waits
 * aside instead of stopping every other; a row this device made afresh over a
 * delete it never saw is added again rather than lost; and the pull reaches
 * back a few seconds past its cursor.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import { getSqliteAsync, withTransaction } from "../db/client";
import { fromDbShape, nowIso, onLocalWrite, writeRows, type RowWrite } from "../db/mutations";
import { SYNCED_TABLES, UNPULLED, type SyncedTableName } from "../db/schema";
import { tr } from "../i18n/tr";
import { retryDeadLetter } from "./dead-letters";
import {
  classifyOutboxBatch,
  cursorInstant,
  cursorIsAtServerHead,
  formatPullCursor,
  isAddedAgain,
  isUuidShaped,
  parsePullCursor,
  remoteWinsLww,
  shouldApplyServerAck,
  type OutboxEvent,
  type ParsedOutboxEvent,
  type PullCursor,
  type RejectedOutboxEvent,
} from "./merge-policy";
import { keyColumns, toLocalRow, toServerRow } from "./rows";
import { SessionEpoch, SessionEpochCancelledError, type SessionEpochToken } from "./session-epoch";
import { classifyRefreshFailure, completedSyncState, isNetworkFailure, useSyncStatus, type RefreshOutcome } from "./status";
import { getSupabase } from "./supabase";

const TABLES = Object.keys(SYNCED_TABLES) as SyncedTableName[];
const PULL_PAGE = 1000;
const PUSH_BATCH = 200;
/** Ids bound per statement: five of 200 prepare cheaper than one 1000-placeholder string. */
const ID_CHUNK = 200;
/**
 * How far before its cursor a table's pull starts. `updated_at` is when a
 * transaction began, not when it committed, so a row can become visible after
 * a later one has already moved the cursor past it. Re-reading five seconds
 * costs a few rows the merge takes again unchanged, and a late row is found at
 * its table's next change.
 */
const PULL_OVERLAP_MS = 5000;

type LocalDatabase = Awaited<ReturnType<typeof getSqliteAsync>>;

/** The session the client holds is not the account whose rows these are. */
class SessionMismatchError extends Error {}

const sessionEpoch = new SessionEpoch();
let rerunRequestedFor: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryAttempt = 0;
/** The run under way; runs never overlap. */
let inFlight: Promise<boolean> | null = null;
/** Set when the server has no `sync_cursors()`, until the session ends. */
let changeProbeUnavailable = false;

const isAuthError = (raw: string) => /jwt|token|401|unauthorized|not authenticated|permission denied/i.test(raw);

function friendlySyncError(raw: string): string {
  return isNetworkFailure(raw) ? tr.sync.errNetwork : tr.sync.errGeneric;
}

/**
 * What the server will never take as sent: a value out of bounds (class 22),
 * a constraint or a generation it refuses (23), a row the caller may not
 * write. "Permission denied for table" is not here: that is a request with no
 * signed-in role, which a new session fixes.
 */
function isRefusal(error: { code?: string; message: string }): boolean {
  return /^2[23]/.test(error.code ?? "") || (error.code === "42501" && /row-level security/i.test(error.message));
}

/**
 * A delete taken back, or made twice, before any of it was sent leaves the row
 * generations ahead of the server, which takes one step at a time and only the
 * newest event is sent. Nobody else saw those steps, so the row goes again at
 * the generation the server holds, and its answer brings the device back to it.
 * Asked by what the server holds, not by the refusal's words: ahead is the only
 * way the trigger refuses a generation, and a message can be reworded.
 * Without this such rows wait aside for good. Stepping a live row down onto a
 * delete made elsewhere would restore it over that delete.
 */
async function atServerGeneration(
  supabase: SupabaseClient,
  table: SyncedTableName,
  row: Record<string, unknown>,
  token: SessionEpochToken,
): Promise<Record<string, unknown> | null> {
  let query = supabase.from(table).select("tombstone_version, deleted_at");
  for (const column of keyColumns()) query = query.eq(column, String(row[column]));
  const { data, error } = await query.limit(1).abortSignal(token.signal);
  if (error) throw new Error(`push ${table}: ${error.message}`);
  const held = (data as { tombstone_version: number; deleted_at: string | null }[] | null)?.[0];
  if (!held || held.tombstone_version >= Number(row.tombstone_version)) return null;
  // A delete this device never saw stands: one generation below, the server
  // answers with what it holds, and the device takes that.
  const behind = held.deleted_at != null && row.deleted_at == null ? 1 : 0;
  return { ...row, tombstone_version: held.tombstone_version - behind };
}

function* chunks<T>(values: readonly T[]): Generator<T[]> {
  for (let at = 0; at < values.length; at += ID_CHUNK) yield values.slice(at, at + ID_CHUNK);
}

function assertActive(token: SessionEpochToken): void {
  sessionEpoch.assertCurrent(token);
}

async function tryRefreshSession(supabase: SupabaseClient): Promise<RefreshOutcome> {
  const { data, error } = await supabase.auth.refreshSession();
  return !error && data.session ? "refreshed" : classifyRefreshFailure(error);
}

/**
 * The client's session must be this account's before anything is sent: a
 * personal row is stamped with `userId`, and under another account's session
 * every one of them would be refused and set aside as if it were bad.
 */
async function assertSessionIs(supabase: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session?.user.id !== userId) throw new SessionMismatchError("session: not this account's");
}

/** The server's copy, `created_at` included (`isAddedAgain` needs the new one). */
async function upsertLocal(sqlite: LocalDatabase, table: SyncedTableName, row: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(row);
  await sqlite.runAsync(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${keys.filter((key) => key !== "id").map((key) => `${key} = excluded.${key}`).join(", ")}`,
    keys.map((key) => row[key] as string | number | null),
  );
}

async function newestOutboxIds(sqlite: LocalDatabase, table: SyncedTableName, rowIds: readonly string[]): Promise<Map<string, number>> {
  const newest = new Map<string, number>();
  for (const chunk of chunks(rowIds)) {
    const rows = await sqlite.getAllAsync<{ row_id: string; id: number }>(
      `SELECT row_id, MAX(id) AS id FROM outbox WHERE table_name = ? AND row_id IN (${chunk.map(() => "?").join(", ")}) GROUP BY row_id`,
      [table, ...chunk],
    );
    for (const row of rows) newest.set(row.row_id, row.id);
  }
  return newest;
}

interface Acknowledged {
  event: ParsedOutboxEvent;
  answer: Record<string, unknown>;
}

function matchAnswers(table: SyncedTableName, events: readonly ParsedOutboxEvent[], data: unknown): Acknowledged[] {
  const answers = (data ?? []) as Record<string, unknown>[];
  if (answers.length !== events.length) throw new Error(`push ${table}: incomplete acknowledgement`);
  const byRow = new Map(events.map((event) => [event.row_id, event]));
  return answers.map((answer) => {
    const event = byRow.get(String(answer.id));
    if (!event) throw new Error(`push ${table}: unknown acknowledgement`);
    return { event, answer };
  });
}

/**
 * One statement for the batch, and the server takes it whole or not at all.
 * Refused, it is sent again row by row, so the rows it will take go and only
 * the one it will not waits aside.
 */
async function sendRows(
  supabase: SupabaseClient,
  table: SyncedTableName,
  events: ParsedOutboxEvent[],
  rows: Record<string, unknown>[],
  token: SessionEpochToken,
): Promise<{ acknowledged: Acknowledged[]; refused: RejectedOutboxEvent[] }> {
  const onConflict = keyColumns().join(",");
  const send = (batch: Record<string, unknown>[]) =>
    supabase.from(table).upsert(batch, { onConflict }).select("*").abortSignal(token.signal);
  const acknowledged: Acknowledged[] = [];
  const refused: RejectedOutboxEvent[] = [];
  if (rows.length === 0) return { acknowledged, refused };
  const { data, error } = await send(rows);
  if (!error) return { acknowledged: matchAnswers(table, events, data), refused };
  if (!isRefusal(error)) throw new Error(`push ${table}: ${error.message}`);
  for (const [at, row] of rows.entries()) {
    assertActive(token);
    let one = rows.length === 1 ? { data: null, error } : await send([row]);
    if (one.error?.code === "23514") {
      const level = await atServerGeneration(supabase, table, row, token);
      if (level) one = await send([level]);
    }
    if (!one.error) acknowledged.push(...matchAnswers(table, [events[at]!], one.data));
    else if (isRefusal(one.error)) refused.push({ ...events[at]!, reason: "refused" });
    else throw new Error(`push ${table}: ${one.error.message}`);
  }
  return { acknowledged, refused };
}

async function pushTable(supabase: SupabaseClient, table: SyncedTableName, owner: string, token: SessionEpochToken): Promise<void> {
  const sqlite = await getSqliteAsync();
  // Read with the table's first batch: only a migration writes the mark, and
  // only the pull after this push clears it.
  let unpulledColumns: Set<string> | undefined;
  for (;;) {
    assertActive(token);
    const events = await sqlite.getAllAsync<OutboxEvent>(
      `SELECT id, payload, row_id FROM outbox WHERE table_name = ? ORDER BY id ASC LIMIT ${PUSH_BATCH}`,
      [table],
    );
    if (events.length === 0) return;
    const { latestByRow, rejected } = classifyOutboxBatch(events);
    if (!unpulledColumns) {
      const marked = await sqlite.getFirstAsync<{ last_pulled_at: string }>("SELECT last_pulled_at FROM sync_state WHERE table_name = ?", [UNPULLED + table]);
      unpulledColumns = new Set<string>(marked ? JSON.parse(marked.last_pulled_at) : []);
    }
    // By the columns each row names: one statement gives every row the same
    // columns, and PostgREST would write null into one an older event lacks.
    const shapes = new Map<string, { events: ParsedOutboxEvent[]; rows: Record<string, unknown>[] }>();
    for (const event of latestByRow.values()) {
      const row = toServerRow(table, event.row, owner, unpulledColumns);
      if (!row) {
        rejected.push({ ...event, reason: "invalid_row" });
        continue;
      }
      const shape = Object.keys(row).sort().join();
      const group = shapes.get(shape) ?? { events: [], rows: [] };
      group.events.push(event);
      group.rows.push(row);
      shapes.set(shape, group);
    }
    const acknowledged: Acknowledged[] = [];
    for (const group of shapes.values()) {
      const sent = await sendRows(supabase, table, group.events, group.rows, token);
      acknowledged.push(...sent.acknowledged);
      rejected.push(...sent.refused);
    }
    // A sign-out or another account may have come while PostgREST was
    // answering: the outbox is never cleared for a session that has ended.
    assertActive(token);
    const addedAgain: RowWrite[] = [];
    await withTransaction(async () => {
      assertActive(token);
      const newest = await newestOutboxIds(sqlite, table, acknowledged.map(({ event }) => event.row_id));
      for (const { event, answer } of acknowledged) {
        if (!shouldApplyServerAck(event.id, newest.get(event.row_id) ?? null)) continue;
        const local = toLocalRow(table, answer, owner);
        if (isAddedAgain(event.row, local)) {
          addedAgain.push({ table, row: { ...fromDbShape(table, event.row), tombstoneVersion: local.tombstone_version } });
        } else {
          await upsertLocal(sqlite, table, local);
        }
      }
      // A clue is only as old as the row it names: once a newer version is taken, it is history.
      for (const chunk of chunks(acknowledged.map(({ event }) => event.row_id))) {
        await sqlite.runAsync(
          `DELETE FROM sync_dead_letters WHERE table_name = ? AND row_id IN (${chunk.map(() => "?").join(", ")})`,
          [table, ...chunk],
        );
      }
      for (const event of rejected) {
        await sqlite.runAsync(
          `INSERT OR IGNORE INTO sync_dead_letters (outbox_id, table_name, row_id, payload, reason, quarantined_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [event.id, table, event.row_id, event.payload, event.reason, nowIso()],
        );
      }
      await sqlite.runAsync(`DELETE FROM outbox WHERE id IN (${events.map(() => "?").join(", ")})`, events.map((event) => event.id));
    });
    // At the generation the server holds, so the next pass of this loop sends it and it lands.
    if (addedAgain.length > 0) await writeRows(addedAgain);
  }
}

async function pushOutbox(supabase: SupabaseClient, userId: string, token: SessionEpochToken): Promise<void> {
  for (const table of TABLES) await pushTable(supabase, table, userId, token);
}

interface ServerHead {
  table_name: string;
  max_updated_at: string | null;
  max_id: string | null;
}

/**
 * Each table's keyset head in one request; `null` pulls every table. A table
 * the answer leaves out is pulled too: the function's list is a second copy of
 * `SYNCED_TABLES`, and a copy can fall behind.
 */
async function fetchServerHeads(supabase: SupabaseClient, token: SessionEpochToken): Promise<Map<string, PullCursor | null> | null> {
  if (changeProbeUnavailable) return null;
  const { data, error } = await supabase.rpc("sync_cursors").abortSignal(token.signal);
  if (error) {
    if (error.code !== "PGRST202") throw new Error(`pull probe: ${error.message}`);
    changeProbeUnavailable = true;
    return null;
  }
  const heads = new Map<string, PullCursor | null>();
  for (const row of (data ?? []) as ServerHead[]) {
    if (row.max_updated_at == null && row.max_id == null) heads.set(row.table_name, null);
    else if (typeof row.max_updated_at === "string" && isUuidShaped(row.max_id)) heads.set(row.table_name, { ts: row.max_updated_at, id: row.max_id });
  }
  return heads;
}

async function localMergeState(
  sqlite: LocalDatabase,
  table: SyncedTableName,
  ids: readonly string[],
): Promise<Map<string, { updated_at: string; tombstone_version: number }>> {
  const state = new Map<string, { updated_at: string; tombstone_version: number }>();
  for (const chunk of chunks(ids)) {
    const rows = await sqlite.getAllAsync<{ id: string; updated_at: string; tombstone_version: number }>(
      `SELECT id, updated_at, tombstone_version FROM ${table} WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    for (const row of rows) state.set(row.id, row);
  }
  return state;
}

/** One page of `table` after `cursor`. */
function fetchPage(supabase: SupabaseClient, table: SyncedTableName, cursor: PullCursor, first: boolean, token: SessionEpochToken) {
  const query = supabase.from(table).select("*").order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(PULL_PAGE);
  const page = first
    ? query.gte("updated_at", new Date(Date.parse(cursor.ts) - PULL_OVERLAP_MS).toISOString())
    : query.or(`updated_at.gt.${cursor.ts},and(updated_at.eq.${cursor.ts},id.gt.${cursor.id})`);
  return Promise.resolve(page.abortSignal(token.signal));
}

type Page = ReturnType<typeof fetchPage>;

/**
 * Every table's first page asked for at once; only the merge stays in order,
 * so a pull cut short still never leaves a child ahead of its parent. One after
 * another, a first pull was a round trip per table before anything showed. A
 * page never merged — the pull stopped at an earlier table — is dropped; it
 * cannot reject unobserved, since PostgREST without `throwOnError` answers a
 * failed or aborted fetch with `{ error }`.
 */
function prefetch(tables: readonly SyncedTableName[], cursorFor: (table: SyncedTableName) => PullCursor, supabase: SupabaseClient, token: SessionEpochToken): Map<SyncedTableName, Page> {
  return new Map(tables.map((table) => [table, fetchPage(supabase, table, cursorFor(table), true, token)] as const));
}

async function pullTable(supabase: SupabaseClient, table: SyncedTableName, from: PullCursor, owner: string, token: SessionEpochToken, firstPage: Page): Promise<void> {
  const sqlite = await getSqliteAsync();
  let cursor = from;
  let next = firstPage;
  for (;;) {
    assertActive(token);
    const { data, error } = await next;
    if (error) throw new Error(`pull ${table}: ${error.message}`);
    if (!data || data.length === 0) return;
    assertActive(token);
    // The whole page is checked before any of it lands or the cursor moves:
    // a bad row retries in place rather than hiding behind a newer cursor.
    const remotes = (data as Record<string, unknown>[]).map((raw) => toLocalRow(table, raw, owner));
    await withTransaction(async () => {
      const ids = remotes.map((remote) => String(remote.id));
      const local = await localMergeState(sqlite, table, ids);
      // A row with an edit still to send keeps it: the push that follows
      // decides, and taking the server's copy meanwhile would show the older
      // value until then — for ever, if that push is refused.
      const unsent = await newestOutboxIds(sqlite, table, ids);
      for (const remote of remotes) {
        assertActive(token);
        const held = local.get(String(remote.id));
        if (unsent.has(String(remote.id))) continue;
        if (remoteWinsLww(held?.updated_at ?? null, String(remote.updated_at), held?.tombstone_version ?? 0, Number(remote.tombstone_version))) {
          await upsertLocal(sqlite, table, remote);
        }
      }
      const last = (data as Record<string, unknown>[]).at(-1)!;
      cursor = { ts: cursorInstant(String(last.updated_at)), id: String(last.id) };
      await sqlite.runAsync(
        `INSERT INTO sync_state (table_name, last_pulled_at) VALUES (?, ?) ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`,
        [table, formatPullCursor(cursor)],
      );
    });
    if (data.length < PULL_PAGE) return;
    next = fetchPage(supabase, table, cursor, false, token);
  }
}

async function pullAll(supabase: SupabaseClient, userId: string, token: SessionEpochToken): Promise<void> {
  const sqlite = await getSqliteAsync();
  assertActive(token);
  const heads = await fetchServerHeads(supabase, token);
  const stored = await sqlite.getAllAsync<{ table_name: string; last_pulled_at: string }>("SELECT table_name, last_pulled_at FROM sync_state");
  const cursors = new Map(stored.map((row) => [row.table_name, parsePullCursor(row.last_pulled_at)]));
  const cursorFor = (table: SyncedTableName) => cursors.get(table) ?? parsePullCursor(null);
  // Merged parents first, so a pull cut short never leaves a child ahead of its parent.
  const pending = TABLES.filter((table) => !(heads?.has(table) && cursorIsAtServerHead(cursorFor(table), heads.get(table) ?? null)));
  const pages = prefetch(pending, cursorFor, supabase, token);
  for (const table of pending) {
    await pullTable(supabase, table, cursorFor(table), userId, token, pages.get(table)!);
  }
  // Every row is now the server's, except one with an edit still to send,
  // which the pull skipped, or refused and held to retry: its table stays
  // unpulled until that edit is sent or let go.
  await sqlite.runAsync(
    "DELETE FROM sync_state WHERE table_name LIKE ? AND substr(table_name, ?) NOT IN (SELECT table_name FROM outbox UNION SELECT table_name FROM sync_dead_letters)",
    [`${UNPULLED}%`, UNPULLED.length + 1],
  );
}

const RETRIED = "retried:";

/**
 * A refusal is final only for the engine that met it: 1.4.0 sends at the
 * server's generation the rows 1.3 set aside, and those waited on the owner's
 * phone until a sign-out wiped them. A new version sends
 * what waits aside once more, before its first push; a row it refuses too
 * waits until the next version, not the next sync.
 */
async function retryAsideAfterUpdate(): Promise<void> {
  const sqlite = await getSqliteAsync();
  const key = RETRIED + (Constants.expoConfig?.version ?? "");
  if (await sqlite.getFirstAsync("SELECT 1 FROM sync_state WHERE table_name = ?", [key])) return;
  for (const { id } of await sqlite.getAllAsync<{ id: number }>("SELECT id FROM sync_dead_letters")) await retryDeadLetter(id);
  await sqlite.runAsync("DELETE FROM sync_state WHERE table_name LIKE ?", [`${RETRIED}%`]);
  await sqlite.runAsync("INSERT INTO sync_state (table_name, last_pulled_at) VALUES (?, ?)", [key, nowIso()]);
}

async function deadLetterCount(): Promise<number> {
  const sqlite = await getSqliteAsync();
  return (await sqlite.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_dead_letters"))!.n;
}

function clearScheduledSync(): void {
  clearTimeout(debounceTimer);
  clearTimeout(retryTimer);
  retryAttempt = 0;
  rerunRequestedFor = null;
}

async function runSync(userId: string, token: SessionEpochToken, allowRefresh: boolean): Promise<boolean> {
  const status = useSyncStatus.getState();
  const supabase = getSupabase();
  // Only a signed-in account starts a session, and only a configured build signs in.
  if (!supabase) return true;
  status.set({ state: "syncing" });
  try {
    await assertSessionIs(supabase, userId);
    await retryAsideAfterUpdate();
    await pushOutbox(supabase, userId, token);
    await pullAll(supabase, userId, token);
    assertActive(token);
    const state = completedSyncState(await deadLetterCount());
    retryAttempt = 0;
    status.set({ state, lastSyncAt: nowIso(), error: null });
    return true;
  } catch (error) {
    if (error instanceof SessionEpochCancelledError || !sessionEpoch.isCurrent(token)) return false;
    if (error instanceof SessionMismatchError) {
      // A retry would meet the same session; a sign-in is what changes it.
      status.set({ state: "error", error: tr.sync.errReauth });
      return false;
    }
    const raw = String(error);
    let message = friendlySyncError(raw);
    if (isAuthError(raw)) {
      // Once, then a sign-in: a token refused straight after renewing will be refused again.
      const outcome = allowRefresh ? await tryRefreshSession(supabase).catch(classifyRefreshFailure) : "expired";
      if (!sessionEpoch.isCurrent(token)) return false;
      if (outcome === "refreshed") {
        status.set({ state: "syncing" });
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void syncNow(userId, false), 0);
        return false;
      }
      if (outcome === "expired") {
        // Retrying cannot bring back a refresh token that is gone; a sign-in can.
        status.set({ state: "error", error: tr.sync.errReauth });
        return false;
      }
      message = tr.sync.errNetwork;
    }
    status.set({ state: "error", error: message });
    // 5 s, 10 s, 20 s… at most five minutes.
    const delay = Math.min(5000 * 2 ** retryAttempt, 300_000);
    retryAttempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void syncNow(userId), delay);
    return false;
  }
}

/** Open sync for the signed-in account; only `src/auth/session.ts` calls it. */
export function startSyncSession(userId: string): void {
  sessionEpoch.start(userId);
  changeProbeUnavailable = false;
  clearScheduledSync();
}

/** End the session's sync and wait until its run has let go of the database. */
export async function stopSyncSession(): Promise<void> {
  sessionEpoch.stop();
  clearScheduledSync();
  await Promise.allSettled([inFlight]);
}

/**
 * Push the outbox and nothing else, for a sign-out: it decides whether
 * anything would be lost, and a pull would fetch pages into a database about
 * to be emptied. A failure leaves the rows in the outbox, which the caller counts.
 */
export async function flushOutbox(userId: string): Promise<void> {
  const token = sessionEpoch.capture(userId);
  const supabase = getSupabase();
  if (!token || !supabase) return;
  try {
    await assertSessionIs(supabase, userId);
    await pushOutbox(supabase, userId, token);
  } catch {
    // Counted by the caller.
  }
}

export async function syncNow(userId: string, allowRefresh = true): Promise<boolean> {
  const token = sessionEpoch.capture(userId);
  // A late timer from an account that has signed out must do nothing.
  if (!token) return false;
  if (inFlight) {
    // A write landed while a run was in flight: one more pass after it.
    rerunRequestedFor = userId;
    return inFlight;
  }
  inFlight = runSync(userId, token, allowRefresh);
  try {
    return await inFlight;
  } finally {
    // Released whatever happened: a run left holding it would stop sync for good.
    inFlight = null;
    const requested = rerunRequestedFor;
    rerunRequestedFor = null;
    if (requested) scheduleSync(requested, 250);
  }
}

/** A sync soon after a write; the screen never waits on it. */
export function scheduleSync(userId: string, delayMs = 1500): void {
  if (!sessionEpoch.capture(userId)) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void syncNow(userId), delayMs);
}

onLocalWrite(() => {
  const userId = sessionEpoch.activeUserId;
  if (userId) scheduleSync(userId);
});
