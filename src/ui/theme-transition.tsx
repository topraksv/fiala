/**
 * A theme change that does not read as a reload. View Transitions cross-fade the real pixels; elsewhere the
 * PREVIOUS background fades over the new theme, armed before the change commits so the first frame is veiled.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, type ViewStyle } from "react-native";
import { kv } from "../services/kv";
import { useReducedMotion } from "./motion";
import { APPEARANCE_KEYS, motion, useTheme, type PaletteId, type ThemePreference } from "./theme";

type ViewTransitionStarter = { startViewTransition: (callback: () => void) => unknown };

let pendingBackground: string | null = null;

/** The document, where the browser can cross-fade a change itself. */
function viewTransitionDocument(): ViewTransitionStarter | null {
  const doc = typeof document === "undefined" ? null : (document as unknown as Partial<ViewTransitionStarter>);
  return typeof doc?.startViewTransition === "function" ? (doc as ViewTransitionStarter) : null;
}

export interface Appearance {
  theme: ThemePreference;
  palette: PaletteId;
}

const appearanceListeners = new Set<(next: Partial<Appearance>) => void>();

export function subscribeAppearance(listener: (next: Partial<Appearance>) => void): () => void {
  appearanceListeners.add(listener);
  return () => void appearanceListeners.delete(listener);
}

/** The settings screen's one door into the theme. `fromBackground` is what the veil fades out of. */
export function setAppearance(next: Partial<Appearance>, fromBackground: string) {
  // A write the keychain refuses still leaves the choice applied for this run.
  if (next.theme) kv.set(APPEARANCE_KEYS.theme, next.theme).catch(() => {});
  if (next.palette) kv.set(APPEARANCE_KEYS.palette, next.palette).catch(() => {});
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    for (const listener of appearanceListeners) listener(next);
  };
  const doc = viewTransitionDocument();
  pendingBackground = doc ? null : fromBackground;
  if (!doc) return commit();
  try {
    // React 19 flushes a click synchronously, so the commit lands before the "after" snapshot.
    // `flushSync` through a dynamic import never resolved in the Metro web bundle.
    doc.startViewTransition(commit);
  } catch {
    // A backgrounded document can refuse a transition; the preference still applies.
    commit();
  }
}

/** Light enough to keep the interface legible through the change. */
const VEIL_STRENGTH = 0.42;

// A layout effect, or the new theme paints un-veiled for one frame. Chosen at
// module scope so hook order never changes and a static web render never calls it.
const useThemeChangeEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Rendered last in the root, so the palette being left covers everything while it fades. */
export function ThemeDissolve() {
  // Out of the React Compiler: this reads `pendingBackground`, armed outside React, and compiled the
  // veil's style was cached on hook inputs alone, so the native fade froze at full strength.
  "use no memo";
  const { palette, scheme, paletteId, preference } = useTheme();
  const reducedMotion = useReducedMotion();
  const identity = `${paletteId}|${scheme}`;
  const previous = useRef(identity);
  const previousBackground = useRef(palette.background);
  const browserCrossFades = viewTransitionDocument() != null;
  const [progress] = useState(() => new Animated.Value(0));
  const [from, setFrom] = useState<string | null>(null);
  const [webFade, setWebFade] = useState<"visible" | "fading">("fading");
  const prepared = pendingBackground;
  const veil = from ?? prepared;

  // Keyed on `preference` too: a choice that resolves to the scheme already
  // showing still armed the veil, and only this effect disarms it.
  useThemeChangeEffect(() => {
    const before = previous.current;
    const background = pendingBackground ?? previousBackground.current;
    pendingBackground = null;
    previous.current = identity;
    previousBackground.current = palette.background;
    if (before === identity || reducedMotion || browserCrossFades) {
      setFrom(null);
      setWebFade("fading");
      return;
    }
    setFrom(background);
    // RN Web's JS-driven Animated repaints a full-screen opacity every frame and
    // hitches against the theme repaint; mount the veil once and let CSS fade it.
    if (Platform.OS === "web") {
      setWebFade("visible");
      const frame = window.requestAnimationFrame(() => setWebFade("fading"));
      const timer = window.setTimeout(() => setFrom(null), motion.theme + motion.fadeTail);
      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(timer);
        setFrom(null);
      };
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.theme,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setFrom(null);
    });
    return () => {
      animation.stop();
      setFrom(null);
    };
  }, [identity, preference, palette.background, progress, reducedMotion, browserCrossFades]);

  if (!veil) return null;
  return (
    <Animated.View
      pointerEvents="none"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: veil },
        Platform.OS === "web"
          ? ({
              opacity: webFade === "visible" || Boolean(prepared) ? VEIL_STRENGTH : 0,
              transitionProperty: "opacity",
              transitionDuration: `${motion.theme}ms`,
              transitionTimingFunction: motion.webEase,
              willChange: "opacity",
            } as unknown as ViewStyle)
          : { opacity: prepared ? VEIL_STRENGTH : progress.interpolate({ inputRange: [0, 1], outputRange: [VEIL_STRENGTH, 0] }) },
      ]}
    />
  );
}
