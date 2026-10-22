/**
 * What sync set aside, for the screen that shows it: each is a
 * clue that a row stays on this device alone, never the row itself.
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { findRow, fromDbShape, writeRows } from "../db/mutations";
import { SYNCED_TABLES, syncDeadLetters, type SyncedTableName } from "../db/schema";

export type DeadLetter = Pick<typeof syncDeadLetters.$inferSelect, "id" | "tableName" | "rowId" | "reason" | "quarantinedAt"> & {
  /** The row as the person would know it — a setting's key — when it has one. */
  subject: string | null;
};

function subjectOf(payload: string): string | null {
  try {
    const row = JSON.parse(payload) as Record<string, unknown>;
    const subject = row.key;
    return typeof subject === "string" ? subject : null;
  } catch {
    return null;
  }
}

export async function readDeadLetters(): Promise<DeadLetter[]> {
  const { id, tableName, rowId, reason, quarantinedAt, payload } = syncDeadLetters;
  const letters = await getDb().select({ id, tableName, rowId, reason, quarantinedAt, payload }).from(syncDeadLetters).orderBy(asc(id));
  return letters.map(({ payload, ...letter }) => ({ ...letter, subject: subjectOf(payload) }));
}

/**
 * Queue the row as it is on the device now — not the payload that was set
 * aside, which is kept only to say what was refused — and forget the clue. A
 * row the device no longer holds keeps its clue: it is the only trace left.
 */
export async function retryDeadLetter(id: number): Promise<"requeued" | "missing"> {
  const [letter] = await getDb().select().from(syncDeadLetters).where(eq(syncDeadLetters.id, id));
  if (!letter || !Object.hasOwn(SYNCED_TABLES, letter.tableName)) return "missing";
  const table = letter.tableName as SyncedTableName;
  const current = await findRow(table, letter.rowId);
  if (!current) return "missing";
  await writeRows([{ table, row: fromDbShape(table, current) }]);
  await dismissDeadLetter(id);
  return "requeued";
}

/** Forget the clue; the row it names stays on the device as it is. */
export async function dismissDeadLetter(id: number): Promise<void> {
  await getDb().delete(syncDeadLetters).where(eq(syncDeadLetters.id, id));
}
