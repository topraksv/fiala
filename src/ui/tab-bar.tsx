/**
 * The floating tab bar: one bounded bar along the
 * bottom at every width, a translucent material that Reduce Transparency makes
 * opaque, a selection that travels as one shape rather than five that light
 * in turn, a horizontal scrub across the bar, and labels that drop when the
 * user's text size no longer fits them.
 *
 * The press and the scrub reproduce the navigator's own `tabPress` contract,
 * so a listener can still cancel navigation — and that listener carries the
 * selection haptic, once per crossing.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Keyboard,
  PanResponder,
  Platform,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
  type TextInstance,
  type ViewInstance,
} from "react-native";
import type { BottomTabBarProps } from "expo-router/js-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { springTo, useReducedMotion, useReduceTransparency, useSpringTo } from "./motion";
import { shouldUseCompactNavigationMaterial, tabLabelsFit, tooWide } from "./responsive";
import { placeTabs, onLanding } from "./tab-landing";
import { alpha, font, maxFontScale, motion, NAV_GLASS, navigationMaterial, radius, stateOpacity, TAB_BAR, tabBarBottomOffset, tabBarHeight, themeShadow, type, useTheme } from "./theme";
import { Press } from "./press";

/** A tap slides a little; a scrub is a distance nobody crosses by accident. */
const DRAG_CLAIM_DISTANCE = 24;
/** And clearly horizontal, so a diagonal flick towards the bar is still a scroll. */
const DRAG_HORIZONTAL_BIAS = 1.5;

/**
 * The width a label's glyphs need, and whether they wrapped. Measured over the
 * text content: an RN Web Text is a block box the column has already sized.
 */
function measureLabelText(node: HTMLElement | null): { width: number; wrapped: boolean } {
  if (!node || typeof document === "undefined" || typeof document.createRange !== "function") {
    return { width: 0, wrapped: false };
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    let width = 0;
    for (let i = 0; i < rects.length; i += 1) width = Math.max(width, rects[i]?.width ?? 0);
    return { width: Math.ceil(width), wrapped: rects.length > 1 };
  } catch {
    // Unmeasurable reads as "not measured yet", which the fit rule treats as fitting.
    return { width: 0, wrapped: false };
  }
}

/**
 * Android only: there the floating bar rides up over the keyboard, since
 * `tabBarHideOnKeyboard` is read by the navigator's own bar alone. iOS draws
 * the keyboard over it, and the web has no keyboard event.
 */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", () => setShown(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

