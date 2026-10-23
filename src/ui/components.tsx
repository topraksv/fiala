/** The primitives every screen is built from: screens, cards, fields, rows, tiles, buttons and notices. */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
  type ScrollViewInstance,
  type TextInputInstance,
} from "react-native";
import { useRouter, useScrollToTop, useSegments, type Href } from "expo-router";
import Check from "lucide-react-native/icons/check";
import AlertCircle from "lucide-react-native/icons/circle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import DatabaseZap from "lucide-react-native/icons/database-zap";
import Eye from "lucide-react-native/icons/eye";
import EyeOff from "lucide-react-native/icons/eye-off";
import Minus from "lucide-react-native/icons/minus";
import type { LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tr } from "../i18n/tr";
import { pulledOnce, useSyncStatus } from "../sync/status";
import { isSupabaseConfigured } from "../sync/supabase";
import { selectionTap } from "./haptics";
import { interactionBleed, interactionSurface } from "./interaction";
import { FOCUS_BOX } from "./focus-ring";
import { webKeys } from "./keys";
import { KeyboardSafeScrollView } from "./keyboard-safe";
import { useReducedMotion, useSpringTo, useWaitBreath } from "./motion";
import { navigateBack } from "./navigation";
import { useRotatingPlaceholder } from "./placeholders";
import { shouldUseWideGutter } from "./responsive";
import { Press } from "./press";
import {
  alpha,
  borderWidth,
  circle,
  contentWidth,
  controlSize,
  density,
  dialog,
  emptyState,
  font,
  iconSize,
  iconStroke,
  maxFontScale,
  motion,
  navigationInset,
  offset,
  proseLeading,
  radius,
  sectionMark,
  spacing,
  stateOpacity,
  themeShadow,
  toggleSize,
  type,
  useTheme,
  type ContentWidth,
  type Palette,
} from "./theme";

// Outside a scope, everything mounts as an event.
const ScopePainted = createContext(true);

/**
 * A spring from 0 to 1 on mount, or 1 at once under reduced motion or when it
 * arrived with its `ArrivalScope`. It starts
 * where it will be drawn, so the first painted frame is already right: seeding
 * at rest and moving it in an effect showed one frame in the settled position.
 */
function useEntranceProgress(): Animated.Value {
  const moving = useArrivesMoving();
  const [progress] = useState(() => new Animated.Value(moving ? 0 : 1));
  useSpringTo(progress, 1);
  return progress;
}

/** Whether what mounts now is an event that moves in, rather than part of a screen arriving at rest. */
function useArrivesMoving(): boolean {
  const reducedMotion = useReducedMotion();
  const painted = useContext(ScopePainted);
  return !reducedMotion && painted;
}

/**
 * Fades in from below, so it reads as "this just happened" rather than "this
 * was always here". `distance` is one of `motion.travel`: a block arriving into
 * empty space rises, a bar or a sheet comes up from the edge it is anchored to.
 */
