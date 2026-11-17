/** How much of a box is left, as a bar under its row: drawn only once its moves say how much went in. */

import { View } from "react-native";

import type { CabinetBox } from "../data/cabinet";
import { useMoves } from "../data/hooks";
import { localDay } from "../domain/boxes";
import { ProgressBar } from "./components";
import { boxPill, stockShare } from "./expiry-pill";
import { spacing, useTheme } from "./theme";

/**
 * One live query per box, over the same table every move writes: a cabinet of
 * dozens of boxes reads a few dozen small lists, not one join, because the
 * cabinet's own read carries each box's total and not what it started with.
 */
export function StockBar({ box, tall = false }: { box: CabinetBox; tall?: boolean }) {
  const { palette } = useTheme();
  const moves = useMoves(box.id);
  const share = box.counted && (moves.status === "ready" || moves.status === "stale") ? stockShare(box.remainingMilli, moves.data) : null;
  if (share == null) return null;
  const tone = boxPill(box, localDay())?.tone;
  return (
    <View style={{ marginTop: tall ? 0 : spacing.sm }}>
      <ProgressBar value={share} tall={tall} color={tone === "error" ? palette.error : tone === "warning" ? palette.warning : undefined} />
    </View>
  );
}
