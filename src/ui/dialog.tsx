/**
 * Themed alert and prompt: the one replacement for
 * `window.alert` and native `Alert.alert`, promise-based so a call site reads
 * like the blocking API it replaces:
 *
 *   await appError(message);
 *   const name = await appPrompt(title, message, { confirmLabel, initialValue });
 *
 * The hosts render inside the newest open sheet, or at the root when none is
 * open (`presenterOf`): iOS presents one modal from a controller at a time.
 * An answer settles once its modal has gone. A confirm is only for what the
 * undo bar cannot take back, which a list's delete is not.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Animated, Modal, Platform, Pressable, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { tr } from "../i18n/tr";
import { useModalAccessibility } from "./accessibility";
import { Body, Button, SlideUp, TextField } from "./components";
import { errorNotice } from "./haptics";
import { KeyboardSafeScrollView } from "./keyboard-safe";
import { PanelMotion } from "./panel-motion";
import { useDragAway, useReducedMotion } from "./motion";
import { closeRequest, emptyRequestQueue, enqueueRequest, presenterOf, type OpenModal, type RequestQueue } from "./request-queue";
import { shouldPresentOptionsAsSheet } from "./responsive";
import { circle, dialog, motion, radius, spacing, themeShadow, type, useTheme } from "./theme";

interface DialogRequest {
  /** Keys the dialog, so each one opens, and leaves, as its own modal. */
  id: number;
  title: string;
  message: string;
  /** The action a confirm asks for; an error has none and only closes. */
  confirmLabel: string | null;
  resolve: (confirmed: boolean) => void;
}

const useDialogStore = create<RequestQueue<DialogRequest>>(() => emptyRequestQueue<DialogRequest>());
let dialogId = 0;

function ask(request: Omit<DialogRequest, "id" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.setState(enqueueRequest(useDialogStore.getState(), { ...request, id: ++dialogId, resolve }));
  });
}

/** A failure, which says so on the device too. Resolves when dismissed. */
export function appError(message: string): Promise<void> {
  errorNotice();
  return ask({ title: tr.errors.title, message, confirmLabel: null }).then(() => {});
}

/** True only for the named action, never for a tap outside. */
export function appConfirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return ask({ title, message, confirmLabel });
}

interface PromptRequest {
  /** Keys the field, so each prompt opens with its own value rather than the last one's. */
  id: number;
  title: string;
  message: string;
  placeholder: string;
  /** Rotating examples (`placeholders.ts`), in place of a fixed hint. */
  examples?: readonly string[];
  confirmLabel: string;
  initialValue: string;
  maxLength: number | undefined;
  multiline: boolean | undefined;
  kind: PromptKind;
  resolve: (value: string | null) => void;
}

/** What the field holds, which decides its keyboard and what the phone may fill in. */
type PromptKind = "text" | "email" | "password" | "new-password";

const usePromptStore = create<RequestQueue<PromptRequest>>(() => emptyRequestQueue<PromptRequest>());
let promptId = 0;

/** Themed input dialog. Resolves the entered value, or `null` on cancel or a tap outside. */
export function appPrompt(
  title: string,
  message: string,
  opts: { confirmLabel: string; placeholder?: string; examples?: readonly string[]; initialValue?: string; maxLength?: number; multiline?: boolean; kind?: PromptKind },
): Promise<string | null> {
  return new Promise((resolve) => {
    const request: PromptRequest = {
      id: ++promptId,
      title,
      message,
      placeholder: opts.placeholder ?? "",
      examples: opts.examples,
      confirmLabel: opts.confirmLabel,
      initialValue: opts.initialValue ?? "",
      maxLength: opts.maxLength,
      multiline: opts.multiline,
      kind: opts.kind ?? "text",
      resolve,
    };
    usePromptStore.setState(enqueueRequest(usePromptStore.getState(), request));
  });
}

const useOpenModals = create<{ open: OpenModal[] }>(() => ({ open: [] }));
let modalId = 0;
const nextModalId = () => (modalId += 1);
/** Longer than iOS takes to fade a modal out; a modal that reported itself gone is let go at once. */
const LEAVE_MS = 500;

