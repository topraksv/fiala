/**
 * The backup and the inventory over the real write layer: a backup holds the
 * cabinets the person owns, a restore writes only what is newer into a
 * cabinet they may write, and a refused file says where and why.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  /** Storage's files, by path (`exists` also by bucket and path); `download` answers 404 for any other. */
  stored: new Map<string, Uint8Array>(),
  /** Storage failing the question, as a network does. */
  unreachable: false,
  /** A build with no server configured. */
  noServer: false,
}));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);
vi.mock("../../src/sync/supabase", () => ({
  getSupabase: () => (harness.noServer ? null : {
    storage: {
      from: (bucket: string) => ({
        exists: async (path: string) => {
          if (harness.unreachable) throw new Error("offline");
          return { data: harness.stored.has(`${bucket}/${path}`) || harness.stored.has(path), error: null };
        },
        download: async (path: string) => {
          const bytes = harness.stored.get(path);
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { status: 404, message: "Object not found" } };
        },
      }),
    },
  }),
}));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

const { buildBackupText, inventoryGrid, movedTo, readBackup, restoreArchive, restoreBackup, workbookBytes, writeBackupArchive } = await import("../../src/services/export-import");
const { setPhoto } = await import("../../src/data/cabinet");
const { zipSync, strToU8 } = await import("fflate");
const { addPackage, readCabinet, tagProduct } = await import("../../src/data/cabinet");
const { addDocument } = await import("../../src/data/documents");
const { addDosePlan, answerDose } = await import("../../src/data/doses");
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
  harness.stored.clear();
  harness.noServer = false;
  harness.unreachable = false;
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
    expect((await movedTo({ ...backup, account: OTHER, tables: { products: [moved] } }, ME)).products?.[0], "a household's product keeps its id, whatever it was made of, and gains no column").toStrictEqual(moved);
    const unproven = { ...product, id: await deterministicId(naturalKeys.product(OTHER, null as never)), gtin: null };
    expect((await movedTo({ ...backup, account: OTHER, tables: { products: [unproven] } }, ME)).products?.[0], "no GTIN, nothing its id could be made of").toMatchObject({ id: unproven.id, cabinet_id: ME });
  });
});

