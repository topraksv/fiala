/**
 * Hands text to the device's share sheet (`docs/SPEC.md` 6.2). A browser
 * without one — Firefox on a desktop — puts it on the clipboard instead, and
 * the caller says so, since nothing else on screen would.
 */

import { Platform, Share } from "react-native";

/** Which surface took the text. */
export async function shareText(text: string): Promise<"sheet" | "clipboard"> {
  if (Platform.OS === "web" && typeof navigator.share !== "function") {
    await navigator.clipboard.writeText(text);
    return "clipboard";
  }
  try {
    await Share.share({ message: text });
  } catch (error) {
    // Closing the sheet rejects on the web, where a DOMException is an Error;
    // on a phone it resolves, and Hermes has no DOMException to test against.
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  }
  return "sheet";
}
