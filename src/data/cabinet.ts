/**
 * The cabinet's boxes and what each holds (`docs/TASKS.md` F1.6). A box's
 * amount is the sum of its moves, never a column, so two devices that each
 * took a tablet offline both count. Every row names the cabinet it is in
 * (`docs/ARCHITECTURE.md` "A cabinet scopes every medicine row"); the caller
 * passes it, since until sharing it is the person's own id.
 */

import { uuidv7 } from "uuidv7";
import { getSqliteAsync } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { editRow, findRow, fromDbShape, nowIso, writeRows, writeUndoable, type RowsWritten, type RowWrite } from "../db/mutations";
import type { MemberRole, MOVE_REASONS, PACKAGE_DISPOSITIONS, PACKAGE_UNITS, PERSON_COLORS, PERSON_KINDS } from "../db/schema";
import { foldName } from "../domain/boxes";
import type { ImportedBox } from "../domain/import";
import { photoColumn, type NewPhoto } from "./photos";

export interface ProductFields {
  name: string;
  brand?: string | null;
  activeSubstance?: string | null;
  strength?: string | null;
  form?: string | null;
  pack?: string | null;
  manufacturer?: string | null;
  gtin?: string | null;
}

export interface PackageFields {
  personId?: string | null;
  locationId?: string | null;
  unit: (typeof PACKAGE_UNITS)[number];
  expiresOn?: string | null;
  openedOn?: string | null;
  useWithinDays?: number | null;
  lowMilli?: number | null;
  serial?: string | null;
  lot?: string | null;
  nickname?: string | null;
  acquiredOn?: string | null;
  acquiredFrom?: string | null;
  note?: string | null;
  disposition?: (typeof PACKAGE_DISPOSITIONS)[number] | null;
  warnDays?: number | null;
  photoId?: string | null;
  checkOf?: string | null;
  checkAskedAt?: string | null;
}

type MoveReason = (typeof MOVE_REASONS)[number];

/** An amount is whole thousandths of a unit, and a move is never nothing. */
function assertAmount(milli: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(milli) || milli < 0 || (milli === 0 && !allowZero)) throw new Error(`invalid amount ${milli}`);
}

/**
 * The product a new box is of. One with a GTIN is found by it, so a second box
 * joins the first one's product, and one deleted comes back with what was
 * reviewed now; without a GTIN, each add is a product of its own.
 */
async function productWrite(cabinetId: string, product: ProductFields | { id: string }): Promise<{ id: string; cabinetId: string; writes: RowWrite[] }> {
  // The box goes where its product is, which may be a household rather than the cabinet asked for.
  if ("id" in product) {
    const held = await findRow("products", product.id);
    // Deleted meanwhile on another device, its tombstone kept no name to bring back (F7.11): the add is refused.
    if (!held || held.deleted_at != null) throw new Error(`no product ${product.id}`);
    return { id: product.id, cabinetId: String(held.cabinet_id), writes: [] };
  }
  const gtin = product.gtin || null;
  const id = gtin ? await deterministicId(naturalKeys.product(cabinetId, gtin)) : uuidv7();
  const there = gtin ? await findRow("products", id) : null;
  if (there && there.deleted_at == null) return { id, cabinetId, writes: [] };
  const row = { cabinetId, ...product, gtin, deletedAt: null };
  return { id, cabinetId, writes: there ? editRow("products", there, row) : [{ table: "products", row: { id, ...row } }] };
}

/** Add a box of `product`, or of the held product with that id, holding `amountMilli`, in one write; its id is returned. */
export async function addPackage(cabinetId: string, product: ProductFields | { id: string }, box: PackageFields, amountMilli: number): Promise<string> {
  assertAmount(amountMilli, true);
  const packageId = uuidv7();
  await writeRows(async () => {
    const { id: productId, cabinetId: there, writes } = await productWrite(cabinetId, product);
    writes.push({ table: "packages", row: { id: packageId, cabinetId: there, productId, ...box } });
    if (amountMilli > 0) writes.push(moveWrite(there, packageId, amountMilli, "initial"));
    return writes;
  });
  return packageId;
}

/**
 * Add the boxes of a file (`docs/TASKS.md` F1.13) in one write `undoRows`
 * takes back whole; `null` when there were none. A person or a place is
 * found by its name, folded, or made once; boxes of one GTIN share a product,
 * and so, within the file, do boxes of one name without a GTIN.
 */
