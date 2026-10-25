/**
 * The cold start: the native splash's bare ground, then the mark drawing itself on
 * it, the name writing itself under it, and the app comes up from under it once it is ready and the
 * drawing is done and has rested — whichever is later, so a ready app waits
 * no longer than `brandMark.launch`. It lives as long as the root layout and leaves once, so coming
 * back from the background never replays it. Reduced motion shows the mark at
 * rest and removes the screen without a fade the moment the app is ready.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Animated, Platform, StyleSheet, type ViewStyle } from "react-native";
import * as SplashScreen from "expo-splash-screen";

import { BrandMark, preloadBrandMark } from "./brand";
import { useReducedMotion } from "./motion";
import { brandMark, motion, useTheme } from "./theme";

/**
 * The drawn mark's height: the staff is tall and narrow, so it is sized by
 * height, as Helix's helix is. The native splash is the bare ground
 * (`assets/brand/splash-blank.png`, transparent: the plugin's Android 12
 * theme names an icon drawable whether or not an image is given): a splash showing the finished mark
 * handed over to this one starting from nothing, so the owner saw the logo
 * twice. Expo Go draws it too: it shows no icon there.
 */
const MARK_HEIGHT = 150;

let launched = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

/** Whether the launch screen has left: a dialog opened before it would sit over the mark still drawing. */
export function useLaunched(): boolean {
  return useSyncExternalStore(subscribe, () => launched);
}

/** `shown` waits for the palette; `ready` is the app's first screen drawn under this one. */
export function Launch({ shown, ready }: { shown: boolean; ready: boolean }) {
  const { palette } = useTheme();
  const reducedMotion = useReducedMotion();
  const [drawn, setDrawn] = useState(false);
  const [drawable, setDrawable] = useState(false);
  const [gone, setGone] = useState(false);
  const [opacity] = useState(() => new Animated.Value(1));
  const done = ready && (drawn || reducedMotion);

  useEffect(() => {
    let live = true;
    // A rejected chunk still ends the wait: the ground alone is the splash
    // without its mark, and the app behind it is what matters.
    const show = () => live && setDrawable(true);
    preloadBrandMark().then(show, show);
    return () => {
      live = false;
    };
  }, []);

  // A frame after the commit that holds the mark, since an effect runs after
  // the commit and not after the paint: the native splash gives way to the
  // same ground with the mark already on it.
  useEffect(() => {
    if (!shown || !drawable) return;
    const frame = requestAnimationFrame(() => SplashScreen.hide());
    return () => cancelAnimationFrame(frame);
  }, [shown, drawable]);

  useEffect(() => {
    if (!shown || reducedMotion) return;
    const timer = setTimeout(() => setDrawn(true), brandMark.launch.draw + brandMark.launch.rest);
    return () => clearTimeout(timer);
  }, [shown, reducedMotion]);

  useEffect(() => {
    if (!done) return;
    // Under reduced motion this screen can unmount before the frame above
    // hides the splash; it must never outlive it, and a second hide is a no-op.
    SplashScreen.hide();
    // RN Web's JS-driven opacity repaints the whole window every frame while
    // the first screen mounts under it; CSS fades it off the main thread, as
    // the theme veil does.
    if (Platform.OS === "web" || reducedMotion) {
      const timer = setTimeout(() => setGone(true), reducedMotion ? 0 : brandMark.launch.fade + motion.fadeTail);
      return () => clearTimeout(timer);
    }
    const animation = Animated.timing(opacity, { toValue: 0, duration: brandMark.launch.fade, useNativeDriver: true });
    animation.start(({ finished }) => finished && setGone(true));
    return () => animation.stop();
  }, [done, reducedMotion, opacity]);

  useEffect(() => {
    if (!gone || launched) return;
    launched = true;
    for (const listener of listeners) listener();
  }, [gone]);

  if (!shown || gone) return null;
  const leaving = done && !reducedMotion;
  return (
    <Animated.View
      pointerEvents={leaving ? "none" : "auto"}
      style={[
        StyleSheet.absoluteFill,
        { alignItems: "center", justifyContent: "center", backgroundColor: palette.background },
        Platform.OS === "web"
          ? ({
              opacity: leaving ? 0 : 1,
              transitionProperty: "opacity",
              transitionDuration: `${brandMark.launch.fade}ms`,
              transitionTimingFunction: motion.webEase,
            } as unknown as ViewStyle)
          : { opacity },
      ]}
    >
      {drawable && <BrandMark height={MARK_HEIGHT} duration={brandMark.launch.draw} named />}
    </Animated.View>
  );
}