/**
 * Registers a modal while it is open, and returns what it must render inside
 * itself: the prompt and dialog hosts, when it is the one to present them. On
 * iOS a modal closed in React is still leaving the screen, so it is held as
 * leaving until it has, and nothing is presented beside it meanwhile.
 */
export function useModalSlot(kind: OpenModal["kind"]): { slot: ReactNode; onGone: () => void } {
  const [id] = useState(nextModalId);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    useOpenModals.setState((state) => ({ open: [...state.open, { id, kind }] }));
    return () => {
      const drop = () => useOpenModals.setState((state) => ({ open: state.open.filter((modal) => modal.id !== id) }));
      if (Platform.OS !== "ios" || gone.current) return drop();
      useOpenModals.setState((state) => ({ open: state.open.map((modal) => (modal.id === id ? { ...modal, leaving: true } : modal)) }));
      setTimeout(drop, LEAVE_MS);
    };
  }, [id, kind]);
  return { slot: <OverlaySlot at={id} />, onGone: () => (gone.current = true) };
}

/** The prompt and dialog hosts, drawn wherever `presenterOf` puts them; the root layout renders the root's. */
export function OverlaySlot({ at = null }: { at?: number | null }) {
  const holdsPrompt = useOpenModals((state) => presenterOf(state.open, "prompt") === at);
  const holdsDialog = useOpenModals((state) => presenterOf(state.open, "dialog") === at);
  return (
    <>
      {holdsPrompt ? <PromptHost /> : null}
      {holdsDialog ? <DialogHost /> : null}
    </>
  );
}

/**
 * An answer given now and settled once its modal has gone: presenting the next
 * modal, or closing the sheet under it, while this one still leaves strands it
 * on an iPhone. iOS and the web report the modal gone; Android reports nothing
 * and has no such trap, and the timer settles a modal that never presented.
 */
function useAnswer<T>(settle: (value: T) => void): { visible: boolean; answer: (value: T) => void; gone: () => void } {
  const given = useRef<{ value: T } | null>(null);
  const [visible, setVisible] = useState(true);
  const gone = () => {
    const answered = given.current;
    given.current = null;
    if (answered) settle(answered.value);
  };
  const answer = (value: T) => {
    if (given.current || !visible) return;
    given.current = { value };
    setVisible(false);
    if (Platform.OS === "android") gone();
    else setTimeout(gone, LEAVE_MS);
  };
  return { visible, answer, gone };
}

/**
 * The overlay every dialog and sheet renders, so what must not drift between
 * them is written once: the scrim that dismisses, the container Pressables
 * marked `accessible={false}` (or they swallow their children), the modal's
 * name, and the heading that takes focus.
 */
