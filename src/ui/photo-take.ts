/**
 * Taking a photo of a person, a product or a box (`docs/TASKS.md` F1.19,
 * F1.20), or choosing a screenshot for feedback, and shrinking it before it is
 * stored. Its own chunk on the web (`./photo-field.tsx` and
 * `src/app/feedback.tsx` load it), so the entry carries neither library.
 */

import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync } from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import type { NewPhoto } from "../data/photos";

/** The longest edge kept, and a row tile's: a label's print still reads, and a camera's own file would weigh on every sync. */
export const PHOTO_EDGE = 1024;
export const THUMB_EDGE = 160;
const QUALITY = 0.7;

/** What a take came to: a photo, nothing chosen, or the camera refused. */
export type Taken = NewPhoto | "cancelled" | "denied";

/** One edge given, so the other follows the photo's own proportions; never enlarged. */
export function edgeOf(width: number, height: number, edge: number): { width: number } | { height: number } {
  return width >= height ? { width: Math.min(width, edge) } : { height: Math.min(height, edge) };
}

async function shrunk(uri: string, width: number, height: number, edge: number): Promise<string> {
  const image = await ImageManipulator.manipulate(uri).resize(edgeOf(width, height, edge)).renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: QUALITY, base64: true });
  if (!saved.base64) throw new Error("The photo was not encoded");
  return `data:image/jpeg;base64,${saved.base64}`;
}

async function photoOf(uri: string, width: number, height: number, edge: number): Promise<NewPhoto> {
  const [data, thumb] = await Promise.all([shrunk(uri, width, height, edge), shrunk(uri, width, height, THUMB_EDGE)]);
  return { data, thumb };
}

/** `edge` is larger for a screenshot, whose print must read in a report (SPEC 4.1). */
export default async function takePhoto(from: "camera" | "library", edge = PHOTO_EDGE): Promise<Taken> {
  if (from === "camera" && !(await requestCameraPermissionsAsync()).granted) return "denied";
  // The library needs no permission: the system's own picker hands over only what was chosen.
  const launch = from === "camera" ? launchCameraAsync : launchImageLibraryAsync;
  const picked = await launch({ mediaTypes: ["images"], quality: 1 });
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return "cancelled";
  return photoOf(asset.uri, asset.width, asset.height, edge);
}

