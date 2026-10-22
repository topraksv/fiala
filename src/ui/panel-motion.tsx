/**
 * A panel on the web changes size without motion. Reanimated's web support
 * runs its layout animations in JavaScript without springs, and pulling it into
 * the entry bundle would cost every visitor the download for a cosmetic gain —
 * the boundary `keyboard-safe.tsx` draws too. The `.native` file animates it.
 */
import type { ReactNode } from "react";

export function PanelMotion({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
