/**
 * Photos beside the rows, Gital's (`docs/ARCHITECTURE.md` "A photo is two
 * shrunk copies in a local table, mirrored to Storage"): each is two JPEGs in
 * the private `photos` bucket, `<photo id>/full.jpg` and `…/thumb.jpg`, which
 * whoever can read a row naming it may read. A photo is never edited — a new
 * one is a new id — so each is sent once and fetched once.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSqliteAsync } from "../db/client";
import type { SyncedTableName } from "../db/schema";
import { nowIso } from "../db/mutations";
import { isUuidShaped } from "./merge-policy";
import { SessionEpochCancelledError } from "./session-epoch";
import { getSupabase } from "./supabase";

const BUCKET = "photos";
const SIZES = [
  ["full", "data"],
  ["thumb", "thumb"],
] as const;

/** The tables whose rows name a photo: a person, a product, a box, a household. */
export const PHOTO_TABLES: ReadonlySet<SyncedTableName> = new Set(["people", "products", "packages", "cabinets"]);

/** The photos a live row of those tables names. */
const NAMED = [...PHOTO_TABLES].map((table) => `SELECT photo_id FROM ${table} WHERE deleted_at IS NULL`).join(" UNION ");

/** Photos Storage answered for with no file, not asked again until the next launch. */
const unavailable = new Set<string>();
/**
 * Photos and document files Storage refused for good, by id, not offered
 * again until the next launch. The row's screen says so (F7.10): it stays on
 * this device alone, and nothing else would tell.
 */
const refused = new Set<string>();
const heard = new Set<() => void>();

export function refuse(id: string): void {
  refused.add(id);
  for (const listener of heard) listener();
}

export const refusedFiles = {
  has: (id: string) => refused.has(id),
  subscribe(listener: () => void): () => void {
    heard.add(listener);
    return () => heard.delete(listener);
  },
};

/** A data URI's bytes, or bare base64's. */
export function bytesOf(dataUri: string): Uint8Array {
  const binary = atob(dataUri.slice(dataUri.indexOf(",") + 1));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** React Native's Blob has no `arrayBuffer`; its FileReader does the same work natively. */
export function base64OfBlob(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer().then((buffer) => base64Of(new Uint8Array(buffer)));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => (reader.error ? reject(reader.error) : resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1)));
    reader.readAsDataURL(blob);
  });
}

/**
 * A row's photo is drawn as an image source, and the file came from whoever
 * wrote the row: only a JPEG — FF D8 FF, `/9j/` in base64 — becomes one.
 * Both readers above give base64 alone, so the prefix is the whole check.
 */
function jpegDataUri(base64: string): string | null {
  return base64.startsWith("/9j/") ? `data:image/jpeg;base64,${base64}` : null;
}

export function checkActive(signal: AbortSignal): void {
  if (signal.aborted) throw new SessionEpochCancelledError();
}

/**
 * Storage answering that this photo is not this person's to place (403), or
 * is someone else's already (409): asking again changes nothing. An expired
 * token, a timeout or a rate limit does, and so does a network failure;
 * Storage has answered a bad token with 400 or 403, so its message decides.
 */
export function refusedForGood(error: { status?: number; message: string }): boolean {
  if (error.status == null || error.status < 400 || error.status >= 500 || [401, 408, 429].includes(error.status)) return false;
  return !/jwt|token|expired|unauthori[sz]ed|signature/i.test(error.message);
}

/** Both sizes of one photo; false when Storage refuses it for good. */
async function sendPhoto(supabase: SupabaseClient, photo: { id: string; data: string; thumb: string }, signal: AbortSignal): Promise<boolean> {
  for (const [size, column] of SIZES) {
    checkActive(signal);
    // `upsert`, so a send cut short between the two sizes is finished by the next.
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(`${photo.id}/${size}.jpg`, bytesOf(photo[column]), { contentType: "image/jpeg", upsert: true });
    if (error && refusedForGood(error)) return false;
    if (error) throw new Error(`photo upload: ${error.message}`);
  }
  return true;
}

/**
 * Send every photo a live row names and Storage does not have yet. One Storage
 * refuses for good is passed over, still unsent, so it cannot stop every other
 * change from syncing; a row naming it then goes up without it, which is what
 * the server would hold either way.
 */
