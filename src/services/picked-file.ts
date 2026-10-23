import { Platform } from "react-native";
import type { DocumentPickerAsset } from "expo-document-picker";

/** Helix's `UserFacingError`: thrown with a `tr` string, whose remedy is the person's. Fiala has no other thrower, so it lives here. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * Expo's file reader, loaded on a phone alone. Metro folds `Platform.OS` on
 * the web build, so the branch and expo-file-system leave the web bundle;
 * Helix imports it outright; here that was 23 KB of the web entry.
 */
async function expoFile(uri: string) {
  const fileSystem = Platform.OS === "web" ? null : await import("expo-file-system");
  return new fileSystem!.File(uri);
}

/** Read a document-picker asset through the API native to its platform.
 * Web assets carry a browser File; passing their blob URL to expo-file-system
 * throws before reading. Native assets remain sandbox file URIs. */
export async function readPickedText(
  asset: DocumentPickerAsset,
  maxBytes: number,
  tooLargeMessage: string,
  invalidEncodingMessage: string,
): Promise<string> {
  const bytes = await readPickedBytes(asset, maxBytes, tooLargeMessage);
  if (!isValidUtf8(bytes)) throw new UserFacingError(invalidEncodingMessage);
  if (Platform.OS === "web") {
    return new TextDecoder().decode(bytes);
  }
  // Bare Hermes has no TextDecoder. Validate the native bytes above, then let
  // Expo decode the same bounded file instead of adding a second codec.
  return (await expoFile(asset.uri)).text();
}

export async function readPickedBytes(
  asset: DocumentPickerAsset,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  assertKnownSize([asset.size, asset.file?.size], maxBytes, tooLargeMessage);
  if (Platform.OS === "web") {
    if (asset.file) {
      const bytes = new Uint8Array(await asset.file.arrayBuffer());
      assertKnownSize([bytes.byteLength], maxBytes, tooLargeMessage);
      return bytes;
    }
    const response = await fetch(asset.uri);
    if (!response.ok) throw new Error(`Selected file could not be read (${response.status})`);
    return readBoundedResponse(response, maxBytes, tooLargeMessage);
  }
  const file = await expoFile(asset.uri);
  assertKnownSize([file.size], maxBytes, tooLargeMessage);
  const bytes = await file.bytes();
  assertKnownSize([bytes.byteLength], maxBytes, tooLargeMessage);
  return bytes;
}

function assertKnownSize(sizes: readonly (number | null | undefined)[], maxBytes: number, message: string): void {
  // `Number.isFinite` is false for anything but a finite number: an unknown size passes to the byte count.
  if (sizes.some((size) => Number.isFinite(size) && (size as number) > maxBytes)) {
    throw new UserFacingError(message);
  }
}

/** A lead byte's continuation count, payload mask and least code point; `null` for a byte no sequence starts with. */
function leadOf(first: number): readonly [remaining: number, mask: number, minimum: number] | null {
  if (first >= 0xc2 && first <= 0xdf) return [1, 0x1f, 0x80];
  if (first >= 0xe0 && first <= 0xef) return [2, 0x0f, 0x800];
  if (first >= 0xf0 && first <= 0xf4) return [3, 0x07, 0x10000];
  return null;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index++]!;
    if (first <= 0x7f) continue;
    const lead = leadOf(first);
    if (!lead || index + lead[0] > bytes.length) return false;
    let codePoint = first & lead[1];
    for (let offset = 0; offset < lead[0]; offset += 1) {
      const next = bytes[index++]!;
      if ((next & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < lead[2] || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
  }
  return true;
}

async function readBoundedResponse(response: Response, maxBytes: number, message: string): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  assertKnownSize([contentLength], maxBytes, message);

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertKnownSize([bytes.byteLength], maxBytes, message);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      assertKnownSize([total], maxBytes, message);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