export function SlideUp({
  children,
  style,
  distance,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  distance: number;
}) {
  const progress = useEntranceProgress();
  return (
    <Animated.View
      style={[
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
        },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** A confirmation that lands rather than appears: a small scale pop on the entrance spring. */
export function SuccessPop({ children }: { children: ReactNode }) {
  const progress = useEntranceProgress();
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Every routed surface renders one Screen, which owns what a screen never
 * restates: the gutter, the top inset, the clearance under the floating tab
 * bar, and a centred column capped by a named width (`docs/UI.md` section 3).
 */
export function Screen({
  children,
  title,
  back,
  actions,
  width: widthName = "form",
  scrollEnabled = true,
}: {
  children?: ReactNode;
  title?: string;
  /** A pushed screen's parent, for the back control when there is no history to pop. */
  back?: Href;
  /** Controls at the title's trailing edge, or on a pushed screen the back button's. */
  actions?: ReactNode;
  width?: ContentWidth;
  /** Off while a row is dragged, or the scroll takes the vertical pan. */
  scrollEnabled?: boolean;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // A root route — a modal, sign-in — has no bar under it. Widened: typed
  // routes are generated by `expo start`, so CI types the segments differently.
  const inTabs = (useSegments() as string[])[0] === "(tabs)";
  // Pressing the tab you are on returns its screen to the top.
  const scrollRef = useRef<ScrollViewInstance>(null);
  useScrollToTop(scrollRef);
  const gutter = shouldUseWideGutter(width) ? spacing.xxl : spacing.lg;
  const bottomPad = inTabs
    ? navigationInset({ bottomInset: insets.bottom, isWeb: Platform.OS === "web" }).bottom
    : Math.max(insets.bottom, spacing.lg) + spacing.md;
  const topPad = Math.max(insets.top, spacing.lg);

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      {/* Content passes under the status bar; without a band painted over it a
          row's label runs straight through the clock. */}
      {insets.top > 0 ? (
        <View
          pointerEvents="none"
          accessible={false}
          style={[styles.statusBand, { height: insets.top, backgroundColor: palette.background }]}
        />
      ) : null}
      {/* The keyboard rises under the focused field instead of over it. Its room is the controller's;
          `bottomPad` stays the safe area's and the tab bar's. */}
      <KeyboardSafeScrollView
        ref={scrollRef}
        scrollEnabled={scrollEnabled}
        automaticallyAdjustContentInsets={false}
        bottomOffset={Math.min(dialog.keyboardGap, Math.round(height * dialog.keyboardGapShare))}
        extraKeyboardSpace={bottomPad}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        // A tap on a control while the keyboard is up lands on the first try,
        // so the quick-add field's + and a row's check need no second tap.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: gutter,
          paddingTop: topPad,
          paddingBottom: bottomPad,
          width: "100%",
          maxWidth: contentWidth[widthName],
          alignSelf: "center",
          flexGrow: 1,
        }}
      >
        {/* A pushed screen's title takes a row of its own, under the back
            button and the record's actions: beside three of them, a one-word
            list name at 360 dp had 130 px and broke mid-word. */}
        {back != null ? (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm }}>
            <BackButton fallback={back} />
            <View style={{ flexDirection: "row", gap: spacing.sm }}>{actions}</View>
          </View>
        ) : null}
        {/* No title yet — a pushed screen before its record has loaded — is
            no heading, or a screen reader announces an empty one. */}
        {/* One height whether or not the title carries controls, so the five
            tabs' titles sit on one line as the bar switches between them. */}
        {title != null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg, minHeight: controlSize.minimumTarget }}>
            <Text
              accessibilityRole="header"
              aria-level={1}
              style={[type.title, { color: palette.textStrong, flex: 1, minWidth: 0 }]}
            >
              {title}
            </Text>
            {back == null ? actions : null}
          </View>
        ) : null}
        {children}
      </KeyboardSafeScrollView>
    </View>
  );
}

/**
 * `rows`: the children are `ListRow`s, which carry the vertical
 * padding inside their own pressables, so a lit row reaches the card's top and
 * bottom edge instead of stopping short of the box it lives in.
 */
