/**
 * A control that shrinks while it is held (`docs/UI.md` section 5): a spring to
 * `motion.press.scale` and back, which a release interrupts midway. The state
 * a Pressable hands its style callback is tracked here instead, because the
 * scale is an Animated value and a style callback's return is not animated.
 * Half of a card — a row's text or its tick — stays a plain Pressable: shrunk,
 * it would open a gap against the card's edge.
 */

import { useState, type ReactNode } from "react";
import { Animated, Platform, Pressable, type PressableProps, type PressableStateCallbackType, type StyleProp, type ViewStyle } from "react-native";

import { isReducedMotion } from "./motion";
import { motion } from "./theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type State = PressableStateCallbackType & { hovered: boolean };

export function Press({
  style,
  children,
  onPressIn,
  onPressOut,
  onHoverIn,
  onHoverOut,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle> | ((state: State) => StyleProp<ViewStyle>);
  children?: ReactNode | ((state: State) => ReactNode);
}) {
  const [scale] = useState(() => new Animated.Value(1));
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const state: State = { pressed, hovered };
  const hold = (down: boolean) => {
    setPressed(down);
    const to = down ? motion.press.scale : 1;
    if (isReducedMotion()) scale.setValue(to);
    else Animated.spring(scale, { toValue: to, useNativeDriver: Platform.OS !== "web", ...motion.spring.press }).start();
  };
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        hold(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        hold(false);
        onPressOut?.(event);
      }}
      onHoverIn={(event) => {
        setHovered(true);
        onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        setHovered(false);
        onHoverOut?.(event);
      }}
      style={[typeof style === "function" ? style(state) : style, { transform: [{ scale }] }]}
    >
      {typeof children === "function" ? children(state) : children}
    </AnimatedPressable>
  );
}
