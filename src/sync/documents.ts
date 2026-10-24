/**
 * Documents' files beside their rows (migration 14): each is one file in the
 * private `documents` bucket, `<file id>/file.pdf` or `…/file.jpg`, read by
 * its sender and by whoever can read a live row naming it. Unlike a photo,
 * a file is sent after the push and never inside it, so ten megabytes on a
 * weak line hold up no other change; and it is fetched only when its
 * document is opened, not after every pull.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSqliteAsync } from "../db/client";
import { nowIso } from "../db/mutations";
import type { DocumentFileType } from "../db/schema";
import { fileTypeOf } from "../data/documents";
import { isUuidShaped } from "./merge-policy";
import { base64OfBlob, bytesOf, checkActive, refusedForGood } from "./photos";
import { getSupabase } from "./supabase";

const BUCKET = "documents";
const FILE = { pdf: ["pdf", "application/pdf"], jpeg: ["jpg", "image/jpeg"] } as const satisfies Record<DocumentFileType, readonly [string, string]>;

export const documentPath = (fileId: string, type: DocumentFileType) => `${fileId}/file.${FILE[type][0]}`;

/** The files a live row names. */
const NAMED = "SELECT file_id FROM documents WHERE deleted_at IS NULL AND file_id IS NOT NULL";

/** Files Storage refused for good, not offered again until the next launch. */
const refused = new Set<string>();

/**
 * Send every file a live row names that Storage does not have yet. One
 * refused for good is passed over; any other failure waits for the next
 * sync, and none fails this one.
 */
export async function sendPendingDocuments(supabase: SupabaseClient, signal: AbortSignal): Promise<void> {
  const sqlite = await getSqliteAsync();
  const pending = await sqlite.getAllAsync<{ id: string; data: string; type: DocumentFileType }>(
    `SELECT f.id, f.data, MIN(d.file_type) AS type FROM document_files f JOIN documents d ON d.file_id = f.id AND d.deleted_at IS NULL
      WHERE f.uploaded_at IS NULL GROUP BY f.id`,
  );
  for (const file of pending) {
    if (refused.has(file.id)) continue;
    checkActive(signal);
    // `upsert`, so a send cut short is finished by the next.
    const { error } = await supabase.storage.from(BUCKET).upload(documentPath(file.id, file.type), bytesOf(file.data), { contentType: FILE[file.type][1], upsert: true });
    if (error && refusedForGood(error)) refused.add(file.id);
    else if (error) return;
    else await sqlite.runAsync("UPDATE document_files SET uploaded_at = ? WHERE id = ?", [nowIso(), file.id]);
  }
}

/**
 * A document's file, from the device or else from Storage, kept here once
 * fetched; `null` when neither has it for this person, or it is not the type
 * its row says. A network failure throws, for the screen to say so.
 */
export async function fetchDocumentFile(fileId: string, type: DocumentFileType): Promise<string | null> {
  const sqlite = await getSqliteAsync();
  const held = await sqlite.getFirstAsync<{ data: string }>("SELECT data FROM document_files WHERE id = ?", [fileId]);
  if (held) return fileTypeOf(held.data) === type ? held.data : null;
  const supabase = getSupabase();
  if (!supabase || !isUuidShaped(fileId)) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(documentPath(fileId, type));
  if (error) {
    // A 4xx is Storage answering: not there yet, or not this person's to read.
    if ((error.status ?? 500) < 500) return null;
    throw new Error(`document download: ${error.message}`);
  }
  const base64 = await base64OfBlob(data);
  if (fileTypeOf(base64) !== type) return null;
  const now = nowIso();
  await sqlite.runAsync("INSERT OR IGNORE INTO document_files (id, data, created_at, uploaded_at) VALUES (?, ?, ?, ?)", [fileId, base64, now, now]);
  return base64;
}

const swept = new WeakSet<AbortSignal>();

/**
 * Once a sync session, the files no live row names leave this person's
 * Storage a month on, as photos do. On the device one goes at once when
 * Storage has it — a household left, a document deleted or moved away — and
 * one never sent waits the month, so an undo finds it.
 */
export async function sweepUnnamedDocuments(supabase: SupabaseClient, signal: AbortSignal): Promise<void> {
  if (swept.has(signal)) return;
  swept.add(signal);
  const sqlite = await getSqliteAsync();
  // A month, as a photo's: a device may hold the row naming a file unsent. Inside the function, not a module constant, so its mutant is mapped to the test that kills it.
  const before = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await sqlite.runAsync(`DELETE FROM document_files WHERE id NOT IN (${NAMED}) AND (uploaded_at IS NOT NULL OR created_at < ?)`, [before]);
  const { data, error } = await supabase.rpc("unnamed_documents");
  if (error) return;
  const paths = data as string[];
  for (let at = 0; at < paths.length; at += 100) {
    checkActive(signal);
    if ((await supabase.storage.from(BUCKET).remove(paths.slice(at, at + 100))).error) return;
  }
}

/**
 * Remove every file the account sent, before the account goes, as its
 * photos: the files of documents it added to a household go with it (KVKK's
 * erasure), and their rows stay there without them. The device's copies are
 * marked unsent, so an account that survives sends them again.
 */
export async function purgeOwnDocuments(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.rpc("own_document_objects");
  if (error) throw new Error(`document purge: ${error.message}`);
  const paths = data as string[];
  for (let at = 0; at < paths.length; at += 100) {
    const { error: removal } = await supabase.storage.from(BUCKET).remove(paths.slice(at, at + 100));
    if (removal) throw new Error(`document purge: ${removal.message}`);
  }
  const sqlite = await getSqliteAsync();
  const removed = [...new Set(paths.map((path) => path.split("/")[0]))];
  await sqlite.runAsync("UPDATE document_files SET uploaded_at = NULL WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(removed)]);
}
