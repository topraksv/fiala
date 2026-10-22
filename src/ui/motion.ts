import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing, PanResponder, Platform, type EmitterSubscription, type GestureResponderHandlers } from "react-native";
import { motion } from "./theme";

let reducedMotion = false;
let nativeSubscription: EmitterSubscription | null = null;
const listeners = new Set<() => void>();

function updateReducedMotion(next: boolean) {
  if (reducedMotion === next) return;
  reducedMotion = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void AccessibilityInfo.isReduceMotionEnabled().then(updateReducedMotion).catch(() => {});
    nativeSubscription = AccessibilityInfo.addEventListener("reduceMotionChanged", updateReducedMotion);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      nativeSubscription?.remove();
      nativeSubscription = null;
    }
  };
}

/** One shared native listener backs every animated primitive in the app. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => reducedMotion, () => false);
}

/**
 * A wait's breath: nothing before `motion.reveal`, then 0 → 1 → 0 over twice
 * `period`, held at `still` under Reduce Motion. `null` while hidden.
 */
export function useWaitBreath(period: number, still: number): Animated.Value | null {
  const reduced = useReducedMotion();
  const [breath] = useState(() => new Animated.Value(0));
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), motion.reveal);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!shown) return;
    if (reduced) return void breath.setValue(still);
    const step = (toValue: number) => Animated.timing(breath, { toValue, duration: period, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== "web" });
    const loop = Animated.loop(Animated.sequence([step(1), step(0)]));
    loop.start();
    return () => loop.stop();
  }, [shown, reduced, breath, period, still]);
  return shown ? breath : null;
}

/**
 * The same answer without subscribing, for a style a Pressable already
 * re-renders to produce: a hook there adds a subscriber per control on screen.
 */
export function isReducedMotion(): boolean {
  return reducedMotion;
}

/**
 * The spring every moving part shares, so a gesture's settle and a mount's
 * arrival feel alike. `native: false` is for geometry the native driver cannot
 * move, such as an SVG dash.
 */
export function springTo(value: Animated.Value, toValue: number, native = true): Animated.CompositeAnimation {
  return Animated.spring(value, { toValue, useNativeDriver: native && Platform.OS !== "web", ...motion.spring.entrance });
}

/** Springs `value` to `target` whenever the target moves; under reduced motion it jumps there. */
export function useSpringTo(value: Animated.Value, target: number, native = true): void {
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) {
      value.setValue(target);
      return;
    }
    const animation = springTo(value, target, native);
    animation.start();
    return () => animation.stop();
  }, [value, target, reducedMotion, native]);
}

let reduceTransparency = false;
let transparencySubscription: EmitterSubscription | null = null;
const transparencyListeners = new Set<() => void>();

function updateReduceTransparency(next: boolean) {
  if (reduceTransparency === next) return;
  reduceTransparency = next;
  for (const listener of transparencyListeners) listener();
}

function subscribeTransparency(listener: () => void) {
  transparencyListeners.add(listener);
  // react-native-web ships no transparency query, and calling it unguarded
  // throws at first render. The setting is iOS-only; absent means false.
  if (transparencyListeners.size === 1 && typeof AccessibilityInfo.isReduceTransparencyEnabled === "function") {
    void AccessibilityInfo.isReduceTransparencyEnabled().then(updateReduceTransparency).catch(() => {});
    transparencySubscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", updateReduceTransparency);
  }
  return () => {
    transparencyListeners.delete(listener);
    if (transparencyListeners.size === 0) {
      transparencySubscription?.remove();
      transparencySubscription = null;
    }
  };
}

/** iOS "Reduce Transparency". Android and web blur nothing unasked, so false is correct there. */
export function useReduceTransparency(): boolean {
  return useSyncExternalStore(subscribeTransparency, () => reduceTransparency, () => false);
}

/** A flick counts even when it barely travelled. */
const FLICK_VELOCITY = 0.6;
/** Movement before a drag claims the gesture, so a tap still reaches a control inside. */
const DRAG_CLAIM = 6;

/**
 * A surface pushed down and away: the undo bar, and a sheet by its handle.
 * Past `distance`, or on a flick, it leaves by `travel` and `onGone` runs; short
 * of it, it springs home. Downward only, since up is where it came from.
 */
/** `held`: a surface that asks before it goes (a dirty draft) springs home and asks, rather than leaving off-screen. */
export function useDragAway(distance: number, travel: number, onGone: () => void, held = false): { dragY: Animated.Value; panHandlers: GestureResponderHandlers } {
  const [dragY] = useState(() => new Animated.Value(0));
  // A new responder drops the gesture in flight, so it is rebuilt only when
  // an argument changes. A drag re-renders nothing, so a caller's inline
  // `onGone` rebuilds it between gestures, never during one.
  const { panHandlers } = useMemo(() => {
    const springHome = () => springTo(dragY, 0).start();
    return PanResponder.create({
      // Claimed on touch-down too, or a surface that is itself the responder,
      // a sheet's, is never asked on the move. A control inside still gets the
      // press, since the deepest view is asked first; its drag is taken on the move.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > DRAG_CLAIM && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => dragY.setValue(Math.max(0, gesture.dy)),
      // Held once claimed: the sheet's scroll view asks for a long move.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy <= distance && gesture.vy <= FLICK_VELOCITY) return springHome();
        if (held) {
          springHome();
          return onGone();
        }
        if (isReducedMotion()) return onGone();
        Animated.timing(dragY, { toValue: travel, duration: motion.feedback, useNativeDriver: Platform.OS !== "web" }).start(onGone);
      },
      onPanResponderTerminate: springHome,
    });
  }, [dragY, distance, travel, onGone, held]);
  return { dragY, panHandlers };
}