export async function importBoxes(cabinetId: string, boxes: readonly ImportedBox<PackageFields["unit"]>[]): Promise<RowsWritten | null> {
  const written = await writeUndoable(async () => {
    const writes: RowWrite[] = [];
    const named = { people: new Map<string, string>(), locations: new Map<string, string>() };
    for (const table of ["people", "locations"] as const) {
      for (const { id, name, cabinetId: there } of await readNamed(table)) if (there === cabinetId) named[table].set(foldName(name), id);
    }
    const idOf = (table: "people" | "locations", name: string | null) => {
      if (!name) return null;
      const known = named[table].get(foldName(name));
      if (known) return known;
      const id = uuidv7();
      named[table].set(foldName(name), id);
      writes.push({ table, row: { id, cabinetId, name } });
      return id;
    };
    const products = new Map<string, string>();
    for (const { product, box, amountMilli, person, place } of boxes) {
      assertAmount(amountMilli, true);
      const key = product.gtin ?? `name:${foldName(product.name)}`;
      let productId = products.get(key);
      if (!productId) {
        const made = await productWrite(cabinetId, product);
        productId = made.id;
        products.set(key, productId);
        writes.push(...made.writes);
      }
      const packageId = uuidv7();
      writes.push({ table: "packages", row: { id: packageId, cabinetId, productId, personId: idOf("people", person), locationId: idOf("locations", place), ...box } });
      if (amountMilli > 0) writes.push(moveWrite(cabinetId, packageId, amountMilli, "initial"));
    }
    return writes;
  });
  return written.writes.length > 0 ? written : null;
}

/**
 * The product a moved box is of in `cabinetId`: by GTIN as a new box finds
 * it, else one of the same name and strength, so a box moved back finds the
 * product it left. Its note, photo, star and tags stay with the product left
 * behind, which may still hold other boxes.
 */
async function productThere(cabinetId: string, product: Record<string, unknown>): Promise<{ id: string; writes: RowWrite[] }> {
  const { name, brand, activeSubstance, strength, form, pack, manufacturer, gtin } = fromDbShape("products", product) as unknown as ProductFields;
  if (!gtin) {
    const sqlite = await getSqliteAsync();
    const same = await sqlite.getAllAsync<{ id: string; name: string; strength: string | null }>(
      "SELECT id, name, strength FROM products WHERE cabinet_id = ? AND gtin IS NULL AND deleted_at IS NULL",
      [cabinetId],
    );
    const twin = same.find((each) => foldName(each.name) === foldName(name) && (each.strength ?? "") === (strength ?? ""));
    if (twin) return { id: twin.id, writes: [] };
  }
  return productWrite(cabinetId, { name, brand, activeSubstance, strength, form, pack, manufacturer, gtin });
}

/**
 * Move a box to another cabinet (`docs/TASKS.md` F2.5): private is the
 * person's own cabinet, not a column, so the box is tombstoned where it was
 * and made afresh there, and every device that held it hears it went. Made
 * private, it keeps its moves and its history. Into a household it arrives
 * now with what it holds, its doses' moves apart so an answer changed later
 * puts its dose back, and nothing older: its edits keep every value it
 * ever had, a note deleted since among them, and every member would read
 * them, its arrival dated to its purchase. Its person and place were the old cabinet's: the
 * one of the same name there is taken, or made, as an import does. Its new
 * id, and one write `undoRows` takes back whole; `null` when there was
 * nothing to move.
 */