describe("a backup with its files", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]).toString("base64");
  const PHOTO = { data: `data:image/jpeg;base64,${JPEG}`, thumb: `data:image/jpeg;base64,${JPEG}AA==` };
  const FIELDS = { kind: "prescription", title: "Reçete", personId: null, issuedOn: null, note: null, reference: null } as const;
  const yes = async () => true;

  async function archive(me: string) {
    const parts: Uint8Array[] = [];
    const { missing } = await writeBackupArchive(me, async (chunk) => void parts.push(chunk));
    return { bytes: new Uint8Array(Buffer.concat(parts)), missing, chunks: parts.length };
  }
  /** Read back in small pieces, as a phone reads a large file. */
  const reader = (bytes: Uint8Array, size = 7) => {
    let at = 0;
    return async () => (at >= bytes.length ? null : bytes.subarray(at, (at += size)));
  };
  const files = () => [
    ...harness.db!.prepare("SELECT 'photo' AS kind, id, uploaded_at FROM photos").all(),
    ...harness.db!.prepare("SELECT 'document' AS kind, id, uploaded_at FROM document_files").all(),
  ];

  async function withFiles(cabinet: string) {
    const box = await addPackage(cabinet, { name: "Parol" }, { unit: "tablet" }, 20_000);
    await setPhoto("packages", box, PHOTO);
    const document = await addDocument(cabinet, FIELDS, { base64: PDF, type: "pdf" });
    const photoId = (harness.db!.prepare("SELECT photo_id FROM packages").get() as { photo_id: string }).photo_id;
    const fileId = (harness.db!.prepare("SELECT file_id FROM documents").get() as { file_id: string }).file_id;
    return { document, photoId, fileId };
  }

  it("carries each photo and document file, an entry at a time, and a fresh device takes them back to send", async () => {
    const { photoId, fileId } = await withFiles(ME);
    const { bytes, missing, chunks } = await archive(ME);
    expect(missing).toBe(0);
    expect(chunks, "handed on as each entry is added, not held whole").toBeGreaterThan(3);
    harness.db = migratedDatabase();
    households(harness.db);

    const done = await restoreArchive(ME, reader(bytes), yes, online);

    expect(done, "the household's own row is as new here").toEqual({ restored: 5, kept: 1, closed: 0, files: 2, skipped: 0, damaged: false });
    expect(files()).toEqual([{ kind: "photo", id: photoId, uploaded_at: null }, { kind: "document", id: fileId, uploaded_at: null }]);
    expect(harness.db.prepare("SELECT data, thumb FROM photos").get(), "as the device keeps a photo").toEqual({ data: PHOTO.data, thumb: PHOTO.thumb });
    expect(harness.db.prepare("SELECT data FROM document_files").get()).toEqual({ data: PDF });
    expect(await restoreArchive(ME, reader(bytes), yes, online), "a file the device holds is not written twice").toMatchObject({ files: 0, skipped: 2 });
  });

  it("fetches a document's file the device does not hold, keeps none of it, and counts one it cannot get", async () => {
    const { fileId } = await withFiles(ME);
    harness.db!.exec("DELETE FROM document_files");
    harness.stored.set(`${fileId}/file.pdf`, Buffer.from(PDF, "base64"));
    expect((await archive(ME)).missing).toBe(0);
    expect(count("document_files"), "a backup leaves the device as it found it").toBe(0);
    harness.stored.clear();
    harness.db!.exec("DELETE FROM photos");
    expect((await archive(ME)).missing, "neither here nor in Storage: said, never left out unsaid").toBe(2);
  });

  it("gives another account's files ids of this one's, the same for each row and its entry", async () => {
    harness.db = migratedDatabase();
    harness.db.exec(`INSERT INTO cabinets (id, created_at, updated_at, owner_id, name) VALUES ('${OTHER}', 'x', 'x', '${OTHER}', '')`);
    const { photoId, fileId } = await withFiles(OTHER);
    const { bytes } = await archive(OTHER);
    harness.db = migratedDatabase();

    expect(await restoreArchive(ME, reader(bytes), yes, online)).toMatchObject({ files: 2, skipped: 0 });

    const photo = await deterministicId(`backup-file:${ME}:${photoId}`);
    const file = await deterministicId(`backup-file:${ME}:${fileId}`);
    expect(harness.db.prepare("SELECT photo_id FROM packages").get()).toEqual({ photo_id: photo });
    expect(harness.db.prepare("SELECT file_id FROM documents").get()).toEqual({ file_id: file });
    expect(files().map((each) => each.id)).toEqual([photo, file]);
  });

  it("writes no file a restored row does not name, nor one whose bytes are not what its name says", async () => {
    const { fileId } = await withFiles(ME);
    const text = await buildBackupText(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    const jpeg = Buffer.from(JPEG, "base64");
    const forged = zipSync({
      "backup.json": strToU8(text),
      "photos/01900000-0000-7000-8000-0000000000f9/full.jpg": jpeg,
      "photos/01900000-0000-7000-8000-0000000000f9/thumb.jpg": jpeg,
      [`documents/${fileId}.pdf`]: jpeg,
      "notes.txt": strToU8("?"),
      "photos/01900000-0000-7000-8000-0000000000f8/full.jpg": jpeg,
    }, { level: 0 });

    expect(await restoreArchive(ME, reader(forged, 64), yes, online), "a full size no thumbnail followed counts too").toMatchObject({ files: 0, skipped: 4 });
    expect(files()).toEqual([]);
  });

  it("writes nothing when the person declines", async () => {
    await withFiles(ME);
    const { bytes } = await archive(ME);
    harness.db = migratedDatabase();
    expect(await restoreArchive(ME, reader(bytes), async () => false, online)).toBeNull();
    expect(count("packages") + count("photos") + count("outbox")).toBe(0);
  });

  it("refuses an archive that does not start with its backup, a file that is no zip, and an entry past its bound", async () => {
    await expect(restoreArchive(ME, reader(zipSync({ "notes.txt": strToU8("?") }, { level: 0 })), yes, online)).rejects.toThrow("yedek arşivi değil");
    await expect(restoreArchive(ME, reader(strToU8("PK not a zip at all, only its first letters")), yes, online)).rejects.toThrow("yedek arşivi değil");
    await expect(restoreArchive(ME, reader(new Uint8Array()), yes, online)).rejects.toThrow("yedek arşivi değil");
    const deflated = zipSync({ "backup.json": strToU8(await buildBackupText(ME)) }, { level: 6 });
    await expect(restoreArchive(ME, reader(deflated), yes, online), "squeezed by another tool").rejects.toThrow("yedek arşivi değil");
    const oversized = zipSync({ "backup.json": new Uint8Array(15 * 1024 * 1024 + 1) }, { level: 0 });
    await expect(restoreArchive(ME, reader(oversized, 1024 * 1024), yes, online)).rejects.toThrow("15 MB");
  });

  it("passes over an entry past its bound unheld, and keeps reading", async () => {
    const { photoId } = await withFiles(ME);
    const text = await buildBackupText(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    const jpeg = Buffer.from(JPEG, "base64");
    const huge = zipSync({
      "backup.json": strToU8(text),
      "photos/01900000-0000-7000-8000-0000000000f9/full.jpg": new Uint8Array(4 * 1024 * 1024 + 1),
      [`photos/${photoId}/full.jpg`]: jpeg,
      [`photos/${photoId}/thumb.jpg`]: jpeg,
    }, { level: 0 });

    expect(await restoreArchive(ME, reader(huge, 1024 * 1024), yes, online)).toMatchObject({ files: 1, skipped: 1, damaged: false });
  });

  /** A JPEG or a PDF may hold a zip signature anywhere; a reader that searched for its end cut the file there. */
  it("brings back a file holding zip signatures byte for byte, its CRC as zip tools check it", async () => {
    const { photoId } = await withFiles(ME);
    const full = new Uint8Array(70_000).map((_, at) => (at * 31) & 0xff);
    full.set([0xff, 0xd8, 0xff], 0);
    full.set([0x50, 0x4b, 0x03, 0x04], 500);
    full.set([0x50, 0x4b, 0x07, 0x08], 20_000);
    full.set([0x50, 0x4b, 0x01, 0x02], 65_000);
    harness.db!.prepare("UPDATE photos SET data = ? WHERE id = ?").run(`data:image/jpeg;base64,${Buffer.from(full).toString("base64")}`, photoId);
    const { bytes } = await archive(ME);
    const { unzipSync } = await import("fflate");
    const { crc32: zlibCrc } = await import("node:zlib");
    const listed = unzipSync(bytes);
    expect(Object.keys(listed), "the central directory names each entry").toHaveLength(4);
    expect(Buffer.from(listed[`photos/${photoId}/full.jpg`]!).equals(Buffer.from(full))).toBe(true);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(14, true), "backup.json's CRC").toBe(zlibCrc(listed["backup.json"]!));
    const end = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22);
    expect([end.getUint16(10, true), end.getUint32(12, true)], "the directory says how many entries it holds and how long it is").toEqual([4, bytes.length - 22 - end.getUint32(16, true)]);
    harness.db = migratedDatabase();
    households(harness.db);

    expect(await restoreArchive(ME, reader(bytes, 4096), yes, online)).toMatchObject({ files: 2, skipped: 0, damaged: false });
    const kept = harness.db.prepare("SELECT data FROM photos").get() as { data: string };
    expect(kept.data).toBe(`data:image/jpeg;base64,${Buffer.from(full).toString("base64")}`);
  });

  it("keeps a file at its bound exactly, and passes over a document past its own", async () => {
    const { photoId, fileId } = await withFiles(ME);
    const text = await buildBackupText(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    const full = new Uint8Array(4 * 1024 * 1024);
    full.set([0xff, 0xd8, 0xff]);
    const document = new Uint8Array(10 * 1024 * 1024 + 1);
    document.set(Buffer.from(PDF, "base64"));
    const atBounds = zipSync({
      "backup.json": strToU8(text),
      [`photos/${photoId}/full.jpg`]: full,
      [`photos/${photoId}/thumb.jpg`]: full,
      [`documents/${fileId}.pdf`]: document,
    }, { level: 0 });

    expect(await restoreArchive(ME, reader(atBounds, 1024 * 1024), yes, online)).toMatchObject({ files: 1, skipped: 1 });
  });

  it("says an archive missed an entry when one header is broken", async () => {
    await withFiles(ME);
    const { bytes } = await archive(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    const broken = bytes.slice();
    const second = 30 + "backup.json".length + new DataView(bytes.buffer, bytes.byteOffset).getUint32(18, true);
    broken.set([0x50, 0x4b, 0x09, 0x09], second);

    expect(await restoreArchive(ME, reader(broken), yes, online)).toMatchObject({ restored: 5, damaged: true });
  });

  it("refuses an archive whose entries leave their size to a trailer", async () => {
    const { Zip, ZipPassThrough } = await import("fflate");
    const parts: Uint8Array[] = [];
    const zip = new Zip((_, chunk) => void parts.push(chunk));
    const entry = new ZipPassThrough("backup.json");
    zip.add(entry);
    entry.push(strToU8(await buildBackupText(ME)), true);
    zip.end();
    await expect(restoreArchive(ME, reader(new Uint8Array(Buffer.concat(parts))), yes, online)).rejects.toThrow("yedek arşivi değil");
  });

  it("reports the rows it restored when the archive breaks off after them", async () => {
    await withFiles(ME);
    const { bytes } = await archive(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    const end = 30 + "backup.json".length + new DataView(bytes.buffer, bytes.byteOffset).getUint32(18, true);
    const junk = bytes.slice(0, end + 10);
    junk.set([0x50, 0x4b, 0x09, 0x09], end);

    expect(await restoreArchive(ME, reader(bytes.slice(0, end + 40)), yes, online), "cut inside a photo").toMatchObject({ restored: 5, files: 0, damaged: true });
    harness.db = migratedDatabase();
    households(harness.db);
    expect(await restoreArchive(ME, reader(bytes.slice(0, end)), yes, online), "cut where an entry ended").toMatchObject({ restored: 5, damaged: true });
    harness.db = migratedDatabase();
    households(harness.db);
    expect(await restoreArchive(ME, reader(junk), yes, online), "followed by what no zip holds").toMatchObject({ restored: 5, damaged: true });
  });

  it("writes a file Storage already holds for this account as sent, and one it lacks as unsent", async () => {
    const { photoId, fileId } = await withFiles(ME);
    const { bytes } = await archive(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    harness.stored.set(`photos/${photoId}/thumb.jpg`, new Uint8Array([1]));

    expect(await restoreArchive(ME, reader(bytes), yes, online)).toMatchObject({ files: 2 });
    const sent = (table: string) => (harness.db!.prepare(`SELECT uploaded_at FROM ${table}`).get() as { uploaded_at: string | null }).uploaded_at;
    expect(sent("photos"), "a household member's photo is not this device's to place again").not.toBeNull();
    expect(sent("document_files"), `documents/${fileId}: not in Storage, so sent from here`).toBeNull();
  });

  it("sends from here a file Storage could not be asked about, and asks nothing for another account's", async () => {
    const { photoId } = await withFiles(ME);
    const { bytes } = await archive(ME);
    harness.db = migratedDatabase();
    households(harness.db);
    harness.stored.set(`photos/${photoId}/thumb.jpg`, new Uint8Array([1]));
    harness.unreachable = true;
    await restoreArchive(ME, reader(bytes), yes, online);
    harness.unreachable = false;
    expect(count("photos", "uploaded_at IS NULL")).toBe(1);

    harness.db = migratedDatabase();
    const moved = await deterministicId(`backup-file:${OTHER}:${photoId}`);
    harness.stored.set(`photos/${moved}/thumb.jpg`, new Uint8Array([1]));
    await restoreArchive(OTHER, reader(bytes), yes, online);
    expect(count("photos", "uploaded_at IS NULL"), "a new id is this account's to send, whatever Storage says").toBe(1);
  });

  /** An archive of `backup.json` as the person's own device wrote it, then the entries given, stored as they are. */
  const forge = (text: string, entries: Record<string, Uint8Array>) => zipSync({ "backup.json": strToU8(text), ...entries }, { level: 0 });
  const fresh = () => {
    harness.db = migratedDatabase();
    households(harness.db);
  };
  const jpegBytes = (head: number[], length = head.length) => Uint8Array.from({ length }, (_, at) => head[at] ?? 0);
  const GOOD = [0xff, 0xd8, 0xff, 0xe0];

  it("keeps a photo only when both its sizes are JPEGs, each full size with its own thumbnail", async () => {
    const ids: string[] = [];
    for (let at = 0; at < 11; at += 1) {
      const box = await addPackage(ME, { name: `Parol ${at}` }, { unit: "tablet" }, 1000);
      await setPhoto("packages", box, PHOTO);
      ids.push((harness.db!.prepare("SELECT photo_id FROM packages WHERE id = ?").get(box) as { photo_id: string }).photo_id);
    }
    const text = await buildBackupText(ME);
    fresh();
    const photo = (id: string, full: Uint8Array | null, thumb: Uint8Array | null) => ({
      ...(full && { [`photos/${id}/full.jpg`]: full }),
      ...(thumb && { [`photos/${id}/thumb.jpg`]: thumb }),
    });
    const good = jpegBytes(GOOD);
    const huge = jpegBytes(GOOD, 4 * 1024 * 1024 + 1);
    const forged = forge(text, {
      ...photo(ids[0]!, good, good),
      ...photo(ids[1]!, jpegBytes([0x00, 0xd8, 0xff, 0xe0]), good),
      ...photo(ids[2]!, jpegBytes([0xff, 0x00, 0xff, 0xe0]), good),
      ...photo(ids[3]!, jpegBytes([0xff, 0xd8, 0x00, 0xe0]), good),
      ...photo(ids[4]!, jpegBytes([0x00, 0x00, 0xff, 0xe0]), good),
      ...photo(ids[5]!, good, jpegBytes([0xff, 0xd8, 0x00, 0xe0])),
      ...photo(ids[6]!, good, huge),
      ...photo(ids[7]!, null, good),
      ...photo(ids[8]!, huge, good),
      ...photo(ids[9]!, good, null),
      ...photo(ids[10]!, null, good),
    });

    // The last two are a full size of one photo followed by the thumbnail of another.
    expect(await restoreArchive(ME, reader(forged, 1024 * 1024), yes, online)).toMatchObject({ files: 1, skipped: 10, damaged: false });
    expect(files()).toEqual([{ kind: "photo", id: ids[0], uploaded_at: null }]);
  });

  it("takes a thumbnail that is not the one after its own full size for no photo, and counts both", async () => {
    const { photoId } = await withFiles(ME);
    const other = "01900000-0000-7000-8000-0000000000f7";
    const text = await buildBackupText(ME);
    fresh();
    const jpeg = jpegBytes(GOOD);
    const forged = forge(text, { [`photos/${other}/full.jpg`]: jpeg, [`photos/${photoId}/thumb.jpg`]: jpeg });

    expect(await restoreArchive(ME, reader(forged), yes, online)).toMatchObject({ files: 0, skipped: 2, damaged: false });
    expect(files()).toEqual([]);
  });

  it("reads an entry only by its whole name", async () => {
    const { photoId, fileId } = await withFiles(ME);
    const text = await buildBackupText(ME);
    fresh();
    const jpeg = jpegBytes(GOOD);
    const pdf = Buffer.from(PDF, "base64");
    const forged = forge(text, {
      [`x/photos/${photoId}/full.jpg`]: jpeg,
      [`x/photos/${photoId}/thumb.jpg`]: jpeg,
      [`photos/${photoId}/full.jpg.bak`]: jpeg,
      [`photos/${photoId}/thumb.jpg.bak`]: jpeg,
      [`x/documents/${fileId}.pdf`]: pdf,
      [`documents/${fileId}.pdfx`]: pdf,
    });

    expect(await restoreArchive(ME, reader(forged, 4096), yes, online)).toMatchObject({ files: 0, skipped: 6, damaged: false });
    expect(files()).toEqual([]);
  });

  it("keeps a document up to its own bound, which is past a photo's", async () => {
    const { fileId } = await withFiles(ME);
    const text = await buildBackupText(ME);
    fresh();
    const document = new Uint8Array(5 * 1024 * 1024);
    document.set(Buffer.from(PDF, "base64"));

    expect(await restoreArchive(ME, reader(forge(text, { [`documents/${fileId}.pdf`]: document }), 1024 * 1024), yes, online)).toMatchObject({ files: 1, skipped: 0 });
  });

  it("keeps a photo to its own bound, which is below a document's", async () => {
    const { photoId } = await withFiles(ME);
    const text = await buildBackupText(ME);
    fresh();
    const big = jpegBytes(GOOD, 5 * 1024 * 1024);
    const forged = forge(text, { [`photos/${photoId}/full.jpg`]: big, [`photos/${photoId}/thumb.jpg`]: jpegBytes(GOOD) });

    expect(await restoreArchive(ME, reader(forged, 1024 * 1024), yes, online)).toMatchObject({ files: 0, skipped: 1 });
  });

  it("restores a backup.json larger than any file may be, up to its own bound", async () => {
    harness.db!.exec(`INSERT INTO locations (id, created_at, updated_at, cabinet_id, name) VALUES ('01900000-0000-7000-8000-0000000000f1', 'x', '2026-01-01T00:00:00.000Z', '${ME}', '${"a".repeat(11 * 1024 * 1024)}')`);
    const text = await buildBackupText(ME);
    harness.db = migratedDatabase();

    expect(await restoreArchive(ME, reader(forge(text, {}), 1024 * 1024), yes, online)).toMatchObject({ damaged: false });
    expect(count("locations")).toBe(1);
  });

  it("names no file a row that is deleted, or names none, would have asked for", async () => {
    await withFiles(ME);
    harness.db!.exec("UPDATE packages SET deleted_at = '2026-02-01T00:00:00.000Z'; UPDATE documents SET deleted_at = '2026-02-01T00:00:00.000Z'");
    await addDocument(ME, { ...FIELDS, title: "Boş" }, { base64: PDF, type: "pdf" });
    harness.db!.exec("UPDATE documents SET file_id = NULL WHERE deleted_at IS NULL");
    const { bytes, missing } = await archive(ME);
    const { unzipSync } = await import("fflate");
    expect(Object.keys(unzipSync(bytes)), "a tombstone's file is no one's to keep").toEqual(["backup.json"]);
    expect(missing).toBe(0);
  });

  // 65,535 rows through SQLite and a zip: 2.3 s alone here, past 5 s on a CI runner under coverage.
  it("writes an archive of 65,535 entries, the most a zip without Zip64 holds, and refuses one more", async () => {
    harness.db!.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 32767)
      INSERT INTO photos (id, data, thumb, created_at) SELECT printf('01900001-0000-7000-8000-%012x', i), 'data:image/jpeg;base64,/9j/', 'data:image/jpeg;base64,/9j/', 'x' FROM n`);
    harness.db!.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 32767)
      INSERT INTO people (id, created_at, updated_at, cabinet_id, name, photo_id) SELECT printf('01900002-0000-7000-8000-%012x', i), 'x', '2026-01-01T00:00:00.000Z', '${ME}', 'p', printf('01900001-0000-7000-8000-%012x', i) FROM n`);
    const { bytes, missing } = await archive(ME);
    expect(missing).toBe(0);
    expect(new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22).getUint16(10, true)).toBe(65_535);

    await addDocument(ME, FIELDS, { base64: PDF, type: "pdf" });
    await expect(archive(ME)).rejects.toThrow("15 MB");
  }, 30_000);

  it("says an archive is damaged when its last record is not the directory's end", async () => {
    await withFiles(ME);
    const { bytes } = await archive(ME);
    fresh();
    const broken = bytes.slice();
    broken.set([0x50, 0x4b, 0x09, 0x09], bytes.length - 22);

    expect(await restoreArchive(ME, reader(broken), yes, online)).toMatchObject({ restored: 5, files: 2, damaged: true });
  });

  it("reports the rows it restored when an entry after them is one it cannot read", async () => {
    await withFiles(ME);
    const text = await buildBackupText(ME);
    fresh();
    const body = strToU8(text);
    const squeezed = zipSync({ "backup.json": [body, { level: 0 }], "notes.txt": [strToU8("a note ".repeat(100)), { level: 6 }] });
    // Whole in the first piece, so the entry that cannot be read arrives after it was handed on.
    const pieces = [squeezed.subarray(0, 30 + "backup.json".length + body.length), squeezed.subarray(30 + "backup.json".length + body.length)];
    let at = 0;

    expect(await restoreArchive(ME, async () => pieces[at++] ?? null, yes, online)).toMatchObject({ restored: 5, files: 0, damaged: true });
  });

  it("writes every file as unsent where no server is configured", async () => {
    await withFiles(ME);
    const { bytes } = await archive(ME);
    fresh();
    harness.noServer = true;

    expect(await restoreArchive(ME, reader(bytes), yes, online)).toMatchObject({ files: 2, damaged: false });
    expect(count("photos", "uploaded_at IS NULL") + count("document_files", "uploaded_at IS NULL")).toBe(2);
  });

  it("writes a document Storage already holds as sent, and the photo it does not as unsent", async () => {
    const { fileId } = await withFiles(ME);
    const { bytes } = await archive(ME);
    fresh();
    harness.stored.set(`documents/${fileId}/file.pdf`, new Uint8Array([1]));

    expect(await restoreArchive(ME, reader(bytes), yes, online)).toMatchObject({ files: 2 });
    expect(count("document_files", "uploaded_at IS NOT NULL")).toBe(1);
    expect(count("photos", "uploaded_at IS NULL")).toBe(1);
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

  it("refuses a dose answer naming a plan or a move it does not hold", async () => {
    const box = await addPackage(ME, { name: "Parol", gtin: GTIN }, { unit: "tablet" }, 20_000);
    const plan = await addDosePlan({ productId: await deterministicId(naturalKeys.product(ME, GTIN)), packageId: box, personId: null, amountMilli: 1000, times: ["08:00"], weekdays: 127, startsOn: "2026-10-19", endsOn: null, instructions: null });
    await answerDose(plan, { dueOn: "2026-10-20", dueTime: "08:00" }, "taken");
    const backup = readBackup(await buildBackupText(ME));
    expect(backup.tables.dose_logs?.[0]).toMatchObject({ plan_id: plan, move_id: expect.any(String) });
    harness.db = migratedDatabase();
    households(harness.db);
    expect(await restoreBackup(ME, backup, online), "named by the file, held by the file").toMatchObject({ kept: 1, closed: 0 });
    for (const column of ["plan_id", "move_id"]) {
      harness.db = migratedDatabase();
      households(harness.db);
      const tables = { ...backup.tables, dose_logs: backup.tables.dose_logs!.map((log) => ({ ...log, [column]: "01900000-0000-7000-8000-0000000000e9" })) };
      await expect(restoreBackup(ME, { ...backup, tables }, online), column).rejects.toThrow("Doz kayıtları bölümündeki 1. kayıt alınamadı: bağlı olduğu kayıt");
    }
  });

  it("is refused past 100,000 rows in all, and read at exactly 100,000", () => {
    const rows = (from: number, length: number) =>
      Array.from({ length }, (_, at) => ({ id: `01900000-0000-7000-8000-${(from + at).toString(16).padStart(12, "0")}`, created_at: "", updated_at: "2026", cabinet_id: ME, name: "a" }));
    const text = (places: number, tags: number) => file({ locations: rows(0, places), tags: rows(places, tags) });
    expect(readBackup(text(60_000, 40_000)).tables.tags).toHaveLength(40_000);
    expect(() => readBackup(text(60_000, 40_001))).toThrow("15 MB");
    expect(() => readBackup(text(100_001, 0))).toThrow("15 MB");
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