function DialogShell({
  title,
  message,
  titleRef,
  onDismiss,
  dirty,
  lead,
  action,
  kind = "sheet",
  visible = true,
  onGone,
  children,
}: {
  title: string;
  /** What it may hold above it (`presenterOf`); a prompt or a dialog is drawn by its host. */
  kind?: OpenModal["kind"];
  /** False once answered: the modal leaves, and `onGone` runs when it has. */
  visible?: boolean;
  onGone?: () => void;
  /** Beside the title: a control that acts on the whole thing the dialog is about, the item panel's star. */
  action?: ReactNode;
  message?: string;
  /** Drawn above the title: the tour's picture of the slide. */
  lead?: ReactNode;
  titleRef: RefObject<View | null>;
  onDismiss: () => void;
  /** A panel holding an unsaved draft: its `onDismiss` asks first, so a drag springs home rather than leaving. */
  dirty?: boolean;
  children: ReactNode;
}) {
  const { palette } = useTheme();
  const reducedMotion = useReducedMotion();
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const asSheet = shouldPresentOptionsAsSheet(width);
  const modal = useModalSlot(kind);
  // A sheet goes down by its handle and title, not by its body, whose own
  // fields and lists take a vertical drag first.
  const { dragY, panHandlers } = useDragAway(dialog.dragAway, height, onDismiss, dirty);
  const surface = [
    {
      backgroundColor: palette.surface,
      padding: spacing.lg,
      borderRadius: radius.lg,
      borderCurve: "continuous" as const,
    },
    themeShadow.card(palette),
  ];
  const header = (
    <View {...(asSheet ? panHandlers : {})}>
      {asSheet ? (
        // The grab handle every bottom sheet wears: pulled down, it closes the sheet.
        <View
          accessible={false}
          style={{
            alignSelf: "center",
            width: dialog.handle.width,
            height: dialog.handle.height,
            borderRadius: circle(dialog.handle.height),
            backgroundColor: palette.surfaceStrong,
            marginBottom: spacing.md,
          }}
        />
      ) : null}
      {lead}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
        <View ref={titleRef} accessible accessibilityRole="header" aria-level={2} tabIndex={-1} style={{ flex: 1 }}>
          <Text style={[type.heading, { color: palette.text }]}>{title}</Text>
        </View>
        {action}
      </View>
    </View>
  );
  const body = (
    <>
      {message ? <Body muted>{message}</Body> : null}
      {children}
    </>
  );
  const travel = asSheet ? motion.travel.sheet : motion.travel.rise;
  // A tap on the panel is the panel's, not the scrim's behind it.
  const part = (style: StyleProp<ViewStyle>, inner: ReactNode) => (
    <Animated.View style={{ transform: [{ translateY: dragY }] }}>
      <Pressable accessible={false} tabIndex={-1} onPress={() => {}}>
        <SlideUp distance={travel} style={style}>
          {inner}
        </SlideUp>
      </Pressable>
    </Animated.View>
  );
  return (
    // On the web the Modal is the element with `role="dialog"`, and takes the
    // name there; a label on a generic element inside it names nothing.
    <Modal
      aria-label={title}
      transparent
      animationType={reducedMotion ? "none" : "fade"}
      visible={visible}
      onRequestClose={onDismiss}
      onDismiss={() => {
        modal.onGone();
        onGone?.();
      }}
    >
      <Pressable
        accessible={false}
        tabIndex={-1}
        style={{ flex: 1, backgroundColor: palette.scrim, justifyContent: asSheet ? "flex-end" : "center" }}
        onPress={onDismiss}
      >
        <KeyboardSafeScrollView
          // The panel carries the dialog's name on a phone, or a screen reader
          // announces an anonymous dialog as it takes focus.
          accessibilityViewIsModal
          aria-label={title}
          // A sheet taller than the window stops short of the status bar, with
          // the page showing above it: flush with the top edge, its handle sat
          // under the notch, where a pull is the phone's own (the owner,
          // 2026-09-30). A margin rather than padding, so the handle and title,
          // held at the top as its body scrolls, stop there too.
          style={asSheet ? { marginTop: insets.top + spacing.xl } : undefined}
          contentContainerStyle={{ flexGrow: 1, ...(asSheet ? { justifyContent: "flex-end" } : { justifyContent: "center", padding: spacing.lg }) }}
          // A sheet's handle and title stay in reach however far its body is
          // scrolled: they are what pulls it away (2026-10-09).
          stickyHeaderIndices={asSheet ? [0] : undefined}
          bottomOffset={Math.min(dialog.keyboardGap, Math.round(height * dialog.keyboardGapShare))}
          extraKeyboardSpace={spacing.lg}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustContentInsets={false}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {asSheet ? (
            // Two parts of one surface, attached to the bottom edge: only the
            // top corners round, and the body's padding carries the home
            // indicator. The shadow is the body's, under the header, which
            // the sticky header is drawn above.
            [
              <View key="header" style={{ zIndex: 1 }}>
                {part(
                  {
                    backgroundColor: palette.surface,
                    padding: spacing.lg,
                    paddingBottom: dialog.seam,
                    marginBottom: -dialog.seam,
                    borderTopLeftRadius: radius.xl,
                    borderTopRightRadius: radius.xl,
                    borderCurve: "continuous",
                  },
                  header,
                )}
              </View>,
              <PanelMotion key="body">
                {part([{ backgroundColor: palette.surface, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg + insets.bottom }, themeShadow.card(palette)], body)}
              </PanelMotion>,
            ]
          ) : (
            <View style={{ alignSelf: "center", width: "100%", maxWidth: dialog.maxWidth }}>
              <PanelMotion>
                {part(surface, (
                  <>
                    {header}
                    {body}
                  </>
                ))}
              </PanelMotion>
            </View>
          )}
        </KeyboardSafeScrollView>
      </Pressable>
      {modal.slot}
    </Modal>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.lg }}>{children}</View>;
}