export async function moveBox(packageId: string, cabinetId: string): Promise<{ id: string; written: RowsWritten } | null> {
  const id = uuidv7();
  const written = await writeUndoable(async () => {
    const box = await findRow("packages", packageId);
    if (!box || box.deleted_at != null || box.cabinet_id === cabinetId) return [];
    // A box's product is never deleted from under it, only tombstoned, and a
    // tombstone keeps no name to make one by there: an add undone on another
    // device leaves a box so, and it stays where it is.
    const product = (await findRow("products", String(box.product_id)))!;
    if (product.deleted_at != null) return [];
    const sqlite = await getSqliteAsync();
    const { id: productId, writes } = await productThere(cabinetId, product);
    const { tombstoneVersion: _, ...shape } = fromDbShape("packages", box);
    // An open ask to check it was made of the household it leaves.
    writes.push({
      table: "packages",
      row: { ...shape, id, cabinetId, productId, personId: await nameThere("people", box.person_id, cabinetId, writes), locationId: await nameThere("locations", box.location_id, cabinetId, writes), checkOf: null, checkAskedAt: null },
    });
    // A dose's move goes with it under the id its answer names, so answered
    // otherwise later the dose goes back into this box, not the one left.
    const doses = await sqlite.getAllAsync<Record<string, unknown>>(
      `SELECT l.*, m.quantity_milli AS dose_milli FROM dose_logs l JOIN package_moves m ON m.id = l.move_id
        WHERE m.package_id = ? AND m.deleted_at IS NULL AND l.deleted_at IS NULL`,
      [packageId],
    );
    for (const { dose_milli: quantityMilli, ...log } of doses) {
      const moveId = await deterministicId(naturalKeys.doseMove(String(log.plan_id), String(log.due_on), String(log.due_time), id));
      writes.push({ table: "package_moves", row: { id: moveId, cabinetId, packageId: id, quantityMilli, reason: "use", createdBy: null } });
      writes.push(...editRow("dose_logs", log, { moveId }));
    }
    // A change's id is never a dose's move, so the second half lets every change by.
    const undosed = "package_id = ? AND deleted_at IS NULL AND id NOT IN (SELECT move_id FROM dose_logs WHERE move_id IS NOT NULL AND deleted_at IS NULL)";
    const household = await sqlite.getFirstAsync<{ id: string }>("SELECT id FROM cabinets WHERE id = ? AND id <> owner_id", [cabinetId]);
    if (household) {
      const held = await sqlite.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(quantity_milli), 0) AS total FROM package_moves WHERE ${undosed}`, [packageId]);
      if (held && held.total > 0) writes.push(moveWrite(cabinetId, id, held.total, "initial"));
    } else {
      for (const table of ["package_moves", "package_changes"] as const) {
        for (const row of await sqlite.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${undosed}`, [packageId])) {
          const { tombstoneVersion: __, ...copy } = fromDbShape(table, row);
          // The server names the mover as the copy's writer (migration 11): until the pull brings that, nobody rather than a name it will not keep.
          writes.push({ table, row: { ...copy, id: uuidv7(), cabinetId, packageId: id, createdBy: null } });
        }
      }
    }
    writes.push(...(await relinked("package_id", packageId, id)));
    // A plan taking its doses from the box takes them from it where it went.
    for (const plan of await sqlite.getAllAsync<Record<string, unknown>>("SELECT * FROM dose_plans WHERE package_id = ? AND deleted_at IS NULL", [packageId])) {
      writes.push(...editRow("dose_plans", plan, { packageId: id }));
    }
    writes.push({ table: "packages", row: { ...shape, deletedAt: nowIso() } }, ...(await historyGone(packageId)));
    return writes;
  });
  return written.writes.length > 0 ? { id, written } : null;
}

/**
 * The person or place of the same name in another cabinet, made there when
 * there is none, as an import does; `null` for none.
 */
export async function nameThere(table: NamedTable, id: unknown, cabinetId: string, writes: RowWrite[]): Promise<string | null> {
  const named = await readNamed(table);
  const from = named.find((each) => each.id === id);
  if (!from) return null;
  const there = named.find((each) => each.cabinetId === cabinetId && foldName(each.name) === foldName(from.name));
  if (there) return there.id;
  const made = uuidv7();
  writes.push({ table, row: { id: made, cabinetId, name: from.name } });
  return made;
}

/**
 * A document's links to a box or a document that moved (F3.4): each taken
 * off the old id and put on the new, in the document's cabinet, so a moved
 * box keeps its prescription and a moved prescription its boxes.
 */
export async function relinked(column: "document_id" | "package_id", from: string, to: string, cabinetId?: string): Promise<RowWrite[]> {
  const sqlite = await getSqliteAsync();
  const writes: RowWrite[] = [];
  for (const link of await sqlite.getAllAsync<Record<string, unknown>>(`SELECT * FROM document_links WHERE ${column} = ? AND deleted_at IS NULL`, [from])) {
    const { tombstoneVersion: _, ...shape } = fromDbShape("document_links", link);
    const moved = { ...shape, [column === "document_id" ? "documentId" : "packageId"]: to, cabinetId: cabinetId ?? shape.cabinetId };
    // The pair's id, so linking it again later is this row; the new side is a new id, so no row has it yet.
    const id = await deterministicId(naturalKeys.documentLink(String(moved.documentId), String(moved.packageId ?? moved.productId)));
    writes.push({ table: "document_links", row: { ...moved, id } });
    writes.push({ table: "document_links", row: { ...shape, deletedAt: nowIso() } });
  }
  return writes;
}