export function Card({ children, rows = false }: { children: ReactNode; rows?: boolean }) {
  const { palette } = useTheme();
  return (
    <View
      style={{
        ...cardEdge(palette),
        paddingHorizontal: density.list.cardPadding,
        paddingVertical: rows ? 0 : density.list.cardPadding,
        backgroundColor: palette.surface,
        marginBottom: spacing.md,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

/** A card heading: its mark in a soft square, a name, and a line on what the card does, over the card's own controls. */
export function PanelHeader({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description?: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.md }}>
      <View
        accessible={false}
        style={{
          width: PANEL_MARK,
          height: PANEL_MARK,
          borderRadius: radius.sm,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.primarySoft,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.primary + alpha.edge,
        }}
      >
        <Icon accessible={false} size={iconSize.control} color={palette.accentText} strokeWidth={iconStroke.regular} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" aria-level={2} style={[type.body, { color: palette.textStrong, fontFamily: font.semibold }]}>
          {title}
        </Text>
        {description ? <Text style={[type.small, { color: palette.textSecondary, marginTop: offset.tight }]}>{description}</Text> : null}
      </View>
    </View>
  );
}

/** The mark beside a card's heading. */
const PANEL_MARK = controlSize.compact;

/** A hairline between rows; `flush` inside a `rows` card, where the rows carry the air. */
export function Divider({ flush = false }: { flush?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: palette.border, marginVertical: flush ? 0 : spacing.sm }} />;
}

/**
 * A settings row: a mark, a name, one line under it, and what it does at the trailing edge — a chevron to open, a switch, a button.
 * Inside a `rows` card the pressed fill bleeds to the card's sides.
 */
const checkCircle = {
  width: controlSize.check,
  height: controlSize.check,
  borderRadius: circle(controlSize.check),
  alignItems: "center",
  justifyContent: "center",
} as const;

/** Gital's: the empty ring, or the accent circle and its tick popping in, for a row chosen in a selection. */
export function CheckMark({ checked }: { checked: boolean }) {
  const { palette } = useTheme();
  return checked ? (
    <SuccessPop>
      <View style={[checkCircle, { backgroundColor: palette.primary }]}>
        <Check accessible={false} size={iconSize.compact} color={palette.onPrimary} strokeWidth={iconStroke.mark} />
      </View>
    </SuccessPop>
  ) : (
    <View style={[checkCircle, { borderWidth: borderWidth.selected, borderColor: palette.controlBorder }]} />
  );
}

/**
 * Gital's long press, without its swipe: a long press on a phone, a
 * right-click on the web, and a screen reader's "Seç" action, so the gesture
 * is never the only way (`docs/UI.md` section 8).
 */
function rowPress(onLongPress: (() => void) | undefined): object {
  if (!onLongPress) return {};
  return {
    onLongPress,
    ...(typeof document !== "undefined" ? { onContextMenu: (event: { preventDefault: () => void }) => { event.preventDefault(); onLongPress(); } } : null),
    accessibilityActions: [{ name: "select", label: tr.selection.select }],
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => (event.nativeEvent.actionName === "select" ? onLongPress() : undefined),
  };
}

export function ListRow({
  icon: Icon,
  iconColor,
  leading,
  title,
  subtitle,
  right,
  chevron = false,
  onPress,
  onLongPress,
  selected,
}: {
  icon?: LucideIcon;
  iconColor?: string;
  /** Drawn where the icon is, for a row whose mark is not an icon: a person's. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Defined while a selection is under way: the chevron gives way to the circle that says whether this row is in it. */
  selected?: boolean;
}) {
  const { palette } = useTheme();
  const content = (
    <View style={{ paddingVertical: spacing.md - 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        {Icon ? <Icon accessible={false} size={iconSize.control} color={iconColor ?? palette.accentText} strokeWidth={iconStroke.regular} /> : leading}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.body, { color: palette.text, fontFamily: font.medium }]}>{title}</Text>
          {subtitle ? <Text style={[type.small, { color: palette.textSecondary, marginTop: offset.hair }]}>{subtitle}</Text> : null}
        </View>
        {right}
        {selected !== undefined ? (
          <CheckMark checked={selected} />
        ) : chevron ? (
          <ChevronRight accessible={false} size={iconSize.control} color={palette.textSecondary} strokeWidth={iconStroke.regular} />
        ) : null}
      </View>
    </View>
  );
  if (!onPress) return content;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={tr.common.withDetail(title, subtitle ?? "")}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...rowPress(onLongPress)}
      style={(state) => ({ ...interactionBleed(), borderRadius: radius.sm, ...interactionSurface(palette, state, { base: selected ? palette.primarySoft : undefined }) })}
    >
      {content}
    </Press>
  );
}

