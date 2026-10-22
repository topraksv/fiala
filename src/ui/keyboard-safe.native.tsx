/** Native half of the keyboard contract; web deliberately resolves keyboard-safe.tsx. */

import type { ReactNode, Ref } from "react";
import { KeyboardAwareScrollView, KeyboardProvider, type KeyboardAwareScrollViewRef } from "react-native-keyboard-controller";
import type { KeyboardSafeScrollViewProps } from "./keyboard-safe";

/**
 * The controller follows the keyboard frame and the focused input, rather
 * than every form keeping its own KeyboardAvoidingView inset — which Android's
 * edge-to-edge layout no longer resizes for.
 */
export function KeyboardSafeScrollView({ ref, ...props }: KeyboardSafeScrollViewProps) {
  // The focused field stays where the person was reading after the keyboard
  // closes; snapping the whole form back down is disorienting. The ref is
  // `ScrollView`'s, which `Screen` also gives `useScrollToTop`: the
  // controller's is a ScrollView with one method more, and only TypeScript's
  // invariance on a mutable ref refuses it.
  return <KeyboardAwareScrollView ref={ref as Ref<KeyboardAwareScrollViewRef>} disableScrollOnKeyboardHide {...props} />;
}

/** Preloading can flash a keyboard on cold launch, so focus remains on demand. */
export function KeyboardSafeRoot({ children }: { children: ReactNode }) {
  return <KeyboardProvider preload={false}>{children}</KeyboardProvider>;
}