function moveWrite(cabinetId: string, packageId: string, quantityMilli: number, reason: MoveReason): RowWrite {
  return { table: "package_moves", row: { id: uuidv7(), cabinetId, packageId, quantityMilli, reason } };
}

/** What a box holds now; never below nothing, though two devices may take more than was there. */
export async function remainingMilli(packageId: string): Promise<number> {
  const sqlite = await getSqliteAsync();
  // An aggregate always answers one row.
  const { total } = (await sqlite.getFirstAsync<{ total: number }>(
    "SELECT COALESCE(SUM(quantity_milli), 0) AS total FROM package_moves WHERE package_id = ? AND deleted_at IS NULL",
    [packageId],
  ))!;
  return Math.max(0, total);
}

/**
 * The cabinet a row lives in, read inside the write that hangs something from
 * it: a move or a tag goes where its box or product is, never where the person
 * is, or a household's box would gain a move in a cabinet no member reads.
 */
async function cabinetOf(table: "packages" | "products", id: string): Promise<string> {
  const there = await findRow(table, id);
  if (!there) throw new Error(`${table}: no such row`);
  return String(there.cabinet_id);
}

/** Take `milli` from a box. */
export async function takeFrom(packageId: string, milli: number): Promise<void> {
  assertAmount(milli, false);
  return writeRows(async () => [moveWrite(await cabinetOf("packages", packageId), packageId, -milli, "use")]);
}

/** Put `milli` into a box. */
export async function addTo(packageId: string, milli: number): Promise<void> {
  assertAmount(milli, false);
  return writeRows(async () => [moveWrite(await cabinetOf("packages", packageId), packageId, milli, "add")]);
}

/**
 * Set what a box holds to what was counted: the difference, read inside the
 * write, so a use landing meanwhile is not counted twice. A count that
 * matches writes nothing.
 */
export async function correctTo(packageId: string, countedMilli: number): Promise<void> {
  assertAmount(countedMilli, true);
  return writeRows(async () => {
    const cabinetId = await cabinetOf("packages", packageId);
    const difference = countedMilli - (await remainingMilli(packageId));
    return difference === 0 ? [] : [moveWrite(cabinetId, packageId, difference, "correction")];
  });
}