/** A switch in a settings row: the row names it, the switch is the control. */
export function ToggleRow({ icon, title, subtitle, value, onValueChange, disabled }: {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return <ListRow icon={icon} title={title} subtitle={subtitle} right={<Toggle label={title} value={value} onValueChange={onValueChange} disabled={disabled} />} />;
}

/**
 * The track fills with the brand as the thumb springs across, on carries a tick and off a dash so the
 * state never rests on colour alone, and the thumb is a lens with a hairline
 * and a shadow. It is only the control: the row beside it names it
 * (`ToggleRow`), and the label here is what a screen reader hears.
 */
export function Toggle({ value, onValueChange, label, disabled = false }: { value: boolean; onValueChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  const { palette } = useTheme();
  const [progress] = useState(() => new Animated.Value(value ? 1 : 0));
  useSpringTo(progress, value ? 1 : 0);
  const thumb = toggleSize.height - toggleSize.padding * 2;
  const flip = () => {
    if (disabled) return;
    selectionTap();
    onValueChange(!value);
  };
  const lit = value && !disabled;
  return (
    <Press
      accessibilityRole="switch"
      accessibilityLabel={label}
      aria-checked={value}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={flip}
      {...webKeys({ " ": flip }, { repeats: false })}
      style={({ pressed }) => ({
        minHeight: controlSize.minimumTarget,
        justifyContent: "center",
        opacity: pressed && !disabled ? stateOpacity.pressed : 1,
      })}
    >
      <View
        style={{
          width: toggleSize.width,
          height: toggleSize.height,
          borderRadius: circle(toggleSize.height),
          // Inside the border, so the thumb sits `padding` from the track's edge.
          paddingHorizontal: toggleSize.padding - borderWidth.outline,
          overflow: "hidden",
          justifyContent: "center",
          backgroundColor: palette.surfaceAlt,
          borderWidth: borderWidth.outline,
          borderColor: lit ? palette.primaryStrong : palette.controlBorder,
        }}
      >
        {/* The fill fades over a still track rather than tweening its colour,
            which keeps the spring on the native driver. */}
        {disabled ? null : <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.primary, opacity: progress }]} />}
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { paddingHorizontal: toggleSize.glyphInset, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}
        >
          <Check accessible={false} size={toggleSize.glyph} color={lit ? palette.onPrimary : "transparent"} strokeWidth={iconStroke.mark} />
          <Minus accessible={false} size={toggleSize.glyph} color={!value && !disabled ? palette.textSecondary : "transparent"} strokeWidth={iconStroke.mark} />
        </View>
        <Animated.View
          style={{
            width: thumb,
            height: thumb,
            borderRadius: circle(thumb),
            backgroundColor: disabled || !value ? palette.textSecondary : palette.onPrimary,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: palette.border,
            ...themeShadow.toggleThumb(palette),
            transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, toggleSize.width - toggleSize.height] }) }],
          }}
        />
      </View>
    </Press>
  );
}

/**
 * A field's trailing button: the whole
 * 44-point column at the right edge, so the web gets the target `hitSlop`
 * would not give it. The password's eye and the price's calculator share it.
 */
function fieldAccessoryStyle(palette: Palette, state: PressableStateCallbackType): ViewStyle {
  return {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: controlSize.minimumTarget,
    alignItems: "center",
    justifyContent: "center",
    borderTopRightRadius: radius.sm,
    borderBottomRightRadius: radius.sm,
    ...interactionSurface(palette, state),
  };
}

function PasswordEye({ hidden, onPress }: { hidden: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  const Icon = hidden ? Eye : EyeOff;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={hidden ? tr.a11y.showPassword : tr.a11y.hidePassword}
      onPress={onPress}
      style={(state) => fieldAccessoryStyle(palette, state)}
    >
      <Icon accessible={false} size={iconSize.compact} color={palette.textSecondary} strokeWidth={iconStroke.regular} />
    </Press>
  );
}

function fieldStyle(palette: Palette, { focused, invalid, secure, editable }: { focused: boolean; invalid: boolean; secure: boolean; editable: boolean }): TextStyle {
  return {
    minHeight: controlSize.regular,
    borderWidth: focused || invalid ? borderWidth.control : StyleSheet.hairlineWidth,
    borderColor: invalid ? palette.error : focused ? palette.focus : palette.controlBorder,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingRight: secure ? controlSize.minimumTarget + spacing.xs : spacing.md,
    paddingVertical: spacing.sm + offset.tight,
    color: editable ? palette.text : palette.textSecondary,
    backgroundColor: palette.surface,
    fontFamily: font.regular,
    fontSize: type.field.fontSize,
  };
}

/** What an e-mail address field asks of the keyboard and the browser's autofill. */
/**
 * A code an e-mail carries (`otp_length` in `supabase/config.toml`). Offered
 * above the keyboard: iOS reads it from Mail, and Android's autofill from the
 * notification where its service does.
 */
export const CODE_LENGTH = 6;
export const CODE_FIELD = {
  autoCapitalize: "none",
  autoCorrect: false,
  keyboardType: "number-pad",
  autoComplete: "one-time-code",
  textContentType: "oneTimeCode",
  maxLength: CODE_LENGTH,
  placeholder: "••••••",
} as const;

