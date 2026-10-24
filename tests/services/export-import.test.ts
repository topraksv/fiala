/**
 * The backup and the inventory over the real write layer: a backup holds the
 * cabinets the person owns, a restore writes only what is newer into a
 * cabinet they may write, and a refused file says where and why.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

const { buildBackupText, inventoryGrid, movedTo, readBackup, restoreBackup, workbookBytes } = await import("../../src/services/export-import");
const { addPackage, readCabinet, tagProduct } = await import("../../src/data/cabinet");
const { addDocument } = await import("../../src/data/documents");
const { deterministicId, naturalKeys } = await import("../../src/db/ids");
const { migratedDatabase } = await import("../helpers");

const ME = "01900000-0000-7000-8000-000000000001";
const OTHER = "01900000-0000-7000-8000-000000000002";
const HOME = "01900000-0000-7000-8000-0000000000a1";
const THEIRS = "01900000-0000-7000-8000-0000000000a2";
const GONE = "01900000-0000-7000-8000-0000000000a3";
const GTIN = "8699546090112";
const PDF = Buffer.from("%PDF-1.7 reçete").toString("base64");
const online = async () => true;
const offline = async () => false;

function households(db: DatabaseSync) {
  db.exec(`INSERT INTO cabinets (id, created_at, updated_at, owner_id, name) VALUES
    ('${ME}', 'x', '2026-01-01T00:00:00.000Z', '${ME}', ''),
    ('${HOME}', 'x', '2026-01-01T00:00:00.000Z', '${ME}', 'Ev'),
    ('${THEIRS}', 'x', '2026-01-01T00:00:00.000Z', '${OTHER}', 'Komşu')`);
  db.exec(`INSERT INTO cabinets (id, created_at, updated_at, deleted_at, owner_id, name) VALUES ('${GONE}', 'x', '2026-01-01T00:00:00.000Z', 'x', '${ME}', 'Eski')`);
  db.exec(`INSERT INTO cabinet_members (id, created_at, updated_at, cabinet_id, user_id, role) VALUES
    ('01900000-0000-7000-8000-0000000000b1', 'x', 'x', '${HOME}', '${ME}', 'owner'),
    ('01900000-0000-7000-8000-0000000000b2', 'x', 'x', '${THEIRS}', '${ME}', 'editor')`);
}

const count = (table: string, where = "1") => (harness.db!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

beforeEach(() => {
  harness.db = migratedDatabase();
  households(harness.db);
});

describe("a backup", () => {
  it("holds the person's own cabinet and the live households they made, tombstones too, and nothing they only joined", async () => {
    const mine = await addPackage(ME, { name: "Parol", gtin: GTIN }, { unit: "tablet" }, 20_000);
    await addPackage(HOME, { name: "Majezik" }, { unit: "tablet" }, 10_000);
    await addPackage(THEIRS, { name: "Aferin" }, { unit: "tablet" }, 10_000);
    await addPackage(GONE, { name: "Arveles" }, { unit: "tablet" }, 10_000);
    harness.db!.exec(`UPDATE packages SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = '${mine}'`);
    const backup = readBackup(await buildBackupText(ME));
    expect(backup.account).toBe(ME);
    expect(backup.tables.cabinets?.map((row) => row.id), "the person's own cabinet is the server's").toEqual([HOME]);
    expect(backup.tables.products?.map((row) => row.name).sort()).toEqual(["Majezik", "Parol"]);
    expect(backup.tables.packages?.find((row) => row.id === mine)?.deleted_at).toBe("2026-02-01T00:00:00.000Z");
    expect(Object.keys(backup.tables)).not.toContain("settings");
    expect(Object.values(backup.tables).every((rows) => rows!.length > 0), "an empty table is left out").toBe(true);
  });

  it("is written and read at 15 MB exactly, and refused a byte past it", async () => {
    const limit = 15 * 1024 * 1024;
    harness.db!.exec(`INSERT INTO locations (id, created_at, updated_at, cabinet_id, name) VALUES ('01900000-0000-7000-8000-0000000000f1', 'x', '2026-01-01T00:00:00.000Z', '${ME}', 'a')`);
    const name = "a".repeat(1 + limit - (await buildBackupText(ME)).length);
    harness.db!.prepare("UPDATE locations SET name = ?").run(name);
    const exact = await buildBackupText(ME);
    expect(exact.length).toBe(limit);
    expect(readBackup(exact).tables.locations?.[0]?.name).toBe(name);
    harness.db!.prepare("UPDATE locations SET name = ?").run(`${name}a`);
    await expect(buildBackupText(ME)).rejects.toThrow("15 MB");
  });

  it("restores into a fresh device what is the person's own, and a household's once the device holds it", async () => {
    await addPackage(ME, { name: "Parol", gtin: GTIN }, { unit: "tablet" }, 20_000);
    await addPackage(HOME, { name: "Majezik" }, { unit: "tablet" }, 10_000);
    const backup = readBackup(await buildBackupText(ME));
    harness.db = migratedDatabase();
    expect(await restoreBackup(ME, backup, online)).toEqual({ restored: 3, kept: 0, closed: 4 });
    expect((await readCabinet()).map((product) => product.name)).toEqual(["Parol"]);
    harness.db = migratedDatabase();
    households(harness.db);
    expect(await restoreBackup(ME, backup, online), "the household's own row is as new here").toEqual({ restored: 6, kept: 1, closed: 0 });
    expect(count("outbox"), "each row goes to the account's other devices").toBe(6);
  });

  it("keeps the device's newer copy and one under another cabinet, and writes an older one over", async () => {
    const box = await addPackage(ME, { name: "Parol" }, { unit: "tablet" }, 20_000);
    const backup = readBackup(await buildBackupText(ME));
    const [product] = backup.tables.products!;
    harness.db!.exec(`UPDATE products SET name = 'Parol Forte', updated_at = '2999-01-01T00:00:00.000Z' WHERE id = '${String(product!.id)}'`);
    harness.db!.exec(`UPDATE packages SET nickname = 'eski', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = '${box}'`);
    harness.db!.exec(`UPDATE package_moves SET cabinet_id = '${HOME}', updated_at = '2000-01-01T00:00:00.000Z'`);
    expect(await restoreBackup(ME, backup, online)).toEqual({ restored: 1, kept: 3, closed: 0 });
    expect(harness.db!.prepare("SELECT name FROM products").get()).toEqual({ name: "Parol Forte" });
    expect(harness.db!.prepare("SELECT nickname, cabinet_id FROM packages").get()).toEqual({ nickname: null, cabinet_id: ME });
    expect(harness.db!.prepare("SELECT cabinet_id FROM package_moves").get(), "a restore never moves a row").toEqual({ cabinet_id: HOME });
  });

  it("offline, writes the person's own cabinet alone, and never a household's row the owner does not write", async () => {
    await addPackage(ME, { name: "Parol" }, { unit: "tablet" }, 20_000);
    await addPackage(HOME, { name: "Majezik" }, { unit: "tablet" }, 10_000);
    const backup = readBackup(await buildBackupText(ME));
    harness.db!.exec("DELETE FROM products; DELETE FROM packages; DELETE FROM package_moves");
    expect(await restoreBackup(ME, backup, offline)).toEqual({ restored: 3, kept: 0, closed: 4 });
    expect(await restoreBackup(ME, backup, () => Promise.reject(new Error("no network")))).toEqual({ restored: 0, kept: 3, closed: 4 });
    const theirs = { ...backup, tables: { cabinets: [{ ...backup.tables.cabinets![0]!, id: THEIRS, owner_id: OTHER, updated_at: "2999-01-01T00:00:00.000Z" }, { ...backup.tables.cabinets![0]!, id: ME, owner_id: ME, updated_at: "2999-01-01T00:00:00.000Z" }] } };
    expect(await restoreBackup(ME, theirs, online), "an editor renames no household, and the own cabinet is the server's").toEqual({ restored: 0, kept: 0, closed: 2 });
    const renamed = { ...backup, tables: { cabinets: [{ ...backup.tables.cabinets![0]!, name: "Yazlık", updated_at: "2999-01-01T00:00:00.000Z" }] } };
    expect(await restoreBackup(ME, renamed, online)).toEqual({ restored: 1, kept: 0, closed: 0 });
    expect(harness.db!.prepare(`SELECT name FROM cabinets WHERE id = '${HOME}'`).get()).toEqual({ name: "Yazlık" });
  });

  it("moves another account's own cabinet into this one's, minting again each id made of it", async () => {
    harness.db = migratedDatabase();
    harness.db.exec(`INSERT INTO cabinets (id, created_at, updated_at, owner_id, name) VALUES ('${OTHER}', 'x', 'x', '${OTHER}', '')`);
    const box = await addPackage(OTHER, { name: "Parol", gtin: GTIN }, { unit: "tablet" }, 20_000);
    const productId = await deterministicId(naturalKeys.product(OTHER, GTIN));
    const tagId = "01900000-0000-7000-8000-0000000000c1";
    harness.db.exec(`INSERT INTO tags (id, created_at, updated_at, cabinet_id, name) VALUES ('${tagId}', 'x', '2026-01-01T00:00:00.000Z', '${OTHER}', 'Ağrı')`);
    await tagProduct(productId, tagId, true);
    const document = await addDocument(OTHER, { kind: "prescription", title: "Reçete", personId: null, issuedOn: null, note: null, reference: null }, { base64: PDF, type: "pdf" }, { productId });
    const backup = readBackup(await buildBackupText(OTHER));
    harness.db = migratedDatabase();
    expect(await restoreBackup(ME, backup, online)).toEqual({ restored: 7, kept: 0, closed: 0 });
    const product = await deterministicId(naturalKeys.product(ME, GTIN));
    expect(harness.db.prepare("SELECT id, cabinet_id FROM products").all()).toEqual([{ id: product, cabinet_id: ME }]);
    expect(harness.db.prepare("SELECT id, product_id, cabinet_id FROM packages").get()).toEqual({ id: box, product_id: product, cabinet_id: ME });
    expect(harness.db.prepare("SELECT id, product_id FROM product_tags").get()).toEqual({ id: await deterministicId(naturalKeys.productTag(product, tagId)), product_id: product });
    expect(harness.db.prepare("SELECT id, product_id FROM document_links").get()).toEqual({ id: await deterministicId(naturalKeys.documentLink(document, product)), product_id: product });
    expect(await movedTo({ ...backup, account: ME }, ME), "the same account's backup is left as it is").toBe(backup.tables);
  });

  it("follows a moved product from a household's link to it, and lets a row it will not write name nothing", async () => {
    harness.db = migratedDatabase();
    harness.db.exec(`INSERT INTO cabinets (id, created_at, updated_at, owner_id, name) VALUES ('${OTHER}', 'x', 'x', '${OTHER}', ''), ('${HOME}', 'x', '2026-01-01T00:00:00.000Z', '${OTHER}', 'Ev')`);
    await addPackage(OTHER, { name: "Parol", gtin: GTIN }, { unit: "tablet" }, 20_000);
    const productId = await deterministicId(naturalKeys.product(OTHER, GTIN));
    const document = await addDocument(HOME, { kind: "prescription", title: "Reçete", personId: null, issuedOn: null, note: null, reference: null }, { base64: PDF, type: "pdf" }, { productId });
    const backup = readBackup(await buildBackupText(OTHER));
    const product = await deterministicId(naturalKeys.product(ME, GTIN));
    const tables = await movedTo(backup, ME);
    expect(tables.document_links?.[0]).toMatchObject({ id: await deterministicId(naturalKeys.documentLink(document, product)), product_id: product, cabinet_id: HOME });
    harness.db = migratedDatabase();
    const dangling = { ...backup, tables: { ...backup.tables, documents: [] } };
    expect(await restoreBackup(ME, dangling, offline), "the household's link is not written, so its document need not be here").toEqual({ restored: 3, kept: 0, closed: 2 });
  });

  it("leaves an id it cannot prove it made as it was", async () => {
    const backup = readBackup(await buildBackupText(ME));
    const product = { id: "01900000-0000-7000-8000-0000000000d1", created_at: "x", updated_at: "2026-01-01T00:00:00.000Z", tombstone_version: 0, cabinet_id: OTHER, name: "Parol", gtin: GTIN, starred: 0, wanted: 0 };
    const tables = await movedTo({ ...backup, account: OTHER, tables: { products: [product], product_tags: [{ id: "01900000-0000-7000-8000-0000000000d2", created_at: "x", updated_at: "x", tombstone_version: 0, cabinet_id: OTHER, product_id: product.id, tag_id: "t" }] } }, ME);
    expect(tables.products?.[0]).toMatchObject({ id: product.id, cabinet_id: ME });
    expect(tables.product_tags?.[0]).toMatchObject({ id: "01900000-0000-7000-8000-0000000000d2", product_id: product.id });
    const moved = { ...product, id: await deterministicId(naturalKeys.product(OTHER, GTIN)), cabinet_id: HOME };
    expect((await movedTo({ ...backup, account: OTHER, tables: { products: [moved] } }, ME)).products?.[0], "a household's product keeps its id, whatever it was made of").toEqual(moved);
  });
});

describe("a refused backup", () => {
  const file = (tables: object, envelope: object = {}) => JSON.stringify({ version: 1, exportedAt: "2026-10-24T10:00:00.000Z", account: ME, tables, ...envelope });
  const row = { id: "01900000-0000-7000-8000-0000000000e1", created_at: "x", updated_at: "2026-10-24T10:00:00.000Z", tombstone_version: 0, cabinet_id: ME, name: "Mutfak" };

  it("says which table, which row and which rule", () => {
    expect(() => readBackup("{")).toThrow(/^Geçersiz yedek dosyası: dosya JSON değil\.$/);
    expect(() => readBackup("x".repeat(15 * 1024 * 1024)), "15 MB is not past the limit").toThrow("dosya JSON değil");
    expect(() => readBackup(file({}, { exportedAt: 0 }))).toThrow("Fiala yedeği değil");
    expect(() => readBackup(JSON.stringify({ version: 1, exportedAt: "2026-10-24T10:00:00.000Z", account: ME }))).toThrow("Fiala yedeği değil");
    expect(() => readBackup(file(5 as never))).toThrow("Fiala yedeği değil");
    expect(() => readBackup(file({ locations: [], settings: [] }))).toThrow("tanımadığı bir bölüm");
    expect(() => readBackup(file({ locations: [7] }))).toThrow("Yerler bölümündeki 1. kayıt");
    expect(() => readBackup("null")).toThrow("Fiala yedeği değil");
    expect(() => readBackup(file({}, { version: 2 }))).toThrow("Fiala yedeği değil");
    expect(() => readBackup(file({}, { exportedAt: "dün" }))).toThrow("Fiala yedeği değil");
    expect(() => readBackup(file({}, { account: 7 }))).toThrow("Fiala yedeği değil");
    expect(() => readBackup(file({ settings: [] }))).toThrow("tanımadığı bir bölüm");
    expect(() => readBackup(file({ locations: {} }))).toThrow("Yerler bölümündeki 1. kayıt alınamadı: alanları");
    expect(() => readBackup(file({ locations: [row, { ...row, name: 7 }] }))).toThrow("Yerler bölümündeki 2. kayıt alınamadı: alanları");
    expect(() => readBackup(file({ locations: [{ ...row, updated_at: "dün" }] }))).toThrow("1. kayıt");
    expect(() => readBackup(file({ locations: [null] }))).toThrow("1. kayıt");
    expect(() => readBackup(file({ locations: [row, row] }))).toThrow("Yerler bölümündeki 2. kayıt alınamadı: aynı kimlik");
    expect(() => readBackup("x".repeat(15 * 1024 * 1024 + 1))).toThrow("15 MB");
    expect(readBackup(file({ locations: [row] })).tables.locations).toEqual([row]);
  });

  it("refuses a row naming one neither the file nor the device holds, before writing any", async () => {
    const box = { id: "01900000-0000-7000-8000-0000000000e2", created_at: "x", updated_at: "2026-10-24T10:00:00.000Z", tombstone_version: 0, cabinet_id: ME, product_id: "01900000-0000-7000-8000-0000000000e3", unit: "tablet" };
    await expect(restoreBackup(ME, readBackup(file({ locations: [row], packages: [box] })), online)).rejects.toThrow("Kutular bölümündeki 1. kayıt alınamadı: bağlı olduğu kayıt");
    expect(count("locations")).toBe(0);
  });

  it("refuses a box naming a person or a place, or a link naming a document, it does not hold", async () => {
    await addPackage(ME, { name: "Parol", gtin: GTIN }, { unit: "tablet" }, 20_000);
    await addDocument(ME, { kind: "prescription", title: "Reçete", personId: null, issuedOn: null, note: null, reference: null }, { base64: PDF, type: "pdf" }, { productId: await deterministicId(naturalKeys.product(ME, GTIN)) });
    const backup = readBackup(await buildBackupText(ME));
    for (const [table, column] of [["packages", "person_id"], ["packages", "location_id"], ["document_links", "document_id"]] as const) {
      harness.db = migratedDatabase();
      households(harness.db);
      const tables = { ...backup.tables, [table]: backup.tables[table]!.map((row) => ({ ...row, [column]: "01900000-0000-7000-8000-0000000000e9" })) };
      await expect(restoreBackup(ME, { ...backup, tables }, online), column).rejects.toThrow("bağlı olduğu kayıt");
    }
  });
});

describe("the inventory", () => {
  it("lists each box at home, and leaves out the personal columns asked to", async () => {
    harness.db!.exec(`INSERT INTO people (id, created_at, updated_at, cabinet_id, name) VALUES ('p', 'x', 'x', '${ME}', 'Ece')`);
    await addPackage(ME, { name: "Parol", activeSubstance: "parasetamol", strength: "500 mg", form: "tablet", gtin: GTIN }, { unit: "tablet", personId: "p", locationId: "l", nickname: "Mavi", expiresOn: "2027-03-01", openedOn: "2026-10-01", serial: "S1", lot: "L1", note: "kutu", acquiredFrom: "Eczane", acquiredOn: "2026-09-01" }, 20_000);
    harness.db!.exec("UPDATE products SET note = 'aç karnına' WHERE name = 'Parol'");
    await addPackage(HOME, { name: "Majezik" }, { unit: "ml", disposition: "lost" }, 0);
    await addPackage(HOME, { name: "Aferin" }, { unit: "ml" }, 0); // added with no amount: unknown, not empty
    const names = { households: new Map([[HOME, "Ev"]]), people: new Map([["p", "Ece"]]), locations: new Map([["l", "Mutfak"]]) };
    const all = inventoryGrid(await readCabinet(), names, new Set());
    expect(all[0]).toEqual(["Hane", "İlaç", "Etken madde", "Güç", "Form", "Barkod", "Takma ad", "Kalan", "Son kullanma", "Açılma", "Yer", "Kişi", "Not", "Seri · Parti", "Nereden · Ne zaman"]);
    expect(all.slice(1).sort()).toEqual([
      ["Ev", "Aferin", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["Kendi dolabım", "Parol", "parasetamol", "500 mg", "tablet", GTIN, "Mavi", "20 tablet", "01.03.2027", "01.10.2026", "Mutfak", "Ece", "aç karnına · kutu", "S1 · L1", "Eczane · 01.09.2026"],
    ]);
    const shared = inventoryGrid(await readCabinet(), names, new Set(["person", "note", "serial", "source"] as const));
    expect(shared[0]).toEqual(["Hane", "İlaç", "Etken madde", "Güç", "Form", "Barkod", "Takma ad", "Kalan", "Son kullanma", "Açılma", "Yer"]);
  });

  it("is written as a workbook its cells read back from", async () => {
    const XLSX = await import("xlsx");
    const grid = [["İlaç", "Son kullanma", "Not"], ["Parol", "01.03.2027", "x".repeat(60)]];
    const book = XLSX.read(await workbookBytes(grid), { type: "array", cellStyles: true });
    expect(book.SheetNames).toEqual(["Kutular"]);
    expect(book.Props?.Title).toBe("Fiala");
    expect(XLSX.utils.sheet_to_json(book.Sheets.Kutular!, { header: 1 })).toEqual(grid);
    expect(book.Sheets.Kutular!["!autofilter"]).toEqual({ ref: "A1:C2" });
    expect(book.Sheets.Kutular!["!cols"]?.map((column) => column.wch), "the longest cell and two, within 11 and 46").toEqual([11, 14, 46]);
  });
});
