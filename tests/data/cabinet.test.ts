/**
 * The cabinet's boxes over the real write layer: what a box holds is the sum
 * of its moves, a GTIN finds its product, and every row names its cabinet.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);

const { addNamed, addPackage, addTo, correctTo, editBoxes, editPerson, editProduct, findProduct, hasBox, importBoxes, readCabinet, readChanges, readMoves, readNamed, readPeople, remainingMilli, renameNamed, setPhoto, tagProduct, takeFrom } = await import("../../src/data/cabinet");
const { deleteRows, undoRows } = await import("../../src/db/mutations");
const { migratedDatabase } = await import("../helpers");
const { readPhoto } = await import("../../src/data/photos");

const PAROL = { name: "Parol", strength: "500 mg", gtin: "8699546090112" };
const PHOTO = { data: "data:image/jpeg;base64,RlVMTA==", thumb: "data:image/jpeg;base64,VEhVTUI=" };

const all = (sql: string) => harness.db!.prepare(sql).all() as Record<string, unknown>[];
const outbox = () => all("SELECT table_name FROM outbox ORDER BY id").map((row) => row.table_name);

beforeEach(() => {
  harness.db = migratedDatabase();
});

describe("adding a box", () => {
  it("writes its product, the box and what it holds, in its cabinet, and queues all three", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2027-03-31" }, 20_000);
    const [product] = all("SELECT * FROM products");
    expect(product).toMatchObject({ cabinet_id: "me", name: "Parol", strength: "500 mg", gtin: "8699546090112" });
    expect(all("SELECT * FROM packages")).toEqual([
      expect.objectContaining({ id: box, cabinet_id: "me", product_id: product!.id, unit: "tablet", expires_on: "2027-03-31" }),
    ]);
    expect(all("SELECT cabinet_id, package_id, quantity_milli, reason FROM package_moves")).toEqual([
      { cabinet_id: "me", package_id: box, quantity_milli: 20_000, reason: "initial" },
    ]);
    expect(outbox()).toEqual(["products", "packages", "package_moves"]);
    expect(await remainingMilli(box)).toBe(20_000);
  });

  it("puts a second box of the same GTIN under the first one's product, and writes the product once", async () => {
    const first = await addPackage("me", PAROL, { unit: "tablet" }, 20_000);
    harness.db!.exec("DELETE FROM outbox");
    const second = await addPackage("me", { ...PAROL, name: "Parol 500" }, { unit: "tablet" }, 10_000);
    const products = all("SELECT id, name FROM products");
    expect(products).toEqual([{ id: expect.any(String), name: "Parol" }]);
    expect(all("SELECT DISTINCT product_id FROM packages")).toEqual([{ product_id: products[0]!.id }]);
    expect(outbox()).toEqual(["packages", "package_moves"]);
    expect(first).not.toBe(second);
  });

  it("finds the GTIN's product in its own cabinet only", async () => {
    await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    await addPackage("home", PAROL, { unit: "tablet" }, 1000);
    expect(all("SELECT cabinet_id FROM products ORDER BY cabinet_id")).toEqual([{ cabinet_id: "home" }, { cabinet_id: "me" }]);
  });

  it("brings a deleted product back with what was read now", async () => {
    await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const [{ id }] = all("SELECT id FROM products") as [{ id: string }];
    await deleteRows("products", [id]);
    await addPackage("me", { ...PAROL, name: "Parol Fort" }, { unit: "tablet" }, 1000);
    expect(all("SELECT id, name, deleted_at FROM products")).toEqual([{ id, name: "Parol Fort", deleted_at: null }]);
  });

  it("adds another box to a held product by its id, with or without a GTIN, and brings it back if deleted meanwhile", async () => {
    await addPackage("me", { name: "Şurup" }, { unit: "ml" }, 100_000);
    const [{ id }] = all("SELECT id FROM products") as [{ id: string }];
    harness.db!.exec("DELETE FROM outbox");
    await addPackage("me", { id }, { unit: "ml" }, 50_000);
    expect(all("SELECT DISTINCT product_id FROM packages")).toEqual([{ product_id: id }]);
    expect(outbox()).toEqual(["packages", "package_moves"]);
    await deleteRows("products", [id]);
    await addPackage("me", { id }, { unit: "ml" }, 0);
    expect(all("SELECT name, deleted_at FROM products")).toEqual([{ name: "Şurup", deleted_at: null }]);
    await expect(addPackage("me", { id: "none" }, { unit: "ml" }, 0)).rejects.toThrow("no product none");
    expect(all("SELECT id FROM packages")).toHaveLength(3);
  });

  it("makes each product without a GTIN its own", async () => {
    await addPackage("me", { name: "Şurup" }, { unit: "ml" }, 100_000);
    await addPackage("me", { name: "Şurup", gtin: "" }, { unit: "ml" }, 100_000);
    expect(all("SELECT gtin FROM products")).toEqual([{ gtin: null }, { gtin: null }]);
  });

  it("writes no move for an empty box, and refuses an amount that is not whole thousandths", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet" }, 0);
    expect(all("SELECT * FROM package_moves")).toEqual([]);
    expect(await remainingMilli(box)).toBe(0);
    for (const amount of [-1, 0.5, Number.NaN]) {
      await expect(addPackage("me", PAROL, { unit: "tablet" }, amount), String(amount)).rejects.toThrow(`invalid amount ${amount}`);
    }
    expect(all("SELECT id FROM packages")).toHaveLength(1);
  });
});

describe("what a box holds", () => {
  let box: string;
  beforeEach(async () => {
    box = await addPackage("me", PAROL, { unit: "tablet" }, 20_000);
  });

  it("goes down with a use and up with an addition, each its own move", async () => {
    await takeFrom(box, 1500);
    await addTo(box, 10_000);
    expect(await remainingMilli(box)).toBe(28_500);
    expect(all("SELECT quantity_milli, reason FROM package_moves ORDER BY id")).toEqual([
      { quantity_milli: 20_000, reason: "initial" },
      { quantity_milli: -1500, reason: "use" },
      { quantity_milli: 10_000, reason: "add" },
    ]);
  });

  it("refuses a use or an addition of nothing or less", async () => {
    for (const write of [takeFrom, addTo]) {
      for (const amount of [0, -1000, 1.5]) await expect(write(box, amount)).rejects.toThrow(`invalid amount ${amount}`);
    }
    expect(await remainingMilli(box)).toBe(20_000);
  });

  it("counts a deleted move no more, and never says less than nothing", async () => {
    await takeFrom(box, 25_000);
    expect(await remainingMilli(box)).toBe(0);
    const [{ id }] = all("SELECT id FROM package_moves WHERE reason = 'use'") as [{ id: string }];
    await deleteRows("package_moves", [id]);
    expect(await remainingMilli(box)).toBe(20_000);
  });

  it("is set to a count by the difference, and a count that matches writes nothing", async () => {
    await takeFrom(box, 2000);
    await correctTo(box, 15_000);
    expect(await remainingMilli(box)).toBe(15_000);
    expect(all("SELECT quantity_milli FROM package_moves WHERE reason = 'correction'")).toEqual([{ quantity_milli: -3000 }]);
    await correctTo(box, 16_000);
    expect(all("SELECT quantity_milli FROM package_moves WHERE reason = 'correction' ORDER BY id")).toEqual([{ quantity_milli: -3000 }, { quantity_milli: 1000 }]);
    await correctTo(box, 0);
    expect(await remainingMilli(box), "a box counted empty").toBe(0);
    await correctTo(box, 16_000);
    const moves = all("SELECT id FROM package_moves").length;
    await correctTo(box, 16_000);
    await expect(correctTo(box, -1)).rejects.toThrow("invalid amount -1");
    expect(all("SELECT id FROM package_moves")).toHaveLength(moves);
  });

  it("keeps its own history, newest first, without a deleted move or another box's", async () => {
    await takeFrom(box, 1500);
    await addTo(box, 1000);
    await addPackage("me", PAROL, { unit: "tablet" }, 5000);
    const moves = await readMoves(box);
    expect(moves.map(({ quantityMilli, reason }) => ({ quantityMilli, reason }))).toEqual([
      { quantityMilli: 1000, reason: "add" },
      { quantityMilli: -1500, reason: "use" },
      { quantityMilli: 20_000, reason: "initial" },
    ]);
    expect(moves[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await deleteRows("package_moves", [moves[0]!.id]);
    expect(await readMoves(box)).toHaveLength(2);
  });

  it("hangs a move or a tag in the cabinet its box or product is in, never the person's", async () => {
    const house = await addPackage("house", PAROL, { unit: "tablet" }, 5000);
    const productId = String(all(`SELECT product_id FROM packages WHERE id = '${house}'`)[0]!.product_id);
    await takeFrom(house, 1000);
    await addTo(house, 2000);
    await correctTo(house, 1000);
    await tagProduct(productId, "pain", true);
    expect(all(`SELECT DISTINCT cabinet_id FROM package_moves WHERE package_id = '${house}'`)).toEqual([{ cabinet_id: "house" }]);
    expect(all("SELECT cabinet_id FROM product_tags")).toEqual([{ cabinet_id: "house" }]);
    const another = await addPackage("me", { id: productId }, { unit: "tablet" }, 1000);
    expect(all(`SELECT DISTINCT cabinet_id FROM package_moves WHERE package_id = '${another}'`), "another box of it goes where the product is").toEqual([{ cabinet_id: "house" }]);
    expect(all(`SELECT cabinet_id FROM packages WHERE id = '${another}'`)).toEqual([{ cabinet_id: "house" }]);
    for (const write of [takeFrom, addTo, correctTo]) await expect(write("none", 1000)).rejects.toThrow("packages: no such row");
    await expect(tagProduct("none", "pain", true)).rejects.toThrow("products: no such row");
  });

  it("is another box's sum only for that box", async () => {
    const other = await addPackage("me", PAROL, { unit: "tablet" }, 5000);
    await takeFrom(other, 1000);
    expect([await remainingMilli(box), await remainingMilli(other), await remainingMilli("none")]).toEqual([20_000, 4000, 0]);
  });
});

describe("changing a product", () => {
  it("changes its own fields and note, never its GTIN's boxes, and leaves a deleted one deleted", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2027-03-31" }, 1000);
    const [{ id }] = all("SELECT id FROM products") as [{ id: string }];
    harness.db!.exec("DELETE FROM outbox");
    await editProduct(id, { name: "Parol 500", note: "aç karnına" });
    expect(all("SELECT name, note, gtin FROM products")).toEqual([{ name: "Parol 500", note: "aç karnına", gtin: PAROL.gtin }]);
    expect(all("SELECT id, expires_on FROM packages")).toEqual([{ id: box, expires_on: "2027-03-31" }]);
    expect(outbox()).toEqual(["products"]);
    await deleteRows("products", [id]);
    harness.db!.exec("DELETE FROM outbox");
    await editProduct(id, { name: "x" });
    await editProduct("none", { name: "x" });
    expect(outbox()).toEqual([]);
  });

  it("puts a product on the list to buy and takes it off", async () => {
    await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const id = (await readCabinet())[0]!.id;
    expect((await readCabinet())[0]!.wanted).toBe(false);
    await editProduct(id, { wanted: true });
    expect((await readCabinet())[0]!.wanted).toBe(true);
  });
});

describe("changing a box", () => {
  it("changes the boxes named alone, in one write undone whole, and leaves a deleted box deleted", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2027-03-31" }, 1000);
    const other = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2027-03-31" }, 1000);
    const third = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2027-03-31" }, 1000);
    harness.db!.exec("DELETE FROM outbox");
    const written = await editBoxes([box, third, box], { expiresOn: "2028-01-31", personId: "p1", openedOn: null });
    expect(all("SELECT id, expires_on, person_id, unit FROM packages ORDER BY expires_on, id")).toEqual([
      { id: other, expires_on: "2027-03-31", person_id: null, unit: "tablet" },
      { id: box, expires_on: "2028-01-31", person_id: "p1", unit: "tablet" },
      { id: third, expires_on: "2028-01-31", person_id: "p1", unit: "tablet" },
    ]);
    expect(outbox()).toEqual(["packages", "package_changes", "packages", "package_changes"]);
    expect(await readChanges(box), "what changed, before and after, and not what was already so").toEqual([
      { id: expect.any(String), changes: { expiresOn: ["2027-03-31", "2028-01-31"], personId: [null, "p1"] }, createdAt: expect.any(String) },
    ]);
    expect(all("SELECT DISTINCT cabinet_id FROM package_changes")).toEqual([{ cabinet_id: "me" }]);
    await undoRows(written!);
    expect(all("SELECT DISTINCT expires_on, person_id FROM packages")).toEqual([{ expires_on: "2027-03-31", person_id: null }]);
    expect(await readChanges(box), "an undone edit leaves no history").toEqual([]);
    expect(await editBoxes([other], { expiresOn: "2027-03-31" }), "nothing to change").toBeNull();
    await deleteRows("packages", [box]);
    harness.db!.exec("DELETE FROM outbox");
    expect(await editBoxes([box, "none"], { expiresOn: "2029-01-31" })).toBeNull();
    expect(outbox()).toEqual([]);
  });

  it("keeps what else is known of it, read back as it was written, and why it left the cabinet", async () => {
    const box = await addPackage("me", PAROL, { unit: "ml" }, 100_000);
    const known = { nickname: "Benim şurubum", useWithinDays: 28, lowMilli: 20_500, acquiredOn: "2027-01-15", acquiredFrom: "Mahalle eczanesi", note: "Buzdolabında", disposition: "archived" } as const;
    await editBoxes([box], known);
    const read = (await readCabinet())[0]!.boxes[0];
    expect(read).toMatchObject(known);
    await editBoxes([box], { disposition: null });
    expect((await readCabinet())[0]!.boxes[0]!.disposition).toBeNull();
  });
});

describe("a box's history of edits", () => {
  it("is its own, newest first, one row an edit", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const other = await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    await editBoxes([box], { nickname: "Benim" });
    await editBoxes([box], { nickname: null, disposition: "disposed" });
    await editBoxes([other], { note: "x" });
    expect((await readChanges(box)).map((change) => change.changes)).toEqual([{ nickname: ["Benim", null], disposition: [null, "disposed"] }, { nickname: [null, "Benim"] }]);
  });
});

describe("a photo", () => {
  it("is stored on the device and named by the row, its thumbnail read with the cabinet, and taken off with null", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const productId = String(all("SELECT id FROM products")[0]!.id);
    await setPhoto("products", productId, PHOTO);
    await setPhoto("packages", box, PHOTO);
    const [product] = await readCabinet();
    expect(product).toMatchObject({ thumb: PHOTO.thumb, photoId: expect.any(String) });
    expect(product!.boxes[0]).toMatchObject({ thumb: PHOTO.thumb, photoId: expect.any(String) });
    expect(product!.photoId, "a photo is never shared: each save is a new one").not.toBe(product!.boxes[0]!.photoId);
    expect(all("SELECT data, uploaded_at FROM photos")).toEqual([{ data: PHOTO.data, uploaded_at: null }, { data: PHOTO.data, uploaded_at: null }]);
    expect(await readPhoto(product!.photoId!), "the full size opens in the viewer").toBe(PHOTO.data);
    expect(await readPhoto("not-here-yet"), "one still to be fetched").toBeNull();
    expect((await readChanges(box))[0]!.changes, "a box's photo is in its history").toEqual({ photoId: [null, product!.boxes[0]!.photoId] });
    await setPhoto("products", productId, null);
    expect((await readCabinet())[0]).toMatchObject({ thumb: null, photoId: null });
  });

  it("is refused unless the app encoded it, and writes nothing on a deleted row", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    await expect(setPhoto("packages", box, { data: "https://example.com/x.jpg", thumb: PHOTO.thumb })).rejects.toThrow("Not a photo the app took");
    await expect(setPhoto("packages", box, { data: PHOTO.data, thumb: "data:image/svg+xml;base64,PHN2Zz4=" })).rejects.toThrow();
    await expect(setPhoto("packages", box, { data: `x${PHOTO.data}`, thumb: PHOTO.thumb }), "nothing before it").rejects.toThrow();
    await expect(setPhoto("packages", box, { data: `${PHOTO.data}"onerror="x`, thumb: PHOTO.thumb }), "nothing after it").rejects.toThrow();
    expect(all("SELECT id FROM photos")).toEqual([]);
    await setPhoto("packages", box, PHOTO);
    await deleteRows("packages", [box]);
    harness.db!.exec("DELETE FROM outbox");
    await setPhoto("packages", box, null);
    await setPhoto("people", "none", null);
    expect(outbox()).toEqual([]);
  });
});

describe("reading the cabinet", () => {
  it("lists each product with a box, by name, its boxes soonest to expire first, an uncounted box apart from an empty one, and when each last moved", async () => {
    const late = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2028-01-31" }, 10_000);
    const undated = await addPackage("me", PAROL, { unit: "tablet" }, 0);
    const soon = await addPackage("me", PAROL, { unit: "tablet", expiresOn: "2027-01-31" }, 5000);
    await takeFrom(soon, 5000);
    await addPackage("me", { name: "Aspirin" }, { unit: "tablet" }, 20_000);
    const cabinet = await readCabinet();
    expect(cabinet.map((product) => product.name)).toEqual(["Aspirin", "Parol"]);
    expect(cabinet[1]!.boxes.map(({ id, remainingMilli, counted }) => ({ id, remainingMilli, counted }))).toEqual([
      { id: soon, remainingMilli: 0, counted: true },
      { id: late, remainingMilli: 10_000, counted: true },
      { id: undated, remainingMilli: 0, counted: false },
    ]);
    // Its last move, the one that emptied it: a reminder says so the morning after.
    expect(cabinet[1]!.boxes.map((box) => box.movedAt)).toEqual([(await readMoves(soon))[0]!.createdAt, (await readMoves(late))[0]!.createdAt, null]);
    expect(cabinet[1]).toMatchObject({ strength: "500 mg", gtin: PAROL.gtin });
  });

  it("leaves out a deleted box, and a product with no box left unless it is still to be bought", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const id = (await readCabinet())[0]!.id;
    await deleteRows("packages", [box]);
    expect(await readCabinet()).toEqual([]);
    await editProduct(id, { wanted: true });
    expect(await readCabinet()).toMatchObject([{ id, wanted: true, boxes: [] }]);
  });
});

describe("what a scan finds", () => {
  it("is the cabinet's own product of the GTIN, and nothing once it is deleted or in another cabinet", async () => {
    await addPackage("me", { ...PAROL, form: "tablet", note: "aç karnına" } as typeof PAROL, { unit: "tablet" }, 1000);
    expect(await findProduct("me", PAROL.gtin)).toEqual({
      name: "Parol", brand: null, activeSubstance: null, strength: "500 mg", form: "tablet", pack: null, manufacturer: null, gtin: PAROL.gtin,
    });
    expect(await findProduct("home", PAROL.gtin)).toBeNull();
    const [{ id }] = all("SELECT id FROM products") as [{ id: string }];
    await deleteRows("products", [id]);
    expect(await findProduct("me", PAROL.gtin)).toBeNull();
  });

  it("knows a box by its GTIN and serial, until it is deleted", async () => {
    const box = await addPackage("me", PAROL, { unit: "tablet", serial: "S1" }, 1000);
    expect([await hasBox(PAROL.gtin, "S1"), await hasBox(PAROL.gtin, "S2"), await hasBox("08699695610100", "S1")]).toEqual([true, false, false]);
    await deleteRows("packages", [box]);
    expect(await hasBox(PAROL.gtin, "S1")).toBe(false);
  });
});

describe("people and places", () => {
  it("are added to the cabinet and read by name, the deleted left out", async () => {
    const zeynep = await addNamed("people", "me", "Zeynep");
    await addNamed("people", "me", "Ali");
    await addNamed("locations", "me", "Mutfak");
    expect((await readNamed("people")).map((person) => person.name)).toEqual(["Ali", "Zeynep"]);
    expect(all("SELECT cabinet_id, kind FROM people WHERE id = '" + zeynep + "'")).toEqual([{ cabinet_id: "me", kind: "person" }]);
    await deleteRows("people", [zeynep]);
    expect(await readNamed("people")).toEqual([{ id: expect.any(String), name: "Ali", cabinetId: "me" }]);
    expect(await readNamed("locations")).toEqual([{ id: expect.any(String), name: "Mutfak", cabinetId: "me" }]);
  });

  it("are told apart by a colour, and give their boxes their own notice ahead of an expiry", async () => {
    const zeynep = await addNamed("people", "me", "Zeynep");
    await addNamed("people", "me", "Ali");
    expect(await readPeople()).toEqual([
      { id: expect.any(String), name: "Ali", cabinetId: "me", color: null, warnDays: null, photoId: null, thumb: null },
      { id: zeynep, name: "Zeynep", cabinetId: "me", color: null, warnDays: null, photoId: null, thumb: null },
    ]);
    await editPerson(zeynep, { color: "teal", warnDays: 90 });
    await setPhoto("people", zeynep, PHOTO);
    expect((await readPeople())[1]).toEqual({ id: zeynep, name: "Zeynep", cabinetId: "me", color: "teal", warnDays: 90, photoId: expect.any(String), thumb: PHOTO.thumb });
    const hers = await addPackage("me", PAROL, { unit: "tablet", personId: zeynep }, 1000);
    const own = await addPackage("me", PAROL, { unit: "tablet", personId: zeynep, warnDays: 7 }, 1000);
    const nobody = await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const soonDays = async () => Object.fromEntries((await readCabinet())[0]!.boxes.map((box) => [box.id, box.soonDays]));
    expect(await soonDays()).toEqual({ [hers]: 90, [own]: 7, [nobody]: null });
    await deleteRows("people", [zeynep]);
    expect(await soonDays(), "a deleted person's notice goes with them").toEqual({ [hers]: null, [own]: 7, [nobody]: null });
    harness.db!.exec("DELETE FROM outbox");
    await editPerson(zeynep, { color: "red" });
    expect(outbox()).toEqual([]);
  });

  it("are renamed in place and queued, a deleted one left as it is", async () => {
    const kitchen = await addNamed("locations", "me", "Mutfak");
    harness.db!.exec("DELETE FROM outbox");
    await renameNamed("locations", kitchen, "Banyo dolabı");
    expect(await readNamed("locations")).toEqual([{ id: kitchen, name: "Banyo dolabı", cabinetId: "me" }]);
    expect(outbox()).toEqual(["locations"]);
    await deleteRows("locations", [kitchen]);
    harness.db!.exec("DELETE FROM outbox");
    await renameNamed("locations", kitchen, "x");
    await renameNamed("people", "none", "x");
    expect(outbox()).toEqual([]);
  });
});

describe("stars and tags", () => {
  it("star a product, and say so as a boolean", async () => {
    await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const [product] = await readCabinet();
    expect(product!.starred).toBe(false);
    await editProduct(product!.id, { starred: true });
    expect((await readCabinet())[0]!.starred).toBe(true);
    expect(all("SELECT starred FROM products")).toEqual([{ starred: 1 }]);
  });

  it("put a tag on a product as one row, however often, and take it off as a tombstone", async () => {
    await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const productId = (await readCabinet())[0]!.id;
    const pain = await addNamed("tags", "me", "Ağrı kesici");
    const fever = await addNamed("tags", "me", "Ateş düşürücü");
    await tagProduct(productId, pain, true);
    await tagProduct(productId, pain, true);
    await tagProduct(productId, fever, true);
    expect((await readCabinet())[0]!.tagIds.sort()).toEqual([pain, fever].sort());
    expect(all("SELECT COUNT(*) AS n FROM product_tags")).toEqual([{ n: 2 }]);
    await tagProduct(productId, pain, false);
    expect((await readCabinet())[0]!.tagIds).toEqual([fever]);
    expect(all(`SELECT tombstone_version FROM product_tags WHERE tag_id = '${pain}'`)).toEqual([{ tombstone_version: 1 }]);
    await tagProduct(productId, pain, true);
    expect((await readCabinet())[0]!.tagIds.sort(), "put back, the same row lives again").toEqual([pain, fever].sort());
    expect(all("SELECT COUNT(*) AS n FROM product_tags")).toEqual([{ n: 2 }]);
  });

  it("leave a product untagged when its tag is deleted, and write nothing to take off a tag never on", async () => {
    await addPackage("me", PAROL, { unit: "tablet" }, 1000);
    const productId = (await readCabinet())[0]!.id;
    const pain = await addNamed("tags", "me", "Ağrı kesici");
    await tagProduct(productId, pain, true);
    await deleteRows("tags", [pain]);
    expect((await readCabinet())[0]!.tagIds).toEqual([]);
    expect(await readNamed("tags")).toEqual([]);
    harness.db!.exec("DELETE FROM outbox");
    await tagProduct(productId, "other", false);
    expect(outbox()).toEqual([]);
  });
});

describe("a file's boxes", () => {
  const imported = (name: string, gtin: string | null, amountMilli: number, person: string | null, place: string | null) => ({
    product: { name, brand: null, activeSubstance: null, strength: null, form: null, pack: null, manufacturer: null, gtin },
    box: { unit: "tablet" as const, expiresOn: "2027-03-31", openedOn: null, serial: null, lot: null, nickname: null, note: null },
    amountMilli,
    person,
    place,
  });

  it("are added in one write, a name met again found, not made twice, and taken back whole", async () => {
    const zeynep = await addNamed("people", "me", "Zeynep");
    const houseKitchen = await addNamed("locations", "house", "Mutfak");
    const written = await importBoxes("me", [
      imported("Parol", "08699546090112", 20_000, "ZEYNEP", "Mutfak"),
      imported("Parol", "08699546090112", 10_000, "Ali", " mutfak "),
      imported("Majezik", null, 0, null, null),
      imported("majezik", null, 5_000, "Ali", null),
      imported("Arveles", null, 1_000, null, null),
      imported("Parol", "08699546090129", 1_000, null, null),
    ]);
    const cabinet = await readCabinet();
    expect(cabinet.map((product) => [product.name, product.boxes.length]).sort(), "one name, two GTINs: two products").toEqual([["Arveles", 1], ["Majezik", 2], ["Parol", 1], ["Parol", 2]]);
    const parol = cabinet.find((product) => product.gtin === "08699546090112")!;
    const ali = (await readNamed("people")).find((person) => person.name === "Ali")!.id;
    expect(parol.boxes.map((box) => box.personId).sort()).toEqual([ali, zeynep].sort());
    expect(new Set(parol.boxes.map((box) => box.locationId)).size, "the place is made once").toBe(1);
    expect(parol.boxes[0]!.locationId, "a place of another cabinet is not this one's").not.toBe(houseKitchen);
    expect((await readNamed("locations")).filter((place) => place.cabinetId === "me")).toEqual([{ id: parol.boxes[0]!.locationId, name: "Mutfak", cabinetId: "me" }]);
    expect(parol.boxes.map((box) => [box.remainingMilli, box.counted]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[10_000, true], [20_000, true]]);
    expect(cabinet.find((product) => product.name === "Majezik")!.boxes.map((box) => [box.remainingMilli, box.counted]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[0, false], [5000, true]]);
    expect(all("SELECT reason, COUNT(*) AS n FROM package_moves GROUP BY reason")).toEqual([{ reason: "initial", n: 5 }]);

    await undoRows(written!);
    expect(await readCabinet()).toEqual([]);
    expect(await readNamed("people"), "a name the cabinet held before stays").toEqual([{ id: zeynep, name: "Zeynep", cabinetId: "me" }]);
    expect(await readNamed("locations")).toEqual([{ id: houseKitchen, name: "Mutfak", cabinetId: "house" }]);
  });

  it("join a product the cabinet holds by its GTIN, and bring back one deleted", async () => {
    const box = await addPackage("me", { name: "Parol", gtin: "08699546090112" }, { unit: "tablet" }, 1000);
    await importBoxes("me", [imported("Parol 500", "08699546090112", 1000, null, null)]);
    expect((await readCabinet()).map((product) => [product.name, product.boxes.length])).toEqual([["Parol", 2]]);
    const productId = (await readCabinet())[0]!.id;
    await deleteRows("packages", (await readCabinet())[0]!.boxes.map((each) => each.id));
    await deleteRows("products", [productId]);
    await importBoxes("me", [imported("Parol 500", "08699546090112", 1000, null, null)]);
    expect((await readCabinet()).map((product) => [product.id, product.name, product.boxes.length])).toEqual([[productId, "Parol 500", 1]]);
    expect(box).toEqual(expect.any(String));
  });

  it("write nothing for no boxes, or for a file with an amount no box holds", async () => {
    expect(await importBoxes("me", [])).toBeNull();
    await expect(importBoxes("me", [imported("Parol", null, 1000, "Ali", null), imported("Arveles", null, -1, null, null)])).rejects.toThrow("invalid amount");
    expect(await readCabinet()).toEqual([]);
    expect(await readNamed("people")).toEqual([]);
  });
});