/** A box as stored: each field it may be given is there, null when not known. */
export type CabinetBox = { [K in keyof PackageFields]-?: Exclude<PackageFields[K], undefined> } & {
  id: string;
  cabinetId: string;
  productId: string;
  remainingMilli: number;
  /** Whether any amount was ever given: a box added with none is unknown, not empty. */
  counted: boolean;
  thumb: string | null;
  soonDays: number | null;
  /** When its amount last changed: a reminder says a box ran low the morning after. */
  movedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface CabinetProduct extends ProductFields {
  id: string;
  cabinetId: string;
  note: string | null;
  starred: boolean;
  wanted: boolean;
  photoId: string | null;
  thumb: string | null;
  /** The tags on it that are still the cabinet's: a deleted tag leaves its products untagged. */
  tagIds: string[];
  boxes: CabinetBox[];
}

export interface BoxMove {
  id: string;
  quantityMilli: number;
  reason: MoveReason;
  createdAt: string;
  /** Who wrote it, once the server has it (F2.8). */
  createdBy: string | null;
}

/** A box's moves, newest first: its own history of what was used, added and counted. */
export async function readMoves(packageId: string): Promise<BoxMove[]> {
  const sqlite = await getSqliteAsync();
  return sqlite.getAllAsync<BoxMove>(
    `SELECT id, quantity_milli AS quantityMilli, reason, created_at AS createdAt, created_by AS createdBy FROM package_moves
      WHERE package_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
    [packageId],
  );
}

/** Change a product's own fields, its star and its place on the list to buy among them; each box keeps its own. */
export async function editProduct(productId: string, patch: Partial<Omit<ProductFields, "gtin">> & { note?: string | null; starred?: boolean; wanted?: boolean }): Promise<void> {
  return writeRows(async () => {
    const there = await findRow("products", productId);
    return there && there.deleted_at == null ? editRow("products", there, patch) : [];
  });
}

/**
 * Delete boxes, each with its history: a change row holds the words a box had,
 * its note and nickname before and after, and a tombstone keeps none (F7.11).
 * One write `undoRows` takes back whole, the history with its box; `null` when
 * every box was already gone.
 */
export async function deleteBoxes(packageIds: readonly string[]): Promise<RowsWritten | null> {
  const written = await writeUndoable(async () => {
    const writes: RowWrite[] = [];
    for (const id of new Set(packageIds)) {
      const there = await findRow("packages", id);
      if (there && there.deleted_at == null) writes.push({ table: "packages", row: { ...fromDbShape("packages", there), deletedAt: nowIso() } }, ...(await historyGone(id)));
    }
    return writes;
  });
  return written.writes.length > 0 ? written : null;
}

/** The tombstones of a box's live change rows. */
async function historyGone(packageId: string): Promise<RowWrite[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<Record<string, unknown>>("SELECT * FROM package_changes WHERE package_id = ? AND deleted_at IS NULL", [packageId]);
  return rows.map((row) => ({ table: "package_changes" as const, row: { ...fromDbShape("package_changes", row), deletedAt: nowIso() } }));
}

/**
 * Change the same fields of each box named, never their product or another
 * box, in one write `undoRows` takes back whole; `null` when nothing changed.
 * The unit is not among what changes: every move was counted in the one the
 * box had. A box deleted meanwhile is left as it is.
 */
export async function editBoxes(packageIds: readonly string[], patch: Omit<Partial<PackageFields>, "unit" | "photoId">): Promise<RowsWritten | null> {
  const written = await writeUndoable(async () => {
    const writes: RowWrite[] = [];
    for (const id of new Set(packageIds)) {
      const there = await findRow("packages", id);
      if (there && there.deleted_at == null) writes.push(...boxEdit(there, patch));
    }
    return writes;
  });
  return written.writes.length > 0 ? written : null;
}

/**
 * A box's edit and the change row that records it (`docs/TASKS.md` F1.21):
 * each field it changed, before and after. A row of its own rather than a
 * column, so two devices editing one box offline both keep their history.
 */
function boxEdit(stored: Record<string, unknown>, patch: Record<string, unknown>): RowWrite[] {
  const edit = editRow("packages", stored, patch);
  if (edit.length === 0) return [];
  const before = fromDbShape("packages", stored);
  const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => before[key] !== value).map(([key, value]) => [key, [before[key], value]]));
  return [...edit, { table: "package_changes", row: { id: uuidv7(), cabinetId: before.cabinetId, packageId: before.id, changes: JSON.stringify(changes) } }];
}

export interface BoxChange {
  id: string;
  /** Each field changed, as `[before, after]`. */
  changes: Record<string, [unknown, unknown]>;
  createdAt: string;
  createdBy: string | null;
}

/** A box's edits, newest first; its moves are the rest of its history. */
export async function readChanges(packageId: string): Promise<BoxChange[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<{ id: string; changes: string; createdAt: string; createdBy: string | null }>(
    `SELECT id, changes, created_at AS createdAt, created_by AS createdBy FROM package_changes
      WHERE package_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
    [packageId],
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes) as BoxChange["changes"] }));
}

/** One thing a household's centre says; `count` boxes added together, `boxId` the one when it is one. */
export interface HouseholdEvent {
  kind: "memberJoined" | "boxAdded" | "boxLeft";
  at: string;
  /** The member who did it, by the name they joined with. */
  byName: string | null;
  /** The household's name for one who joined, else the box's. */
  name: string;
  count: number;
  cabinetId: string;
  boxId: string | null;
}

/** One move or edit in a household's history (`docs/TASKS.md` F2.8), with the box it was made on. */
export interface Activity {
  id: string;
  at: string;
  by: string | null;
  boxId: string;
  name: string;
  unit: PackageFields["unit"];
  /** A move's; null for an edit. */
  reason: MoveReason | null;
  quantityMilli: number | null;
  /** An edit's; null for a move. */
  changes: BoxChange["changes"] | null;
}

/**
 * What happened in the person's households that the centre tells them
 * (`docs/TASKS.md` F2.11): someone joined after them, and boxes another member
 * added, a day's at once, or took out of the cabinet. Worked out from the rows
 * on the device, as the reminders are; the server names each writer.
 */
