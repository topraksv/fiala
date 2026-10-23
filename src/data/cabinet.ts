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
import type { MOVE_REASONS, PACKAGE_DISPOSITIONS, PACKAGE_UNITS, PERSON_COLORS } from "../db/schema";
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
  // Another box of a product already held: only a delete made meanwhile on another device needs undoing, and editRow writes nothing otherwise.
  // The box goes where its product is, which may be a household rather than the cabinet asked for.
  if ("id" in product) {
    const held = await findRow("products", product.id);
    if (!held) throw new Error(`no product ${product.id}`);
    return { id: product.id, cabinetId: String(held.cabinet_id), writes: editRow("products", held, { deletedAt: null }) };
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
}

/** A box's moves, newest first: its own history of what was used, added and counted. */
export async function readMoves(packageId: string): Promise<BoxMove[]> {
  const sqlite = await getSqliteAsync();
  return sqlite.getAllAsync<BoxMove>(
    `SELECT id, quantity_milli AS quantityMilli, reason, created_at AS createdAt FROM package_moves
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
}

/** A box's edits, newest first; its moves are the rest of its history. */
export async function readChanges(packageId: string): Promise<BoxChange[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<{ id: string; changes: string; createdAt: string }>(
    `SELECT id, changes, created_at AS createdAt FROM package_changes
      WHERE package_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
    [packageId],
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes) as BoxChange["changes"] }));
}

/** A person's, a product's or a box's photo, or with `null` taken off; a box records it in its history. */
export async function setPhoto(table: "people" | "products" | "packages", id: string, change: NewPhoto | null): Promise<void> {
  return writeRows(async () => {
    const there = await findRow(table, id);
    if (!there || there.deleted_at != null) return [];
    const patch = await photoColumn(change);
    return table === "packages" ? boxEdit(there, patch) : editRow(table, there, patch);
  });
}

/** Every product with a box in it or still to be bought, by name, each box soonest to expire first. */
export async function readCabinet(): Promise<CabinetProduct[]> {
  const sqlite = await getSqliteAsync();
  // A photo's bytes stay out of the list: the thumbnail alone, and none until it has reached this device.
  const products = await sqlite.getAllAsync<Record<string, unknown> & { thumb: string | null }>(
    "SELECT p.*, (SELECT thumb FROM photos WHERE id = p.photo_id) AS thumb FROM products p WHERE p.deleted_at IS NULL",
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
      WHERE p.gtin = ? AND k.serial = ? AND k.deleted_at IS NULL AND p.deleted_at IS NULL`,
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
  const rows = await sqlite.getAllAsync<Named>(`SELECT id, name, cabinet_id AS cabinetId FROM ${table} WHERE deleted_at IS NULL`);
  return rows.sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

export interface Person extends Named {
  color: (typeof PERSON_COLORS)[number] | null;
  warnDays: number | null;
  photoId: string | null;
  thumb: string | null;
}

/** The people boxes are for, with what tells them apart and their own notice ahead of an expiry. */
export async function readPeople(): Promise<Person[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<Person>(
    `SELECT id, name, cabinet_id AS cabinetId, color, warn_days AS warnDays, photo_id AS photoId, (SELECT thumb FROM photos WHERE id = photo_id) AS thumb
       FROM people WHERE deleted_at IS NULL`,
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

/** A person's colour or notice ahead of an expiry; `null` goes back to the default. */
export async function editPerson(id: string, patch: { color?: Person["color"]; warnDays?: number | null }): Promise<void> {
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
export async function renameNamed(table: NamedTable, id: string, name: string): Promise<void> {
  return writeRows(async () => {
    const there = await findRow(table, id);
    return there && there.deleted_at == null ? editRow(table, there, { name }) : [];
  });
}

/** A person a box is for, a place one is kept, or a tag; its id is returned. */
export async function addNamed(table: NamedTable, cabinetId: string, name: string): Promise<string> {
  const id = uuidv7();
  await writeRows([{ table, row: { id, cabinetId, name } }]);
  return id;
}
