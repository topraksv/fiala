/**
 * A panel that changes size as a row inside it comes or goes: it slides to
 * its new height rather than jumping, and nothing inside fades in on the
 * first draw, only when it arrives later.
 *
 * `ReduceMotion.System` is not optional: a Reanimated animation does not ask
 * `useReducedMotion`, so without it this would be the one motion that ignores
 * the setting. The `.native` split keeps Reanimated out of the web bundle.
 */
import type { ReactNode } from "react";
import Animated, { LayoutAnimationConfig, LinearTransition, ReduceMotion } from "react-native-reanimated";

import { motion } from "./theme";

export function PanelMotion({ children }: { children: ReactNode }) {
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View layout={LinearTransition.duration(motion.standard).reduceMotion(ReduceMotion.System)}>{children}</Animated.View>
    </LayoutAnimationConfig>
  );
}
