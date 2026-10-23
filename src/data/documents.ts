/**
 * Documents (`docs/TASKS.md` F3.1–F3.5): a prescription, a lab result, a
 * letter, each a row in a cabinet with its file kept beside it on the device
 * (`document_files`) and in Storage (`src/sync/documents.ts`). Where it is is
 * who sees it, as for a box: the person's own cabinet is "only me", a
 * household's is its members' (migration 14).
 */

import { uuidv7 } from "uuidv7";
import { getSqliteAsync } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { deleteRows, editRow, findRow, fromDbShape, nowIso, writeRows, writeUndoable, type RowsWritten, type RowWrite } from "../db/mutations";
import type { DocumentFileType, DocumentKind } from "../db/schema";
import { inLiveCabinet, nameThere, relinked } from "./cabinet";

/** Storage's limit on one file (migration 14). */
export const DOCUMENT_BYTES = 10 * 1024 * 1024;

/** A file the app read, base64, and what its own bytes say it is. */
export interface NewDocumentFile {
  base64: string;
  type: DocumentFileType;
}

/**
 * What a file's first bytes say it is — `%PDF` or a JPEG's FF D8 FF — and
 * nothing else is kept: a household member writes the row naming a file, so
 * neither the row nor a picker decides how the device opens it.
 */
export function fileTypeOf(base64: string): DocumentFileType | null {
  if (base64.startsWith("JVBERi")) return "pdf";
  if (base64.startsWith("/9j/")) return "jpeg";
  return null;
}

