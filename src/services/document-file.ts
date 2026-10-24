/**
 * A document's file leaving the app to be read or kept (`docs/TASKS.md`
 * F3.2): in a browser a tab of its own or a download, on a phone the share
 * sheet, whose preview reads a PDF and whose apps keep one. The type given is
 * the one its bytes said (`fileTypeOf`), never the row's word, so nothing a
 * household member wrote decides how the device opens it.
 */

import { Platform } from "react-native";

import type { DocumentFileType } from "../db/schema";
import { bytesOf } from "../sync/photos";

/** A document's file, or one the app writes for the person to keep: a backup, an inventory (F4.3, F4.5). */
type FileType = DocumentFileType | "json" | "xlsx";
const MIME = { pdf: "application/pdf", jpeg: "image/jpeg", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } as const;
const UTI = { pdf: "com.adobe.pdf", jpeg: "public.jpeg", json: "public.json", xlsx: "org.openxmlformats.spreadsheetml.sheet" } as const;
const EXTENSION = { pdf: "pdf", jpeg: "jpg", json: "json", xlsx: "xlsx" } as const;
/** Long enough for the tab or the download to have read it. */
const URL_KEPT_MS = 60_000;

/** A name a file system takes: none of the characters any of them refuses. */
const fileNameOf = (name: string, type: FileType) => `${name.replace(/[\\/:*?"<>|\n\r]/g, "-").trim().slice(0, 60) || "belge"}.${EXTENSION[type]}`;

function blobUrlOf(base64: string, type: FileType): string {
  const url = URL.createObjectURL(new Blob([bytesOf(base64) as BlobPart], { type: MIME[type] }));
  setTimeout(() => URL.revokeObjectURL(url), URL_KEPT_MS);
  return url;
}

/**
 * A browser lets only a tap's own call open a tab: it is opened before the
 * file is read, and given the file after. `null` on a phone, or where the
 * browser refused it.
 */
export function openingTab(): Window | null {
  if (Platform.OS !== "web") return null;
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/** Show a PDF in the tab `openingTab` opened, or on a phone hand it to the share sheet. */
export async function showPdf(tab: Window | null, base64: string, name: string): Promise<void> {
  // No tab on a phone; a refused one downloads it instead: the app's own page never leaves for the file.
  if (!tab) return shareDocument(base64, "pdf", name);
  tab.location.href = blobUrlOf(base64, "pdf");
}

/** Keep or send a file: a download in a browser, the share sheet on a phone. */
export async function shareDocument(base64: string, type: FileType, name: string): Promise<void> {
  if (Platform.OS === "web") {
    const link = document.createElement("a");
    link.href = blobUrlOf(base64, type);
    link.download = fileNameOf(name, type);
    link.click();
    return;
  }
  const [{ File, Paths }, Sharing] = await Promise.all([import("expo-file-system"), import("expo-sharing")]);
  const file = new File(Paths.cache, fileNameOf(name, type));
  file.create({ overwrite: true });
  await file.write(base64, { encoding: "base64" });
  await Sharing.shareAsync(file.uri, { mimeType: MIME[type], UTI: UTI[type], dialogTitle: name });
}
