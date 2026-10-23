/**
 * A photo on a person, a product or a box (`docs/TASKS.md` F1.19, F1.20),
 * kept on the device beside the row that names it (`src/db/schema.ts`
 * `photos`). Gital's.
 */

import { uuidv7 } from "uuidv7";
import { getSqliteAsync } from "../db/client";
import { nowIso } from "../db/mutations";

/** A photo the app took and shrank (`src/ui/photo-take.ts`), both sizes as JPEG data URIs. */
export interface NewPhoto {
  data: string;
  thumb: string;
}

// Only what the app itself encoded is drawn: a row's photo is an image source,
// and one arriving by sync must not name a remote address or a script.
const JPEG_DATA = /^data:image\/jpeg;base64,[A-Za-z0-9+/=_-]+$/;

/**
 * Inside a write's transaction: the column a photo change writes, a new
 * photo stored first and `null` taking it off.
 */
export async function photoColumn(change: NewPhoto | null): Promise<{ photoId: string | null }> {
  if (change === null) return { photoId: null };
  if (!JPEG_DATA.test(change.data) || !JPEG_DATA.test(change.thumb)) throw new Error("Not a photo the app took");
  const id = uuidv7();
  const sqlite = await getSqliteAsync();
  await sqlite.runAsync("INSERT INTO photos (id, data, thumb, created_at) VALUES (?, ?, ?, ?)", [id, change.data, change.thumb, nowIso()]);
  return { photoId: id };
}

/** The full photo, or `null` where it has not reached this device. */
export async function readPhoto(id: string): Promise<string | null> {
  const sqlite = await getSqliteAsync();
  return (await sqlite.getFirstAsync<{ data: string }>("SELECT data FROM photos WHERE id = ?", [id]))?.data ?? null;
}

