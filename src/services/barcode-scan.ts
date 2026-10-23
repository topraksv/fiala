/**
 * The web has no scanner: a browser's camera needs a decoding library in the
 * page, and the box is in the hand of someone holding a phone. The code is
 * typed instead. `barcode-scan.native.ts` is the phone's.
 */

export const canScan = false;

export function onScanned(_read: (code: string) => void): () => void {
  return () => {};
}

export async function launchScanner(): Promise<boolean> {
  return false;
}
