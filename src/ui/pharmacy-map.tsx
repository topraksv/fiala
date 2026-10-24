/**
 * The web draws no pharmacy map: a tile server would learn every place looked
 * at, and the CSP lets nothing past Supabase (`src/domain/web-security.ts`).
 * The list stays, and each pharmacy links out to a map. The phone's half is
 * `pharmacy-map.native.tsx`, on the platform's own map.
 */

import type { Box, Pharmacy, Point } from "../services/guide";

export interface PharmacyMapProps {
  pharmacies: readonly Pharmacy[];
  middle: Point;
  onOpen: (pharmacy: Pharmacy) => void;
  onSearch: (box: Box) => void;
}

export const HAS_MAP = false;

export function PharmacyMap(_: PharmacyMapProps) {
  return null;
}