export async function readHouseholdEvents(me: string): Promise<HouseholdEvent[]> {
  const sqlite = await getSqliteAsync();
  const box = "JOIN packages b ON b.id = h.package_id AND b.deleted_at IS NULL JOIN products p ON p.id = b.product_id";
  const by = "(SELECT name FROM cabinet_members WHERE cabinet_id = h.cabinet_id AND user_id = h.created_by)";
  const others = `h.deleted_at IS NULL AND h.created_by IS NOT NULL AND h.created_by <> ? AND ${inLiveCabinet("h.cabinet_id")}`;
  return sqlite.getAllAsync<HouseholdEvent>(
    `SELECT 'memberJoined' AS kind, m.created_at AS at, m.name AS byName, c.name AS name, 1 AS count, c.id AS cabinetId, NULL AS boxId
       FROM cabinet_members m JOIN cabinet_members mine ON mine.cabinet_id = m.cabinet_id AND mine.user_id = ? AND mine.deleted_at IS NULL
       JOIN cabinets c ON c.id = m.cabinet_id AND c.deleted_at IS NULL
      WHERE m.deleted_at IS NULL AND m.user_id <> ? AND m.created_at > mine.created_at
     UNION ALL
     SELECT 'boxAdded', MAX(h.created_at), ${by}, MIN(COALESCE(b.nickname, p.name)), COUNT(*), h.cabinet_id, MIN(b.id)
       FROM package_moves h ${box} WHERE h.reason = 'initial' AND ${others}
      GROUP BY h.cabinet_id, h.created_by, substr(h.created_at, 1, 10)
     UNION ALL
     SELECT 'boxLeft', h.created_at, ${by}, COALESCE(b.nickname, p.name), 1, h.cabinet_id, b.id
       FROM package_changes h ${box} WHERE json_extract(h.changes, '$.disposition[1]') IS NOT NULL AND ${others}`,
    [me, me, me, me],
  );
}

/** A cabinet's latest moves and edits on its live boxes, newest first. */
export async function readActivity(cabinetId: string, limit = 30): Promise<Activity[]> {
  const sqlite = await getSqliteAsync();
  const on = "JOIN packages b ON b.id = h.package_id AND b.deleted_at IS NULL JOIN products p ON p.id = b.product_id";
  const what = "h.id AS id, h.created_at AS at, h.created_by AS by, h.package_id AS boxId, COALESCE(b.nickname, p.name) AS name, b.unit";
  const rows = await sqlite.getAllAsync<Omit<Activity, "changes"> & { changes: string | null }>(
    `SELECT ${what}, h.reason, h.quantity_milli AS quantityMilli, NULL AS changes FROM package_moves h ${on} WHERE h.cabinet_id = ? AND h.deleted_at IS NULL
     UNION ALL
     SELECT ${what}, NULL, NULL, h.changes FROM package_changes h ${on} WHERE h.cabinet_id = ? AND h.deleted_at IS NULL
     ORDER BY at DESC, id DESC LIMIT ?`,
    [cabinetId, cabinetId, limit],
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes ?? "null") as BoxChange["changes"] | null }));
}

/** A person's, a product's, a box's or a household's photo, or with `null` taken off; a box records it in its history. */
export async function setPhoto(table: "people" | "products" | "packages" | "cabinets", id: string, change: NewPhoto | null): Promise<void> {
  return writeRows(async () => {
    const there = await findRow(table, id);
    if (!there || there.deleted_at != null) return [];
    const patch = await photoColumn(change);
    return table === "packages" ? boxEdit(there, patch) : editRow(table, there, patch);
  });
}

/**
 * A deleted household's rows stay live under its tombstone, as Gital's list's
 * items do, until sync lets the household go a week later; every read leaves
 * them out. Written as "not in a deleted one", since the person's own cabinet
 * reaches a device only with its first pull.
 */
export const inLiveCabinet = (column: string) => `${column} NOT IN (SELECT id FROM cabinets WHERE deleted_at IS NOT NULL)`;

