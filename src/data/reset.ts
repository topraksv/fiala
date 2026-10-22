/**
 * Resetting the data: the person chooses parts, and each goes whole with what
 * hangs from it. Everything leaves as a tombstone, so the account's other
 * devices follow; settings never go, since a reset keeps the account.
 *
 * The shell holds nothing but settings, so there are no parts yet. A feature
 * that stores the person's data adds its tables to `PARTS`; the registry is a
 * parameter so the mechanism is proven before one does.
 */

import { getSqliteAsync } from "../db/client";
import { fromDbShape, nowIso, writeRows, type RowSnapshot, type RowWrite } from "../db/mutations";
import type { SyncedTableName } from "../db/schema";

/** Each part's tables and which of their rows. */
type Parts = Readonly<Record<string, readonly (readonly [SyncedTableName, string])[]>>;
const PARTS: Parts = {};

export type ResetScope = string;
export const RESET_SCOPES: readonly ResetScope[] = Object.keys(PARTS);

/** Every live row the parts take, once each. */
async function chosenRows(scopes: readonly ResetScope[], parts: Parts): Promise<Map<string, readonly [SyncedTableName, RowSnapshot]>> {
  const sqlite = await getSqliteAsync();
  const rows = new Map<string, readonly [SyncedTableName, RowSnapshot]>();
  for (const [table, which] of scopes.flatMap((scope) => parts[scope] ?? [])) {
    for (const row of await sqlite.getAllAsync<RowSnapshot>(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND (${which})`)) {
      rows.set(`${table}:${String(row.id)}`, [table, row]);
    }
  }
  return rows;
}

/** How many records the parts would take, shown before anything goes. */
export async function countDataReset(scopes: readonly ResetScope[], parts: Parts = PARTS): Promise<number> {
  return (await chosenRows(scopes, parts)).size;
}

/** Take them, in one transaction, and say how many went. */
export async function resetData(scopes: readonly ResetScope[], parts: Parts = PARTS): Promise<number> {
  let taken = 0;
  await writeRows(async () => {
    const deletedAt = nowIso();
    const writes: RowWrite[] = [...(await chosenRows(scopes, parts)).values()].map(([table, row]) => ({
      table,
      row: { ...fromDbShape(table, row), deletedAt },
    }));
    taken = writes.length;
    return writes;
  });
  return taken;
}