export const EMAIL_FIELD = {
  autoCapitalize: "none",
  autoCorrect: false,
  keyboardType: "email-address",
  autoComplete: "email",
  textContentType: "emailAddress",
  placeholder: tr.placeholders.email,
} as const;

/**
 * A field: an optional name above it, the surface fill with a hairline
 * that thickens to the focus colour, an error under it read out as it
 * appears, and an eye on a password. `examples` is the rotating
 * placeholder (`placeholders.ts`), shown while the field is empty. A caller's
 * `style` places the input. `maxLength` counts characters, as `nameFrom`
 * stores them: the input's own counts UTF-16 units, which stopped a name of
 * emoji at half its length, so it only bounds a paste at twice that.
 */
export function TextField({
  style,
  label,
  error,
  secure = false,
  examples,
  maxLength,
  onChangeText,
  ...props
}: TextInputProps & { ref?: Ref<TextInputInstance>; label?: string; error?: string | null; secure?: boolean; examples?: readonly string[] }) {
  const { palette } = useTheme();
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const wrapped = label != null || error != null || secure;
  const sample = useRotatingPlaceholder(examples ?? [], examples != null && !props.value);
  const input = (
    <TextInput
      placeholderTextColor={palette.textSecondary}
      autoCapitalize="sentences"
      {...props}
      maxLength={maxLength == null ? undefined : maxLength * 2}
      onChangeText={(text) => onChangeText?.(maxLength == null ? text : Array.from(text).slice(0, maxLength).join(""))}
      placeholder={examples ? sample : props.placeholder}
      accessibilityLabel={props.accessibilityLabel ?? label}
      secureTextEntry={secure ? hidden : props.secureTextEntry}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        props.onBlur?.(event);
      }}
      style={[fieldStyle(palette, { focused, invalid: !!error, secure, editable: props.editable !== false }), wrapped ? null : style]}
    />
  );
  if (!wrapped) return input;
  return (
    <View style={style as StyleProp<ViewStyle>}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <View>
        {input}
        {secure ? <PasswordEye hidden={hidden} onPress={() => setHidden(!hidden)} /> : null}
      </View>
      {error ? <FieldError text={error} /> : null}
    </View>
  );
}