export function TabBar({ state, descriptors, emitter, navigateToTab }: BottomTabBarProps) {
  const { palette, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const { width } = useWindowDimensions();
  const reduceTransparency = useReduceTransparency();
  const isWeb = Platform.OS === "web";
  const glass = !reduceTransparency;
  const webMaterial = isWeb
    ? ({
        backdropFilter: glass ? NAV_GLASS.blur : "none",
        WebkitBackdropFilter: glass ? NAV_GLASS.blur : "none",
      } as unknown as ViewStyle)
    : null;
  const materialFill = navigationMaterial(palette.surface, { glass, isWeb, compact: shouldUseCompactNavigationMaterial(width) });

  const barRef = useRef<ViewInstance>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [barX, setBarX] = useState(0);
  // The columns share what lies inside the outline and the padding;
  // subtracting only the padding drifts the selection 0.4pt a tab.
  const edge = TAB_BAR.border + TAB_BAR.padding;
  const measureBarX = () =>
    barRef.current?.measureInWindow((x, y, width, height) => {
      setBarX(x);
      placeTabs(state.routes.map((route) => route.name), { x, y, width, height }, edge);
    });
  const slotWidth = state.routes.length > 0 && barWidth > 0
    ? (barWidth - edge * 2) / state.routes.length
    : 0;
  const [selection] = useState(() => new Animated.Value(state.index));
  useSpringTo(selection, state.index);

  // Rebuilt only when the bar moves, never mid-scrub: a new responder would
  // drop the gesture in flight. SDK 58 hands the bar no navigator to ask, so
  // an effect keeps the current tab in a box the handlers read at event time;
  // a ref would be read the same way, but the compiler cannot tell that from
  // inside `PanResponder.create`.
  // The navigator rebuilds `navigateToTab` every render, so it rides in the box
  // too, or the responder would be rebuilt with it.
  const [live] = useState(() => {
    let current = { state, emitter, navigateToTab };
    return { get: () => current, set: (next: typeof current) => void (current = next) };
  });
  useEffect(() => live.set({ state, emitter, navigateToTab }), [live, state, emitter, navigateToTab]);
  const pan = useMemo(() => {
    const goToIndex = (index: number) => {
      const { state: { routes, index: current }, emitter: events, navigateToTab: navigate } = live.get();
      const route = routes[index];
      if (!route || index === current) return;
      const event = events.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
      if (!event.defaultPrevented) navigate(route.key);
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > DRAG_CLAIM_DISTANCE
        && Math.abs(gesture.dx) > Math.abs(gesture.dy) * DRAG_HORIZONTAL_BIAS,
      onPanResponderMove: (_event, gesture) => {
        const count = live.get().state.routes.length;
        if (slotWidth <= 0 || count === 0) return;
        const slot = Math.floor((gesture.moveX - barX - edge) / slotWidth);
        goToIndex(Math.min(Math.max(slot, 0), count - 1));
      },
    });
  }, [live, barX, edge, slotWidth]);

  // The outline gives the bar an edge on a near-black page, where the shadow
  // has nothing to fall onto.
  const material: ViewStyle = {
    backgroundColor: materialFill,
    borderWidth: TAB_BAR.border,
    borderColor: palette.border + (scheme === "dark" ? "" : alpha.edge),
    ...webMaterial,
    ...themeShadow.overlay(palette),
  };

  // Each label's latest width, remembered with the bar width it was measured
  // at, so a new bar width reads as "not measured yet". A report replaces, never
  // raises, and a dropped label stays mounted unseen: shrinking the text lowers
  // the widest and the labels come back. Keeping only a maximum and unmounting
  // the labels would leave them dropped until the bar resized.
  const [measured, setMeasured] = useState<{ barWidth: number; widths: Record<string, number> }>({ barWidth: 0, widths: {} });
  const labelWidth = measured.barWidth === barWidth ? Math.max(0, ...Object.values(measured.widths)) : 0;
  const labelsFit = tabLabelsFit(labelWidth, slotWidth);
  const reportLabel = (key: string, width: number) =>
    setMeasured((seen) => {
      const known = seen.barWidth === barWidth ? seen.widths : {};
      return known[key] === width ? seen : { barWidth, widths: { ...known, [key]: width } };
    });

  const destinations = state.routes.map((route, index) => {
    const options = descriptors[route.key]?.options ?? {};
    const focused = state.index === index;
    const color = focused ? palette.accentText : palette.textSecondary;
    const label = options.tabBarLabel ?? options.title ?? route.name;

    return (
      <Press
        key={route.key}
        accessibilityRole="tab"
        // `aria-selected`: react-native-web does not translate
        // `accessibilityState` for this role, and native maps aria-* back.
        aria-selected={focused}
        accessibilityLabel={options.tabBarAccessibilityLabel}
        onPress={() => {
          const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        }}
        style={({ pressed }) => ({
          flex: 1,
          alignSelf: "stretch",
          alignItems: "center",
          justifyContent: "center",
          gap: TAB_BAR.labelGap,
          borderRadius: radius.sm,
          opacity: pressed ? stateOpacity.pressed : 1,
        })}
      >
        <View
          accessible={false}
          style={{
            width: TAB_BAR.iconBox.width,
            height: TAB_BAR.iconBox.height,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Landing name={route.name}>{options.tabBarIcon?.({ focused, color, size: TAB_BAR.icon })}</Landing>
        </View>
        <TabLabel
          // Keyed on the bar width: a mounted native label does not re-layout
          // when only its column changed, so it would never report again.
          key={`${route.key}:${barWidth}`}
          id={route.key}
          label={typeof label === "string" ? label : route.name}
          focused={focused}
          hidden={!labelsFit}
          slotWidth={slotWidth}
          onMeasure={reportLabel}
        />
      </Press>
    );
  });

  if (keyboardShown) return null;
  return (
    // Two views: an absolute element with both `left` and `right` ignores
    // `maxWidth`, so the wrapper owns the position and the bar its width.
    <View
      pointerEvents="box-none"
      // The bar stops at its maxWidth and re-centres here without resizing, and
      // react-native-web reports layout only on a resize, so the wrapper's does.
      onLayout={measureBarX}
      style={{
        position: "absolute",
        left: TAB_BAR.sideInset,
        right: TAB_BAR.sideInset,
        bottom: tabBarBottomOffset(insets.bottom),
        alignItems: "center",
      }}
    >
      <View
        ref={barRef}
        accessibilityRole="tablist"
        onLayout={(event) => {
          setBarWidth(event.nativeEvent.layout.width);
          // The scrub reads the finger in window coordinates.
          measureBarX();
        }}
        {...pan.panHandlers}
        style={{
          width: "100%",
          maxWidth: TAB_BAR.maxWidth,
          height: tabBarHeight(isWeb),
          padding: TAB_BAR.padding,
          flexDirection: "row",
          alignItems: "center",
          borderRadius: radius.xl,
          borderCurve: "continuous",
          ...material,
        }}
      >
        {slotWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            accessible={false}
            style={{
              position: "absolute",
              top: TAB_BAR.padding,
              bottom: TAB_BAR.padding,
              left: TAB_BAR.padding,
              width: slotWidth,
              borderRadius: radius.lg,
              backgroundColor: palette.primarySoft,
              borderWidth: TAB_BAR.selection.border,
              borderColor: palette.primary,
              borderBottomWidth: TAB_BAR.selection.bottomEdge,
              transform: [{ translateX: Animated.multiply(selection, slotWidth) }],
            }}
          />
        ) : null}
        <View
          pointerEvents="none"
          accessible={false}
          style={{
            position: "absolute",
            top: TAB_BAR.highlight.top,
            left: TAB_BAR.highlight.inset,
            right: TAB_BAR.highlight.inset,
            height: TAB_BAR.highlight.thickness,
            backgroundColor: palette.textStrong + (glass ? TAB_BAR.highlight.glassAlpha : TAB_BAR.highlight.solidAlpha),
          }}
        />
        {destinations}
      </View>
    </View>
  );
}

/** A tab's icon, which bounces when something another screen sent lands on it. */
function Landing({ name, children }: { name: string; children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  useEffect(
    () =>
      onLanding((landed) => {
        if (landed !== name || reducedMotion) return;
        scale.setValue(motion.landing.bounce);
        springTo(scale, 1).start();
      }),
    [name, scale, reducedMotion],
  );
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

/**
 * One label, measured after layout and again only when its column moves.
 *
 * Native reports through `onTextLayout`. RN Web dispatches none, so web reads
 * the DOM in a layout effect — keyed on the geometry, not on every render:
 * An inline ref ran the read per render and profiled at 233ms of
 * getClientRects over three tab round trips.
 */
function TabLabel({ id, label, focused, hidden, slotWidth, onMeasure }: {
  id: string;
  label: string;
  focused: boolean;
  /** Out of the layout and unseen, still measuring, so it can come back. */
  hidden: boolean;
  slotWidth: number;
  onMeasure: (id: string, width: number) => void;
}) {
  const { palette } = useTheme();
  const ref = useRef<TextInstance>(null);
  useLayoutEffect(() => {
    const measured = measureLabelText(ref.current as unknown as HTMLElement | null);
    if (measured.width > 0) onMeasure(id, measured.wrapped ? tooWide(slotWidth) : measured.width);
  }, [id, label, slotWidth, onMeasure]);
  return (
    <Text
      ref={ref}
      aria-hidden={hidden}
      maxFontSizeMultiplier={maxFontScale.measuredBox}
      // A label that wrapped is the clearest evidence it does not fit.
      onTextLayout={(event) => {
        const lines = event.nativeEvent.lines;
        const widest = Math.max(...lines.map((line) => line.width), 0);
        onMeasure(id, lines.length > 1 ? tooWide(slotWidth) : Math.ceil(widest));
      }}
      style={{
        fontFamily: focused ? font.semibold : font.medium,
        fontSize: type.caption.fontSize,
        textAlign: "center",
        color: focused ? palette.textStrong : palette.textSecondary,
        ...(hidden ? { position: "absolute", opacity: 0 } : null),
      }}
    >
      {label}
    </Text>
  );
}