export function byteSizeOf(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export interface DocumentFields {
  kind: DocumentKind;
  title: string;
  personId: string | null;
  issuedOn: string | null;
  note: string | null;
  reference: string | null;
}

export interface CabinetDocument extends DocumentFields {
  id: string;
  cabinetId: string;
  fileId: string | null;
  fileType: DocumentFileType | null;
  byteSize: number | null;
  archived: boolean;
  /** Who added it; `null` until the server has said, which is this device's own. */
  createdBy: string | null;
  createdAt: string;
  /** The boxes and products it names that are live on this device. */
  packageIds: string[];
  productIds: string[];
  /** Their names, for search: a product's, or a box's product's. */
  names: string[];
}

type LinkTarget = { productId: string } | { packageId: string };

async function linkIdOf(documentId: string, target: LinkTarget) {
  const productId = "productId" in target ? target.productId : null;
  const packageId = "packageId" in target ? target.packageId : null;
  return { id: await deterministicId(naturalKeys.documentLink(documentId, (productId ?? packageId)!)), productId, packageId };
}

/** Add a document with its file, and linked to a box or a product in the same write when added from one; its new id. */
export async function addDocument(cabinetId: string, fields: DocumentFields, file: NewDocumentFile, linkedTo?: LinkTarget): Promise<string> {
  if (fileTypeOf(file.base64) !== file.type) throw new Error("Not a file the app read");
  const byteSize = byteSizeOf(file.base64);
  if (byteSize > DOCUMENT_BYTES) throw new Error("The file is too large");
  const id = uuidv7();
  const fileId = uuidv7();
  const link = linkedTo && (await linkIdOf(id, linkedTo));
  await writeRows(async () => {
    const sqlite = await getSqliteAsync();
    await sqlite.runAsync("INSERT INTO document_files (id, data, created_at) VALUES (?, ?, ?)", [fileId, file.base64, nowIso()]);
    const writes: RowWrite[] = [{ table: "documents", row: { id, cabinetId, ...fields, fileId, fileType: file.type, byteSize, archived: false, createdBy: null } }];
    if (link) writes.push({ table: "document_links", row: { ...link, cabinetId, documentId: id } });
    return writes;
  });
  return id;
}

export async function editDocument(id: string, patch: Partial<DocumentFields>): Promise<void> {
  return writeRows(async () => {
    const there = await findRow("documents", id);
    return there && there.deleted_at == null ? editRow("documents", there, patch) : [];
  });
}

/** Archive documents, or take them back out; one write an undo takes back. */
export async function archiveDocuments(ids: readonly string[], archived: boolean): Promise<RowsWritten> {
  return writeUndoable(async () => {
    const writes: RowWrite[] = [];
    for (const id of ids) {
      const there = await findRow("documents", id);
      if (there && there.deleted_at == null) writes.push(...editRow("documents", there, { archived }));
    }
    return writes;
  });
}

export const deleteDocuments = (ids: readonly string[]) => deleteRows("documents", ids);

/**
 * Link a document to a product or a box, or take the link off. The link is
 * in the document's cabinet whichever the box is in (migration 14); its id
 * is the pair's, so linking again is the one row.
 */
export async function linkDocument(documentId: string, target: LinkTarget, on: boolean): Promise<void> {
  const { id, productId, packageId } = await linkIdOf(documentId, target);
  return writeRows(async () => {
    const there = await findRow("document_links", id);
    if (there) return editRow("document_links", there, { deletedAt: on ? null : nowIso() });
    const document = await findRow("documents", documentId);
    if (!on || !document) return [];
    return [{ table: "document_links", row: { id, cabinetId: String(document.cabinet_id), documentId, productId, packageId } }];
  });
}

/**
 * Whether this person may move a document out of where it is: one in their
 * own cabinet, or one they added. A file is read by its sender and through a
 * live row (migration 14), so a member moving another's document into their
 * own cabinet would take it from the household and still not read it.
 */
export function movableBy(document: Pick<CabinetDocument, "cabinetId" | "createdBy">, me: string): boolean {
  return document.cabinetId === me || document.createdBy === me || document.createdBy === null;
}

/**
 * Move a document to another cabinet (F3.5), as `moveBox` moves a box: made
 * afresh there with its links, and tombstoned here. The tombstone keeps
 * nothing anyone could read, its file least: an editor of the household it
 * left may bring a tombstone back to life, and the server checks a file only
 * when a write names it anew. The undo names it anew, as its sender. Its new
 * id, and one write `undoRows` takes back whole; `null` when there was
 * nothing to move.
 */
export async function moveDocument(documentId: string, cabinetId: string): Promise<{ id: string; written: RowsWritten } | null> {
  const id = uuidv7();
  const written = await writeUndoable(async () => {
    const document = await findRow("documents", documentId);
    if (!document || document.deleted_at != null || document.cabinet_id === cabinetId) return [];
    const writes: RowWrite[] = [];
    const { tombstoneVersion: _, ...shape } = fromDbShape("documents", document);
    // The server names the mover as who added it (migration 14).
    writes.push({ table: "documents", row: { ...shape, id, cabinetId, personId: await nameThere("people", document.person_id, cabinetId, writes), createdBy: null } });
    writes.push(...(await relinked("document_id", documentId, id, cabinetId)));
    writes.push({ table: "documents", row: { ...shape, title: "", personId: null, issuedOn: null, note: null, reference: null, fileId: null, fileType: null, byteSize: null, deletedAt: nowIso() } });
    return writes;
  });
  return written.writes.length > 0 ? { id, written } : null;
}

/** Every live document on the device, the newest first. */
export async function readDocuments(): Promise<CabinetDocument[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM documents WHERE deleted_at IS NULL AND ${inLiveCabinet("cabinet_id")}
      ORDER BY COALESCE(issued_on, substr(created_at, 1, 10)) DESC, created_at DESC`,
  );
  // A link to a product or a box this device does not hold live is left out.
  const links = await sqlite.getAllAsync<{ documentId: string; productId: string | null; packageId: string | null; name: string }>(
    `SELECT l.document_id AS documentId, p.id AS productId, k.id AS packageId, COALESCE(p.name, b.name) AS name
       FROM document_links l
       LEFT JOIN products p ON p.id = l.product_id AND p.deleted_at IS NULL
       LEFT JOIN packages k ON k.id = l.package_id AND k.deleted_at IS NULL
       LEFT JOIN products b ON b.id = k.product_id
      WHERE l.deleted_at IS NULL AND COALESCE(p.id, k.id) IS NOT NULL`,
  );
  return rows.map((row) => {
    const own = links.filter((link) => link.documentId === row.id);
    return {
      ...(fromDbShape("documents", row) as unknown as Omit<CabinetDocument, "packageIds" | "productIds" | "names">),
      packageIds: own.flatMap((link) => (link.packageId ? [link.packageId] : [])),
      productIds: own.flatMap((link) => (link.productId ? [link.productId] : [])),
      names: [...new Set(own.map((link) => link.name))],
    };
  });
}

/** A document's file as base64, or `null` where it has not reached this device. */
export async function readDocumentFile(fileId: string): Promise<string | null> {
  const sqlite = await getSqliteAsync();
  return (await sqlite.getFirstAsync<{ data: string }>("SELECT data FROM document_files WHERE id = ?", [fileId]))?.data ?? null;
}
