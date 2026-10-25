/**
 * Documents over the real write layer (`src/data/documents.ts`): a file is
 * kept only as what its bytes say, a link is one row per pair, and a move
 * takes a document's links with it and leaves nothing to read behind, as a
 * moved box takes its prescription.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);

const { addDocument, archiveDocuments, byteSizeOf, deleteDocuments, DOCUMENT_BYTES, editDocument, fileTypeOf, linkDocument, movableBy, moveDocument, readDocumentFile, readDocuments } = await import("../../src/data/documents");
const { addNamed, addPackage, moveBox, openHousehold } = await import("../../src/data/cabinet");
const { undoRows } = await import("../../src/db/mutations");
const { migratedDatabase } = await import("../helpers");

const PDF = Buffer.from("%PDF-1.7 reçete").toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const FIELDS = { kind: "prescription", title: "Kardiyoloji", personId: null, issuedOn: "2026-10-01", note: "Sabah", reference: "1A2B3C" } as const;

const all = (sql: string) => harness.db!.prepare(sql).all() as Record<string, unknown>[];

beforeEach(() => {
  harness.db = migratedDatabase();
});

describe("a document's file", () => {
  it("is told by its own bytes, never by what it claims", () => {
    expect(fileTypeOf(PDF)).toBe("pdf");
    expect(fileTypeOf(JPEG)).toBe("jpeg");
    expect(fileTypeOf(Buffer.from("<html><script>").toString("base64"))).toBeNull();
    expect([byteSizeOf("QQ=="), byteSizeOf("QUI="), byteSizeOf("QUJD")]).toEqual([1, 2, 3]);
  });

  it("is kept beside its row, with its type and size, and refused when its bytes are not what it says", async () => {
    const id = await addDocument("me", FIELDS, { base64: PDF, type: "pdf" });
    const [row] = all("SELECT * FROM documents");
    expect(row).toMatchObject({ id, cabinet_id: "me", kind: "prescription", title: "Kardiyoloji", file_type: "pdf", byte_size: byteSizeOf(PDF), archived: 0 });
    expect(await readDocumentFile(String(row!.file_id))).toBe(PDF);
    await expect(addDocument("me", FIELDS, { base64: JPEG, type: "pdf" })).rejects.toThrow("Not a file the app read");
    await expect(addDocument("me", FIELDS, { base64: "JVBERi" + "A".repeat(14_000_000), type: "pdf" })).rejects.toThrow("too large");
    const largest = Buffer.alloc(DOCUMENT_BYTES);
    largest.write("%PDF-1.7");
    await addDocument("me", FIELDS, { base64: largest.toString("base64"), type: "pdf" });
    expect(all("SELECT COUNT(*) AS n FROM document_files"), "the limit itself is taken").toEqual([{ n: 2 }]);
    expect(await readDocumentFile("0190c000-0000-7000-8000-000000000000")).toBeNull();
  });
});

describe("a document", () => {
  it("is edited, archived and deleted, each undone whole where it is a batch", async () => {
    const id = await addDocument("me", FIELDS, { base64: PDF, type: "pdf" });
    await editDocument(id, { title: "Kardiyoloji kontrol", note: null });
    expect((await readDocuments())[0]).toMatchObject({ title: "Kardiyoloji kontrol", note: null, archived: false });
    const archived = await archiveDocuments([id], true);
    expect((await readDocuments())[0]!.archived).toBe(true);
    await undoRows(archived);
    expect((await readDocuments())[0]!.archived).toBe(false);
    const deleted = (await deleteDocuments([id]))!;
    expect(await readDocuments()).toEqual([]);
    await editDocument(id, { title: "Silinmiş" });
    expect((await archiveDocuments([id], true)).writes, "nothing reaches a deleted one").toEqual([]);
    expect(await moveDocument(id, await openHousehold("me", "Ev"))).toBeNull();
    expect(all(`SELECT title, archived FROM documents WHERE id = '${id}'`), "the tombstone keeps no words").toEqual([{ title: "", archived: 0 }]);
    await undoRows(deleted);
    expect((await readDocuments()).map((document) => document.title), "the undo brings them back").toEqual(["Kardiyoloji kontrol"]);
  });

  it("is linked as it is added from a box's or a product's page, the link the same one linking makes", async () => {
    const box = await addPackage("me", { name: "Coraspin" }, { unit: "tablet" }, 1000);
    const product = String(all("SELECT product_id FROM packages")[0]!.product_id);
    const toBox = await addDocument("me", FIELDS, { base64: PDF, type: "pdf" }, { packageId: box });
    const toProduct = await addDocument("me", FIELDS, { base64: PDF, type: "pdf" }, { productId: product });
    const links = [
      { document_id: toBox, package_id: box, product_id: null },
      { document_id: toProduct, package_id: null, product_id: product },
    ];
    expect(all("SELECT document_id, package_id, product_id FROM document_links ORDER BY package_id IS NULL")).toEqual(links);
    await linkDocument(toBox, { packageId: box }, true);
    await linkDocument(toProduct, { productId: product }, true);
    expect(all("SELECT document_id, package_id, product_id FROM document_links ORDER BY package_id IS NULL")).toEqual(links);
  });

  it("links to a product and a box once each, and lists their names for search", async () => {
    const box = await addPackage("me", { name: "Coraspin" }, { unit: "tablet" }, 1000);
    await addPackage("me", { name: "Beloc" }, { unit: "tablet" }, 1000);
    const product = String(all("SELECT id FROM products WHERE name = 'Beloc'")[0]!.id);
    const id = await addDocument("me", FIELDS, { base64: PDF, type: "pdf" });
    const unlinked = await addDocument("me", { ...FIELDS, issuedOn: "2026-01-01" }, { base64: PDF, type: "pdf" });
    await linkDocument(id, { packageId: box }, true);
    await linkDocument(id, { packageId: box }, true);
    await linkDocument(id, { productId: product }, true);
    await linkDocument(unlinked, { productId: product }, false);
    await linkDocument("0190c000-0000-7000-8000-000000000000", { productId: product }, true);
    expect(await readDocuments()).toEqual([
      expect.objectContaining({ id, packageIds: [box], productIds: [product], names: expect.arrayContaining(["Coraspin", "Beloc"]) }),
      expect.objectContaining({ id: unlinked, packageIds: [], productIds: [], names: [] }),
    ]);
    expect(all("SELECT COUNT(*) AS n FROM document_links"), "no link taken off that was never on, nor one to no document").toEqual([{ n: 2 }]);
    await deleteDocuments([unlinked]);
    await linkDocument(id, { productId: product }, false);
    await linkDocument(id, { productId: product }, true);
    expect(all("SELECT COUNT(*) AS n FROM document_links")).toEqual([{ n: 2 }]);
    await linkDocument(id, { productId: product }, false);
    expect((await readDocuments())[0]).toMatchObject({ productIds: [], names: ["Coraspin"] });
  });

  it("moves to a household with its person and links, and leaves a tombstone with nothing to read; undone whole", async () => {
    const house = await openHousehold("me", "Ev");
    const person = await addNamed("people", "me", "Annem");
    const box = await addPackage("me", { name: "Coraspin" }, { unit: "tablet" }, 1000);
    const id = await addDocument("me", { ...FIELDS, personId: person }, { base64: PDF, type: "pdf" });
    await linkDocument(id, { packageId: box }, true);
    const { id: moved, written } = (await moveDocument(id, house))!;
    const there = (await readDocuments())[0]!;
    expect(there).toMatchObject({ id: moved, cabinetId: house, title: "Kardiyoloji", note: "Sabah", reference: "1A2B3C", packageIds: [box] });
    expect(all(`SELECT cabinet_id, name FROM people WHERE id = '${there.personId}'`), "a person of the same name, made there").toEqual([{ cabinet_id: house, name: "Annem" }]);
    expect(all(`SELECT title, person_id, issued_on, note, reference, file_id IS NOT NULL AS file, deleted_at IS NOT NULL AS gone FROM documents WHERE id = '${id}'`)).toEqual([
      { title: "", person_id: null, issued_on: null, note: null, reference: null, file: 0, gone: 1 },
    ]);
    expect(all("SELECT cabinet_id, document_id, deleted_at IS NULL AS live FROM document_links ORDER BY live")).toEqual([
      { cabinet_id: "me", document_id: id, live: 0 },
      { cabinet_id: house, document_id: moved, live: 1 },
    ]);
    expect(await moveDocument(moved, house), "nothing to move where it is").toBeNull();
    await undoRows(written);
    expect(await readDocuments()).toEqual([expect.objectContaining({ id, cabinetId: "me", title: "Kardiyoloji", fileType: "pdf", packageIds: [box] })]);
  });

  it("follows a box that moves: its link names the box where it went", async () => {
    const house = await openHousehold("me", "Ev");
    const box = await addPackage("me", { name: "Coraspin" }, { unit: "tablet" }, 1000);
    const id = await addDocument("me", FIELDS, { base64: PDF, type: "pdf" });
    await linkDocument(id, { packageId: box }, true);
    const { id: movedBox, written } = (await moveBox(box, house))!;
    expect((await readDocuments())[0]!.packageIds).toEqual([movedBox]);
    await linkDocument(id, { packageId: movedBox }, true);
    expect(all("SELECT COUNT(*) AS n FROM document_links WHERE deleted_at IS NULL"), "the link moved is the one linking makes").toEqual([{ n: 1 }]);
    expect(all("SELECT DISTINCT cabinet_id FROM document_links"), "in the document's cabinet still").toEqual([{ cabinet_id: "me" }]);
    await undoRows(written);
    expect((await readDocuments())[0]!.packageIds).toEqual([box]);
  });

  it("is moved out of where it is by whoever added it, or from the person's own cabinet", () => {
    expect(movableBy({ cabinetId: "me", createdBy: "her" }, "me")).toBe(true);
    expect(movableBy({ cabinetId: "ev", createdBy: "me" }, "me")).toBe(true);
    expect(movableBy({ cabinetId: "ev", createdBy: null }, "me"), "not pushed yet: this device's own").toBe(true);
    expect(movableBy({ cabinetId: "ev", createdBy: "her" }, "me")).toBe(false);
  });
});