/** A section owns both sides of itself, because it separates two groups; `flush` drops the gap above, for a header that opens a card rather than follows rows. */
export function SectionHeader({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  const { palette } = useTheme();
  return (
    <View style={{ marginTop: flush ? 0 : density.list.sectionGap, marginBottom: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <View
        accessible={false}
        style={{ width: sectionMark.width, height: sectionMark.height, borderRadius: sectionMark.radius, backgroundColor: palette.primary }}
      />
      <Text
        accessibilityRole="header"
        aria-level={2}
        style={[type.sectionTitle, { color: palette.textStrong, flex: 1, minWidth: 0 }]}
      >
        {children}
      </Text>
    </View>
  );
}

/** Under a field, once what it holds cannot be sent. */
export function FieldError({ text }: { text: string }) {
  const { palette } = useTheme();
  return <Text style={[type.small, { color: palette.errorText, marginTop: spacing.xs }]}>{text}</Text>;
}

/**
 * Said aloud on iOS, where React Native 0.86 reads no live region and maps the
 * `alert` role to no trait; Android and the web announce the region itself.
 */
export function announce(text: string): void {
  if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(text);
}

/**
 * What a form's last attempt answered: a tinted box with its mark, so an answer reads as one and
 * not as another paragraph. An error is announced at once, a success politely.
 */
export function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  const { palette } = useTheme();
  useEffect(() => announce(text), [text]);
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: palette[tone] + alpha.noticeTint, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md }}>
      <Icon accessible={false} size={iconSize.control} color={palette[tone]} />
      <Text
        accessibilityRole={tone === "error" ? "alert" : undefined}
        accessibilityLiveRegion={tone === "error" ? "assertive" : "polite"}
        style={[type.label, { color: tone === "error" ? palette.errorText : palette.successText, flex: 1 }]}
      >
        {text}
      </Text>
    </View>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: StyleProp<TextStyle> }) {
  const { palette } = useTheme();
  return (
    <Text
      style={[
        type.body,
        // Prose, and the only role given a line box — on web, where the `font`
        // shorthand would otherwise leave it at ~1.21.
        Platform.OS === "web" && { lineHeight: Math.round(type.body.fontSize * proseLeading) },
        { color: muted ? palette.textSecondary : palette.text },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** `items` in rows of `columns`, the last one short when they do not divide. */
export function rowsOf<T>(items: readonly T[], columns: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / columns) }, (_, row) => items.slice(row * columns, (row + 1) * columns));
}

/**
 * One tile, one answer. The shell will not let a caller change the box when
 * it is chosen — a thickening ring or a bolder label re-wraps the row — so
 * colour, fill and the accessible state carry the choice. Pressed again, a
 * chosen tile does nothing: no touch, and no write for its caller to make.
 */
export function ChoiceTile({
  label,
  accessibilityLabel,
  description,
  selected,
  onPress,
  disabled = false,
  children,
  layout = "stack",
  minHeight,
  basis,
  surface,
}: {
  label: string;
  /** What a screen reader hears, where the label is short for the eye: "Pzt" is "Pazartesi". */
  accessibilityLabel?: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  children?: ReactNode;
  /** `stack` puts the content over the label; `row` beside it. */
  layout?: "stack" | "row";
  minHeight: number;
  /** `flexBasis` for a wrapping grid; omit to share the row evenly. */
  basis?: `${number}%`;
  /** Draw in a palette the app is not wearing — the appearance card previews its choices. */
  surface?: Palette;
}) {
  const { palette } = useTheme();
  const p = surface ?? palette;
  const row = layout === "row";
  return (
    <Press
      {...radioChoice({ label: accessibilityLabel ?? label, selected, disabled, onPress })}
      style={(state) => ({
        flexGrow: 1,
        flexBasis: basis ?? 0,
        minWidth: 0,
        minHeight,
        padding: spacing.sm,
        gap: row ? spacing.md : spacing.xs,
        flexDirection: row ? "row" : "column",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.md,
        borderWidth: borderWidth.selected,
        borderColor: disabled ? p.controlBorder : selected ? p.primary : p.border + alpha.tileEdge,
        // Disabled is said in colour, never by fading: a refused control still explains itself.
        ...interactionSurface(p, state, {
          base: disabled ? p.surfaceAlt : selected ? p.primary + alpha.selectedTint : p.surface,
          enabled: !disabled,
        }),
      })}
    >
      {children}
      <View style={row ? { flex: 1, minWidth: 0, justifyContent: "center" } : { minWidth: 0 }}>
        <Text
          style={[
            description ? type.body : type.small,
            {
              color: selected ? p.textStrong : p.text,
              fontFamily: font.semibold,
              textAlign: row ? "left" : "center",
              flexShrink: 1,
            },
          ]}
        >
          {label}
        </Text>
        {description ? (
          <Text style={[type.small, { color: p.textSecondary, marginTop: offset.tuck, textAlign: row ? "left" : "center", flexShrink: 1 }]}>
            {description}
          </Text>
        ) : null}
      </View>
    </Press>
  );
}

/**
 * The back control. A pushed screen has no native header here, so the
 * control sits in the title row; its chevron is pulled out to the gutter, or
 * the title would start a chevron's padding to the right of every other one.
 */
function BackButton({ fallback }: { fallback: Href }) {
  const router = useRouter();
  const { palette } = useTheme();
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={tr.common.back}
      onPress={() => navigateBack(router, fallback)}
      style={(state) => ({
        width: controlSize.minimumTarget,
        height: controlSize.minimumTarget,
        marginLeft: -(controlSize.minimumTarget - iconSize.headerBack) / 2,
        borderRadius: radius.full,
        ...interactionSurface(palette, state),
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      <ChevronLeft accessible={false} size={iconSize.headerBack} color={palette.accentText} strokeWidth={iconStroke.regular} />
    </Press>
  );
}

function buttonColors(palette: Palette, variant: "primary" | "secondary" | "ghost", quiet: boolean): { background: string | undefined; foreground: string } {
  if (quiet) return { background: variant === "ghost" ? undefined : palette.surfaceAlt, foreground: palette.textSecondary };
  if (variant === "primary") return { background: palette.primary, foreground: palette.onPrimary };
  if (variant === "secondary") return { background: palette.surfaceAlt, foreground: palette.text };
  return { background: undefined, foreground: palette.accentText };
}

/**
 * `primary` for the one action a surface is for, `secondary`
 * for an action beside something else (a row's "Şimdi Güncelle"), `ghost` for
 * the way out. `loading` holds the button while its work runs.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  icon: Icon,
  size = "md",
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
  size?: "md" | "sm";
}) {
  const { palette } = useTheme();
  const small = size === "sm";
  const quiet = disabled && !loading;
  const colors = buttonColors(palette, variant, quiet);
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={(state) => ({
        ...interactionSurface(palette, state, { base: colors.background, enabled: !disabled }),
        borderRadius: radius.md,
        borderCurve: "continuous",
        paddingVertical: small ? spacing.sm : spacing.md,
        paddingHorizontal: small ? spacing.md : spacing.lg,
        // The box is the minimum target even when small: `hitSlop` does nothing on the web.
        minHeight: small ? controlSize.minimumTarget : controlSize.regular,
        flexDirection: "row",
        gap: spacing.sm,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: variant === "secondary" && !quiet ? borderWidth.control : 0,
        borderColor: palette.controlBorder,
      })}
    >
      {loading ? <ActivityIndicator accessible={false} size="small" color={colors.foreground} /> : null}
      {Icon && !loading ? (
        <Icon accessible={false} size={small ? iconSize.compact : iconSize.control} color={colors.foreground} strokeWidth={iconStroke.regular} />
      ) : null}
      <Text style={[small ? type.buttonCompact : type.button, { color: colors.foreground, textAlign: "center", flexShrink: 1 }]}>
        {label}
      </Text>
    </Press>
  );
}

/**
 * The pressable box is the 44-point minimum, the chip
 * painted inside it the compact one. Its label is required, because an icon
 * alone says nothing to a screen reader — and a record's control names the
 * record (`docs/UI.md` section 11). `text` writes words beside the icon, for a
 * row that offers several of one action, which the icon alone cannot tell apart.
 */
export function IconButton({
  icon: Icon,
  label,
  text,
  onPress,
  tone = "default",
  disabled = false,
  on,
  field = false,
}: {
  icon: LucideIcon;
  label: string;
  text?: string;
  /** Beside a text field: the chip is the field's own height, so the two line up top and bottom. */
  field?: boolean;
  onPress: () => void;
  tone?: "default" | "danger" | "primary";
  disabled?: boolean;
  /** A toggle's state: on fills the icon and the button, and a screen reader hears it pressed. */
  on?: boolean;
}) {
  const { palette } = useTheme();
  const color = disabled
    ? palette.textMuted
    : tone === "danger" ? palette.destructive : tone === "primary" || on ? palette.accentText : palette.textSecondary;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-pressed={on}
      // A phone has no `aria-pressed` (React Native 0.86 maps none): there the state is `selected`.
      accessibilityState={Platform.OS === "web" ? { disabled } : { disabled, selected: on }}
      disabled={disabled}
      onPress={onPress}
      style={{ minWidth: controlSize.minimumTarget, minHeight: controlSize.minimumTarget, alignItems: "center", justifyContent: "center" }}
    >
      {(state) => (
        <View
          {...FOCUS_BOX}
          style={{
            width: text ? undefined : field ? controlSize.regular : controlSize.compact,
            height: field ? controlSize.regular : controlSize.compact,
            paddingHorizontal: text ? spacing.md : undefined,
            flexDirection: "row",
            gap: spacing.xs,
            borderRadius: radius.sm,
            ...interactionSurface(palette, state, { base: tone === "primary" || on ? palette.primarySoft : palette.surface, enabled: !disabled }),
            alignItems: "center",
            justifyContent: "center",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: palette.border + alpha.controlEdge,
          }}
        >
          <Icon accessible={false} size={text ? iconSize.compact : iconSize.control} color={color} fill={on ? color : "none"} strokeWidth={iconStroke.regular} />
          {text ? (
            <Text maxFontSizeMultiplier={maxFontScale.measuredBox} style={[type.buttonCompact, { color }]}>
              {text}
            </Text>
          ) : null}
        </View>
      )}
    </Press>
  );
}

/**
 * What a screen shows while its reads keep failing (Gital's): the live
 * queries retry on their own; the button retries now.
 */
export function ReadFailed({ queries }: { queries: readonly { retry: () => void }[] }) {
  return (
    <EmptyState
      icon={DatabaseZap}
      title={tr.errors.readFailedTitle}
      hint={tr.errors.readFailedHint}
      action={<Button label={tr.common.retry} onPress={() => queries.forEach((query) => query.retry())} />}
    />
  );
}

/** `pulledOnce` on screen; a build with no server has nothing to wait for. */
export function usePulledOnce(): boolean {
  return useSyncStatus(pulledOnce) || !isSupabaseConfigured;
}

/**
 * The shape a tab's cards keep while a signed-in device's first pull runs,
 * where "nothing yet" would be a lie (`docs/UI.md` §7 rule 4). Nothing for 350 ms, then three
 * cards that pulse slowly, held still under Reduce Motion, since the shape is
 * the message. Scenery to a screen reader.
 */
function CardsSkeleton() {
  const { palette } = useTheme();
  const pulse = useWaitBreath(motion.skeleton.pulse, 0);
  if (!pulse) return null;
  const block = (width: number | `${number}%`, height: number, corner: number) => (
    <Animated.View
      style={{ width, height, borderRadius: corner, backgroundColor: palette.surfaceAlt, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [...motion.skeleton.opacity] }) }}
    />
  );
  return (
    <View accessible={false} aria-hidden style={{ gap: density.list.rowGap }}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ ...cardEdge(palette), flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          {block(iconSize.control, iconSize.control, radius.sm)}
          <View style={{ flex: 1, gap: spacing.xs }}>
            {block(motion.skeleton.lines[0], type.body.fontSize, radius.sm)}
            {block(motion.skeleton.lines[1], type.small.fontSize, radius.sm)}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * What a screen says when it has nothing to show, and the way out of it. It
 * grows to centre itself, so on a tall window the sentence is not left against
 * the header with the page empty beneath it; on a phone it is the padded block
 * it would have been anyway. It does not animate in: it is what a page is,
 * and a page does not replay an entrance on every visit (`docs/UI.md` §7).
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  skeleton,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: ReactNode;
  /** A tab's: until this device's first pull, the cards it waits for, not "nothing". */
  skeleton?: boolean;
}) {
  const { palette } = useTheme();
  const pulled = usePulledOnce();
  if (skeleton && !pulled) return <CardsSkeleton />;
  return (
    <View style={{ flexGrow: 1, justifyContent: "center", padding: spacing.xxl, alignItems: "center", gap: spacing.sm }}>
      <View
        style={{
          width: emptyState.disc,
          height: emptyState.disc,
          borderRadius: circle(emptyState.disc),
          backgroundColor: palette.surfaceAlt,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: spacing.xs,
        }}
      >
        <Icon accessible={false} size={emptyState.icon} color={palette.textSecondary} strokeWidth={iconStroke.quiet} />
      </View>
      <Text accessibilityRole="header" aria-level={2} style={[type.heading, { color: palette.text, textAlign: "center" }]}>
        {title}
      </Text>
      <Body muted style={{ textAlign: "center" }}>
        {hint}
      </Body>
      {action ? <View style={{ marginTop: spacing.md }}>{action}</View> : null}
    </View>
  );
}

/** The box every card draws, pressable or not, so the two cannot drift apart. */
function cardEdge(palette: Palette): ViewStyle {
  return {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border + alpha.edge,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    padding: density.list.cardPadding,
  };
}

/** A field's name above it; the price field draws it over its own box, so it is shared. */
function FieldLabel({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text style={[type.label, { color: palette.textSecondary, marginBottom: spacing.xs + offset.tight }]}>{children}</Text>;
}

/**
 * What makes a pressable one answer of a radio group: its role and state, and
 * a press that touches and answers only when it is not the answer already.
 */
function radioChoice({ label, selected, disabled = false, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return {
    accessibilityRole: "radio",
    accessibilityLabel: label,
    "aria-checked": selected,
    accessibilityState: { checked: selected, disabled },
    disabled,
    onPress: () => {
      if (selected) return;
      selectionTap();
      onPress();
    },
  } as const;
}

const styles = StyleSheet.create({
  statusBand: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 2 },
});