function PromptBody({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.initialValue);
  const titleRef = useModalAccessibility(true, request.id, false);
  const { visible, answer: onClose, gone } = useAnswer((answer: string | null) => closeRequest(usePromptStore, request, (open) => open.resolve(answer)));
  const ready = value.trim() !== "";
  return (
    <DialogShell kind="prompt" visible={visible} onGone={gone} title={request.title} message={request.message} titleRef={titleRef} onDismiss={() => onClose(null)}>
      <TextField
        value={value}
        maxLength={request.maxLength}
        onChangeText={setValue}
        accessibilityLabel={request.title}
        accessibilityHint={request.message}
        placeholder={request.placeholder}
        examples={request.examples}
        autoFocus
        // A rename opens on the whole name selected, so typing replaces it.
        selectTextOnFocus={request.initialValue !== ""}
        multiline={request.multiline}
        {...fieldFor(request.kind)}
        // Enter in a multi-line field is a new line and never submits, so
        // only the button confirms it, and the key must not promise more.
        returnKeyType={request.multiline ? "default" : "done"}
        onSubmitEditing={() => ready && onClose(value)}
        style={[{ marginTop: spacing.lg }, request.multiline && { height: dialog.multilineHeight, textAlignVertical: "top" }]}
      />
      <Actions>
        <Button label={tr.common.cancel} variant="ghost" size="sm" onPress={() => onClose(null)} />
        <Button label={request.confirmLabel} size="sm" disabled={!ready} onPress={() => onClose(value)} />
      </Actions>
    </DialogShell>
  );
}

function fieldFor(kind: PromptKind) {
  if (kind === "text") return {};
  if (kind === "email") return { autoCapitalize: "none", autoCorrect: false, autoComplete: "email", keyboardType: "email-address", textContentType: "emailAddress" } as const;
  const fresh = kind === "new-password";
  return {
    autoCapitalize: "none",
    secureTextEntry: true,
    autoComplete: fresh ? "new-password" : "current-password",
    textContentType: fresh ? "newPassword" : "password",
  } as const;
}

function PromptHost() {
  const current = usePromptStore((s) => s.current);
  return current ? <PromptBody key={current.id} request={current} /> : null;
}

function DialogHost() {
  const current = useDialogStore((s) => s.current);
  return current ? <DialogBody key={current.id} request={current} /> : null;
}

function DialogBody({ request }: { request: DialogRequest }) {
  const titleRef = useModalAccessibility(true, request.id);
  const { visible, answer: close, gone } = useAnswer((confirmed: boolean) => closeRequest(useDialogStore, request, (open) => open.resolve(confirmed)));
  return (
    <DialogShell kind="dialog" visible={visible} onGone={gone} title={request.title} message={request.message} titleRef={titleRef} onDismiss={() => close(false)}>
      <Actions>
        {request.confirmLabel ? (
          <>
            <Button label={tr.common.cancel} variant="ghost" size="sm" onPress={() => close(false)} />
            <Button label={request.confirmLabel} size="sm" onPress={() => close(true)} />
          </>
        ) : (
          <Button label={tr.common.done} size="sm" onPress={() => close(false)} />
        )}
      </Actions>
    </DialogShell>
  );
}
