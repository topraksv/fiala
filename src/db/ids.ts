/**
 * Ids for rows two devices can make on their own. The id is a hash of the
 * row's natural key, so both devices mint the same primary key and sync meets
 * one row instead of two.
 * Every other row takes a uuidv7 where it is made.
 */

import * as Crypto from "expo-crypto";

/** SHA-256 of the key in a UUID's shape, its version nibble 8 so it never meets the v7 space. */
export async function deterministicId(naturalKey: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, naturalKey);
  const h = hex.slice(0, 32).split("");
  h[12] = "8";
  h[16] = "8";
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export const naturalKeys = {
  /** One row per setting, so two devices writing it meet one row. The server keys it by person too. */
  setting: (key: string) => `setting:${key}`,
};