export async function sendPendingPhotos(supabase: SupabaseClient, signal: AbortSignal): Promise<void> {
  const sqlite = await getSqliteAsync();
  const pending = await sqlite.getAllAsync<{ id: string; data: string; thumb: string }>(
    `SELECT id, data, thumb FROM photos WHERE uploaded_at IS NULL AND id IN (${NAMED})`,
  );
  // Every id here is the device's own, or one a fetch below checked.
  for (const photo of pending) {
    if (refused.has(photo.id)) continue;
    if (await sendPhoto(supabase, photo, signal)) await sqlite.runAsync("UPDATE photos SET uploaded_at = ? WHERE id = ?", [nowIso(), photo.id]);
    else refuse(photo.id);
  }
}

async function download(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) {
    // A 4xx is Storage answering: not there, or not this person's to read. A
    // network failure carries the field too, left undefined.
    if (error.status != null && error.status < 500) return null;
    throw new Error(`photo download: ${error.message}`);
  }
  return jpegDataUri(await base64OfBlob(data));
}

/** Fetch every photo a live row names that this device does not hold. */
export async function fetchMissingPhotos(supabase: SupabaseClient, signal: AbortSignal): Promise<void> {
  const sqlite = await getSqliteAsync();
  const missing = await sqlite.getAllAsync<{ id: string }>(
    `SELECT photo_id AS id FROM (${NAMED}) WHERE photo_id IS NOT NULL AND photo_id NOT IN (SELECT id FROM photos)`,
  );
  for (const { id } of missing) {
    if (!isUuidShaped(id) || unavailable.has(id)) continue;
    checkActive(signal);
    const [full, thumb] = await Promise.all(SIZES.map(([size]) => download(supabase, `${id}/${size}.jpg`)));
    if (!full || !thumb) {
      unavailable.add(id);
      continue;
    }
    checkActive(signal);
    const now = nowIso();
    await sqlite.runAsync("INSERT OR IGNORE INTO photos (id, data, thumb, created_at, uploaded_at) VALUES (?, ?, ?, ?, ?)", [id, full, thumb, now, now]);
  }
}

/** How long a photo no row names is kept: a device may hold the row naming it unsent (migration 2). */
const UNNAMED_KEPT_MS = 30 * 86_400_000;
const swept = new WeakSet<AbortSignal>();

/**
 * Once a sync session, the photos no row names any more — replaced, undone, gone with
 * their row — leave this person's Storage, and the device's copies of every
 * such photo leave its own. Each half waits a month, so a row still on its way
 * finds its photo. A failure waits for the next session: nothing here is urgent.
 */
export async function sweepUnnamedPhotos(supabase: SupabaseClient, signal: AbortSignal): Promise<void> {
  if (swept.has(signal)) return;
  swept.add(signal);
  const { data, error } = await supabase.rpc("unnamed_photos");
  if (error) return;
  const paths = data as string[];
  for (let at = 0; at < paths.length; at += 100) {
    checkActive(signal);
    if ((await supabase.storage.from(BUCKET).remove(paths.slice(at, at + 100))).error) return;
  }
  checkActive(signal);
  const sqlite = await getSqliteAsync();
  const before = new Date(Date.now() - UNNAMED_KEPT_MS).toISOString();
  await sqlite.runAsync(`DELETE FROM photos WHERE created_at < ? AND id NOT IN (SELECT photo_id FROM (${NAMED}) WHERE photo_id IS NOT NULL)`, [before]);
}

/**
 * Remove every photo the account sent, before the account goes: Storage keeps
 * a file its owner no longer exists for, and nothing cascades to it. The
 * device's copies of those are marked unsent, so if the account then
 * survives, the next sync sends them again. Only those: a photo fetched from
 * another member is theirs to update, and a send of it would be refused at
 * every sync, before any row went.
 */
export async function purgeOwnPhotos(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { data, error } = await supabase.rpc("own_photo_objects");
  if (error) throw new Error(`photo purge: ${error.message}`);
  const paths = data as string[];
  for (let at = 0; at < paths.length; at += 100) {
    const { error: removal } = await supabase.storage.from(BUCKET).remove(paths.slice(at, at + 100));
    if (removal) throw new Error(`photo purge: ${removal.message}`);
  }
  const sqlite = await getSqliteAsync();
  const removed = [...new Set(paths.map((path) => path.split("/")[0]))];
  await sqlite.runAsync("UPDATE photos SET uploaded_at = NULL WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(removed)]);
}
