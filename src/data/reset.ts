/**
 * Resetting the data: the person chooses parts, and each goes whole with what
 * hangs from it. Everything leaves as a tombstone, so the account's other
 * devices follow; settings stay, since a reset keeps the account, all but
 * the consent to the data the reset takes.
 *
 * A feature that stores the person's data adds its tables to `PARTS`; the
 * registry is a parameter so the mechanism is proven over parts no feature has.
 */

import { getSqliteAsync } from "../db/client";
import { fromDbShape, nowIso, writeRows, type RowSnapshot, type RowWrite } from "../db/mutations";
import type { SyncedTableName } from "../db/schema";
import { HEALTH_CONSENT } from "./settings";

/**
 * A cabinet someone else owns is theirs, and so is what is in it: a member who
 * resets lets none of it go, or an editor would empty the household for
 * everyone (Gital's). Leaving is how a member lets a cabinet go.
 */
const THEIRS = "SELECT cabinet_id FROM cabinet_members WHERE user_id = ? AND role <> 'owner'";

/** Each part's tables and which of their rows. */
type Parts = Readonly<Record<string, readonly (readonly [SyncedTableName, string])[]>>;
const PARTS: Parts = {
  // Every box, product, move, edit and tag, and the people and places they name: a
  // person left behind would name boxes that are gone. The health-data
  // consent goes with the data it covered, the one setting a reset takes:
  // clearing the cabinet is how that consent is withdrawn.
  cabinet: [
    ["package_moves", "1"],
    ["package_changes", "1"],
    ["product_tags", "1"],
    ["tags", "1"],
    ["packages", "1"],
    ["products", "1"],
    ["people", "1"],
    ["locations", "1"],
    ["settings", `key = '${HEALTH_CONSENT}'`],
  ],
};

export type ResetScope = string;
export const RESET_SCOPES: readonly ResetScope[] = Object.keys(PARTS);

/** Every live row the parts take, once each. */
async function chosenRows(scopes: readonly ResetScope[], me: string, parts: Parts): Promise<Map<string, readonly [SyncedTableName, RowSnapshot]>> {
  const sqlite = await getSqliteAsync();
  const rows = new Map<string, readonly [SyncedTableName, RowSnapshot]>();
  for (const [table, which] of scopes.flatMap((scope) => parts[scope] ?? [])) {
    // Every table a part names is a cabinet's, but for the settings.
    const scoped = table !== "settings";
    const own = scoped ? ` AND cabinet_id NOT IN (${THEIRS})` : "";
    for (const row of await sqlite.getAllAsync<RowSnapshot>(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND (${which})${own}`, scoped ? [me] : [])) {
      rows.set(`${table}:${String(row.id)}`, [table, row]);
    }
  }
  return rows;
}

/** How many records the parts would take, shown before anything goes. */
export async function countDataReset(scopes: readonly ResetScope[], me: string, parts: Parts = PARTS): Promise<number> {
  return (await chosenRows(scopes, me, parts)).size;
}

/** Take them, in one transaction, and say how many went. */
export async function resetData(scopes: readonly ResetScope[], me: string, parts: Parts = PARTS): Promise<number> {
  let taken = 0;
  await writeRows(async () => {
    const deletedAt = nowIso();
    const writes: RowWrite[] = [...(await chosenRows(scopes, me, parts)).values()].map(([table, row]) => ({
      table,
      row: { ...fromDbShape(table, row), deletedAt },
    }));
    taken = writes.length;
    return writes;
  });
  return taken;
}
