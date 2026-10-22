/** The app's one hover and pressed fill; a leaf module so the controls that need it do not pull in the component library. */

import { Platform, type PressableStateCallbackType, type ViewStyle } from "react-native";
import { isReducedMotion } from "./motion";
import { composite, density, INTERACTION_ALPHA, motion, spacing, type Palette } from "./theme";

// react-native-web's Pressable tracks hover and hands it to the style callback;
// React Native's types only declare `pressed`, so the read is cast once here.
function isHovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

function alphaHex(alpha: number): string {
  return Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0");
}

/**
 * A fill that is already translucent gets denser: one backgroundColor cannot
 * hold two layers, and the colour behind it is unknown here.
 */
function denser(base: string, alpha: number): string {
  const current = parseInt(base.slice(7, 9), 16) / 255;
  return `${base.slice(0, 7)}${alphaHex(current + alpha)}`;
}

type Level = keyof typeof INTERACTION_ALPHA;

/**
 * With no `base` it declares no background at all, so a fill the caller paints
 * elsewhere survives; a `base` that was given is returned at rest.
 */
function interactionFill(palette: Palette, base: string | undefined, level: Level | null): ViewStyle {
  const opaque = base != null && /^#[0-9a-f]{6}$/i.test(base);
  const translucent = base != null && /^#[0-9a-f]{8}$/i.test(base);
  if (level == null) return opaque || translucent ? { backgroundColor: base } : {};
  const alpha = INTERACTION_ALPHA[level];
  if (opaque) return { backgroundColor: composite(base, palette.textStrong, alpha) };
  if (translucent) return { backgroundColor: denser(base, alpha) };
  return { backgroundColor: `${palette.textStrong}${alphaHex(alpha)}` };
}

/**
 * Return this from a Pressable's style callback, on the Pressable itself: on a
 * narrower child the lit band stops short of the control.
 */
export function interactionSurface(
  palette: Palette,
  state: PressableStateCallbackType,
  { base, enabled = true }: { base?: string; enabled?: boolean } = {},
): ViewStyle {
  const level: Level | null = !enabled ? null : state.pressed ? "pressed" : isHovered(state) ? "hover" : null;
  const fill = interactionFill(palette, base, level);
  // Native has no pointer: the fill appears only under a finger, where a fade reads as lag.
  if (Platform.OS !== "web") return fill;
  return {
    ...fill,
    transitionProperty: "background-color",
    transitionDuration: `${isReducedMotion() ? 0 : motion.hover}ms`,
    transitionTimingFunction: motion.webEase,
  } as unknown as ViewStyle;
}

const HOVER_GUTTER = spacing.xs;

/** How far a row's fill reaches past its content; returned as padding, so only the lit area grows. Pass the container's padding when it differs. */
export function interactionBleed(inset: number = density.list.cardPadding - HOVER_GUTTER): ViewStyle {
  return { marginHorizontal: -inset, paddingHorizontal: inset };
}