/** Every product with a box in it or still to be bought, by name, each box soonest to expire first. */
export async function readCabinet(): Promise<CabinetProduct[]> {
  const sqlite = await getSqliteAsync();
  // A photo's bytes stay out of the list: the thumbnail alone, and none until it has reached this device.
  const products = await sqlite.getAllAsync<Record<string, unknown> & { thumb: string | null }>(
    `SELECT p.*, (SELECT thumb FROM photos WHERE id = p.photo_id) AS thumb FROM products p WHERE p.deleted_at IS NULL AND ${inLiveCabinet("p.cabinet_id")}`,
  );
  // A box near its end as many days ahead as it was given, else as its owner was.
  const boxes = await sqlite.getAllAsync<Record<string, unknown> & { total: number; moves: number; thumb: string | null; soonDays: number | null; movedAt: string | null }>(
    `SELECT k.*, COALESCE(SUM(m.quantity_milli), 0) AS total, COUNT(m.id) AS moves, MAX(m.created_at) AS movedAt,
            (SELECT thumb FROM photos WHERE id = k.photo_id) AS thumb,
            COALESCE(k.warn_days, (SELECT warn_days FROM people WHERE id = k.person_id AND deleted_at IS NULL)) AS soonDays
       FROM packages k LEFT JOIN package_moves m ON m.package_id = k.id AND m.deleted_at IS NULL
      WHERE k.deleted_at IS NULL
      GROUP BY k.id
      ORDER BY k.expires_on IS NULL, k.expires_on, k.created_at`,
  );
  const tagged = await sqlite.getAllAsync<{ productId: string; tagId: string }>(
    `SELECT pt.product_id AS productId, pt.tag_id AS tagId FROM product_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.deleted_at IS NULL AND t.deleted_at IS NULL`,
  );
  const tagIds = new Map<string, string[]>();
  for (const { productId, tagId } of tagged) tagIds.set(productId, [...(tagIds.get(productId) ?? []), tagId]);
  const byProduct = new Map<string, CabinetBox[]>();
  for (const { total, moves, thumb, soonDays, movedAt, ...stored } of boxes) {
    const box = { ...(fromDbShape("packages", stored) as Omit<CabinetBox, "remainingMilli" | "counted" | "thumb" | "soonDays" | "movedAt">), remainingMilli: Math.max(0, total), counted: moves > 0, thumb, soonDays, movedAt };
    byProduct.set(box.productId, [...(byProduct.get(box.productId) ?? []), box]);
  }
  return products
    .map(({ thumb, ...stored }) => ({
      ...(fromDbShape("products", stored) as Omit<CabinetProduct, "boxes" | "tagIds" | "thumb">),
      thumb,
      tagIds: tagIds.get(String(stored.id)) ?? [],
      boxes: byProduct.get(String(stored.id)) ?? [],
    }))
    .filter((product) => product.boxes.length > 0 || product.wanted)
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

/** The cabinet's own product of this GTIN, which a scan fills the form from before any catalogue. */
export async function findProduct(cabinetId: string, gtin: string): Promise<ProductFields | null> {
  const there = await findRow("products", await deterministicId(naturalKeys.product(cabinetId, gtin)));
  if (!there || there.deleted_at != null) return null;
  const { name, brand, activeSubstance, strength, form, pack, manufacturer } = fromDbShape("products", there) as unknown as ProductFields;
  return { name, brand, activeSubstance, strength, form, pack, manufacturer, gtin };
}

/** Whether this very box, by its GTIN and serial, is in the cabinet already. */
export async function hasBox(gtin: string, serial: string): Promise<boolean> {
  const sqlite = await getSqliteAsync();
  const found = await sqlite.getFirstAsync(
    `SELECT 1 FROM packages k JOIN products p ON p.id = k.product_id
      WHERE p.gtin = ? AND k.serial = ? AND k.deleted_at IS NULL AND p.deleted_at IS NULL AND ${inLiveCabinet("p.cabinet_id")}`,
    [gtin, serial],
  );
  return found != null;
}

/**
 * Put a tag on a product, or take it off. The row's id is the pair's, so a
 * tag taken off and put back, here or on another device, is the one row.
 */
export async function tagProduct(productId: string, tagId: string, on: boolean): Promise<void> {
  const id = await deterministicId(naturalKeys.productTag(productId, tagId));
  return writeRows(async () => {
    const there = await findRow("product_tags", id);
    if (there) return editRow("product_tags", there, { deletedAt: on ? null : nowIso() });
    return on ? [{ table: "product_tags", row: { id, cabinetId: await cabinetOf("products", productId), productId, tagId } }] : [];
  });
}

export type NamedTable = "people" | "locations" | "tags";

/** A row names only what is in its own cabinet: a picker shows those whose `cabinetId` is the row's. */
export interface Named {
  id: string;
  name: string;
  cabinetId: string;
}

/** The people or the places a box can be given, or the tags a product can, by name. */
export async function readNamed(table: NamedTable): Promise<Named[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<Named>(`SELECT id, name, cabinet_id AS cabinetId FROM ${table} WHERE deleted_at IS NULL AND ${inLiveCabinet("cabinet_id")}`);
  return rows.sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

export interface Person extends Named {
  /** A pet's boxes are under a profile of its own (F2.10); "self" is not offered, the profile names the person. */
  kind: (typeof PERSON_KINDS)[number];
  color: (typeof PERSON_COLORS)[number] | null;
  warnDays: number | null;
  photoId: string | null;
  thumb: string | null;
  allergies: string | null;
  conditions: string | null;
}

/** The people boxes are for, with what tells them apart and their own notice ahead of an expiry. */
export async function readPeople(): Promise<Person[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<Person>(
    `SELECT id, name, cabinet_id AS cabinetId, kind, color, warn_days AS warnDays, photo_id AS photoId, (SELECT thumb FROM photos WHERE id = photo_id) AS thumb, allergies, conditions
       FROM people WHERE deleted_at IS NULL AND ${inLiveCabinet("cabinet_id")}`,
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

/** A person's colour, notice ahead of an expiry or health words; `null` goes back to the default. */
export async function editPerson(
  id: string,
  patch: { kind?: Person["kind"]; color?: Person["color"]; warnDays?: number | null; allergies?: string | null; conditions?: string | null },
): Promise<void> {
  return writeRows(async () => {
    const there = await findRow("people", id);
    return there && there.deleted_at == null ? editRow("people", there, patch) : [];
  });
}

/**
 * A person's, a place's or a tag's new name. Deleting one is `deleteRows`: a
 * box that named it reads as unassigned, a product as untagged, so no row
 * that names it is rewritten.
 */
export async function renameNamed(table: NamedTable | "cabinets", id: string, name: string): Promise<void> {
  return writeRows(async () => {
    const there = await findRow(table, id);
    return there && there.deleted_at == null ? editRow(table, there, { name }) : [];
  });
}

export interface Member {
  id: string;
  userId: string;
  role: MemberRole;
  name: string;
}

/** A household the person is in or made: the ones Dolabım shows beside the person's own cabinet. */
export interface Household {
  id: string;
  name: string;
  ownerId: string;
  photoId: string | null;
  thumb: string | null;
  /** Who is in it, the owner first; none until it is first shared, since only the server adds a member. */
  members: Member[];
}

/** The households on this device, by name. The personal cabinet's id is its owner's, a household's never is. */
export async function readHouseholds(): Promise<Household[]> {
  const sqlite = await getSqliteAsync();
  const cabinets = await sqlite.getAllAsync<Omit<Household, "members">>(
    "SELECT id, name, owner_id AS ownerId, photo_id AS photoId, (SELECT thumb FROM photos WHERE id = photo_id) AS thumb FROM cabinets WHERE deleted_at IS NULL AND id <> owner_id",
  );
  const members = await sqlite.getAllAsync<Member & { cabinetId: string }>(
    "SELECT id, cabinet_id AS cabinetId, user_id AS userId, role, name FROM cabinet_members WHERE deleted_at IS NULL ORDER BY role <> 'owner', name, id",
  );
  return cabinets
    .map((cabinet) => ({ ...cabinet, members: members.filter((member) => member.cabinetId === cabinet.id).map(({ cabinetId: _, ...member }) => member) }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

/**
 * Whether the person may change what is in `cabinetId`: their own cabinet, a
 * household they made (before the server has added them as its member) or one
 * they edit. A viewer's write would be refused by the server and set aside by
 * sync, the box changed on this device alone, so the screens offer none.
 */
export function writes(households: readonly Pick<Household, "id" | "ownerId" | "members">[], me: string | null, cabinetId: string): boolean {
  if (cabinetId === me) return true;
  const household = households.find((each) => each.id === cabinetId);
  return household?.ownerId === me || household?.members.find((member) => member.userId === me)?.role === "editor";
}

/**
 * What a device may write of a membership (migration 7's guard keeps the
 * rest): the owner removes a member or changes their role, and a member
 * removes themselves, which is leaving. The device lets the household go once
 * the server has heard.
 */
async function editMember(id: string, patch: Partial<Pick<Member, "role">> & { deletedAt?: string }): Promise<void> {
  await writeRows(async () => {
    const there = await findRow("cabinet_members", id);
    return there && there.deleted_at == null ? editRow("cabinet_members", there, patch) : [];
  });
}

export const removeMember = (id: string) => editMember(id, { deletedAt: nowIso() });

export const setMemberRole = (id: string, role: Exclude<MemberRole, "owner">) => editMember(id, { role });

/** A new household, made on this device as Gital's lists are (migration 5); its id is returned. */
export async function openHousehold(ownerId: string, name: string): Promise<string> {
  const id = uuidv7();
  await writeRows([{ table: "cabinets", row: { id, ownerId, name } }]);
  return id;
}

/** A person a box is for, a place one is kept, or a tag; its id is returned. */
export async function addNamed(table: NamedTable, cabinetId: string, name: string): Promise<string> {
  const id = uuidv7();
  await writeRows([{ table, row: { id, cabinetId, name } }]);
  return id;
}
