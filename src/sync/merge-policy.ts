/**
 * Sync's selection rules, kept apart from I/O so every conflict edge is a unit
 * test. An outbox event carries no `user_id` to check: the device holds one
 * account's workspace and a list row is not scoped by a person.
 */

export interface OutboxEvent {
  id: number;
  payload: string;
  row_id: string;
}

export interface ParsedOutboxEvent extends OutboxEvent {
  row: Record<string, unknown>;
}

export interface RejectedOutboxEvent extends OutboxEvent {
  reason: "malformed_payload" | "invalid_row" | "refused";
}

/** The newest event per row, and what could not be read at all. */
export function classifyOutboxBatch(events: readonly OutboxEvent[]): {
  latestByRow: Map<string, ParsedOutboxEvent>;
  rejected: RejectedOutboxEvent[];
} {
  const latestByRow = new Map<string, ParsedOutboxEvent>();
  const rejected: RejectedOutboxEvent[] = [];
  for (const event of events) {
    // Events arrive oldest first. The earlier candidate goes at once, so a
    // newer corrupt snapshot can never let an older valid one be sent.
    latestByRow.delete(event.row_id);
    let row: unknown;
    try {
      row = JSON.parse(event.payload);
    } catch {
      rejected.push({ ...event, reason: "malformed_payload" });
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row) || (row as { id?: unknown }).id !== event.row_id) {
      rejected.push({ ...event, reason: "malformed_payload" });
      continue;
    }
    latestByRow.set(event.row_id, { ...event, row: row as Record<string, unknown> });
  }
  return { latestByRow, rejected };
}

/** A server acknowledgement is applied only when no newer local edit was queued while it was in flight. */
export function shouldApplyServerAck(pushedOutboxId: number, newestOutboxId: number | null): boolean {
  return newestOutboxId == null || newestOutboxId <= pushedOutboxId;
}

/**
 * A live row this device made afresh, answered with a delete it never saw.
 * The generation rule would drop it, but it is a product added again after
 * another device bought it, or a shop finished on both (12.9), and losing it
 * would lose what the person just did. `created_at` tells the two
 * apart: an edit carries the row's own, and a row made afresh a new one.
 */
export function isAddedAgain(pushed: Record<string, unknown>, answer: Record<string, unknown>): boolean {
  return (
    pushed.deleted_at == null &&
    answer.deleted_at != null &&
    Number(answer.tombstone_version) > Number(pushed.tombstone_version) &&
    Date.parse(String(pushed.created_at)) !== Date.parse(String(answer.created_at))
  );
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every synced id is UUID-shaped (a uuidv7, or the v8-nibble deterministic
 * form). The pull puts the last id into a PostgREST `.or()` filter, and a
 * photo's id becomes a Storage path, so the shape is part of the trust
 * boundary: filter grammar or a `/` must never get that far.
 */
export function isUuidShaped(id: unknown): id is string {
  return typeof id === "string" && UUID_SHAPE.test(id);
}

/**
 * Last writer wins on the server's clock, and a delete generation outranks
 * any clock: a device that never saw generation N+1 cannot revive or edit
 * past it. An equal version converges to the server's copy.
 */
export function remoteWinsLww(
  localUpdatedAt: string | null,
  remoteUpdatedAt: string,
  localTombstoneVersion = 0,
  remoteTombstoneVersion = 0,
): boolean {
  if (remoteTombstoneVersion !== localTombstoneVersion) return remoteTombstoneVersion > localTombstoneVersion;
  const remote = Date.parse(remoteUpdatedAt);
  if (!Number.isFinite(remote)) return false;
  if (!localUpdatedAt) return true;
  const local = Date.parse(localUpdatedAt);
  return !Number.isFinite(local) || remote >= local;
}

/** Everything at or before this `(updated_at, id)` has been pulled. */
export interface PullCursor {
  ts: string;
  id: string;
}

/** Where a table that has never been pulled starts. */
export const PULL_EPOCH = "1970-01-01T00:00:00.000Z";

export function parsePullCursor(raw: string | null | undefined): PullCursor {
  const value = raw || PULL_EPOCH;
  const separator = value.indexOf("|");
  return separator >= 0 ? { ts: value.slice(0, separator), id: value.slice(separator + 1) } : { ts: value, id: "" };
}

export function formatPullCursor(cursor: PullCursor): string {
  return `${cursor.ts}|${cursor.id}`;
}

/** A pull cursor's instant at the server's microsecond precision; cut to the millisecond, `updated_at.gt` would match a page stamped by one `now()` again for ever. */
export function cursorInstant(value: string): string {
  const sub = /T[\d:]+\.\d{3}(\d{1,3})/.exec(value)?.[1] ?? "";
  return new Date(value).toISOString().replace("Z", `${sub}Z`);
}

/**
 * Whether the cursor stands on the newest row the server holds, so the table
 * can be skipped. Only an exact match on both halves: Postgres keeps
 * microseconds and a millisecond cursor would, under "not greater", skip a row
 * written 400µs after the cursor's for ever. A table the probe reports empty
 * (`null`) has nothing to pull.
 */
export function cursorIsAtServerHead(cursor: PullCursor, head: PullCursor | null): boolean {
  if (head == null) return true;
  if (head.id !== cursor.id) return false;
  const headTs = Date.parse(head.ts);
  return Number.isFinite(headTs) && headTs === Date.parse(cursor.ts);
}
