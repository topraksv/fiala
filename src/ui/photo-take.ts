/**
 * Choosing a picture from the library and shrinking it before it is kept.
 * Its own chunk on the web (`src/app/feedback.tsx` loads it), so the entry
 * carries neither library.
 */

import { launchImageLibraryAsync } from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

const QUALITY = 0.7;

/** One edge given, so the other follows the picture's own proportions; never enlarged. */
export function edgeOf(width: number, height: number, edge: number): { width: number } | { height: number } {
  return width >= height ? { width: Math.min(width, edge) } : { height: Math.min(height, edge) };
}

/** The picture as a JPEG data URI, its longest edge at most `edge`, or `"cancelled"` when none was chosen. */
export default async function pickPicture(edge: number): Promise<string> {
  // The library needs no permission: the system's own picker hands over only what was chosen.
  const picked = await launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return "cancelled";
  const image = await ImageManipulator.manipulate(asset.uri).resize(edgeOf(asset.width, asset.height, edge)).renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: QUALITY, base64: true });
  if (!saved.base64) throw new Error("The picture was not encoded");
  return `data:image/jpeg;base64,${saved.base64}`;
}
