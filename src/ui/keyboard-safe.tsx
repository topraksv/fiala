/**
 * One keyboard contract for every form surface. Native follows the
 * keyboard with react-native-keyboard-controller (the `.native` sibling, which
 * keeps its Reanimated worklets out of the web bundle). A mobile browser has
 * no keyboard event, so here the focused input is brought back into the
 * visual viewport after the browser has made room for the keyboard.
 */

import { useEffect, type ReactNode, type Ref } from "react";
import { ScrollView, type ScrollViewProps } from "react-native";
import { isReducedMotion } from "./motion";
import { isMobileViewportWidth } from "./responsive";

export interface KeyboardSafeScrollViewProps extends ScrollViewProps {
  ref?: Ref<ScrollView>;
  /** Air above the native keyboard, measured from the caret. */
  bottomOffset: number;
  /** Extra scrollable room below the form. */
  extraKeyboardSpace: number;
}

export function KeyboardSafeScrollView({ bottomOffset: _bottomOffset, extraKeyboardSpace: _extraKeyboardSpace, ...props }: KeyboardSafeScrollViewProps) {
  return <ScrollView {...props} />;
}

/** Mobile browsers resize the visual viewport after focus; the second pass lands the field once it has. */
const SETTLE_MS = 220;
const VIEWPORT_DEBOUNCE_MS = 80;

function editableElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.matches('input:not([type="hidden"]), textarea, [contenteditable="true"]') ? target : null;
}

function MobileWebKeyboardFocus() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    // A desktop keyboard never shrinks the visual viewport. Coarse pointers
    // cover phones and tablets; the width covers emulation, which does not
    // report pointer capability faithfully.
    const isMobileViewport = () => window.matchMedia("(pointer: coarse)").matches || isMobileViewportWidth(window.innerWidth);
    let frame: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let viewportTimer: ReturnType<typeof setTimeout> | null = null;
    const reveal = (focused: HTMLElement | null) => {
      frame = null;
      if (!isMobileViewport()) return;
      // RN Web may hand DOM focus back to its responder root right after an
      // input's focus event, so the element the person tapped is kept rather
      // than asking `document.activeElement` a frame later.
      const target = focused?.isConnected ? focused : editableElement(document.activeElement);
      target?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: isReducedMotion() ? "auto" : "smooth",
      });
    };
    const scheduleReveal = (event?: FocusEvent) => {
      const focused = editableElement(event?.target ?? null) ?? editableElement(document.activeElement);
      if (!focused) return;
      if (frame != null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => reveal(focused));
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => reveal(focused), SETTLE_MS);
    };
    const onViewportResize = () => {
      if (viewportTimer) clearTimeout(viewportTimer);
      viewportTimer = setTimeout(scheduleReveal, VIEWPORT_DEBOUNCE_MS);
    };
    // RN Web delegates focus at the bubble phase and may stop it; capture sees the input first.
    document.addEventListener("focusin", scheduleReveal, true);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    return () => {
      document.removeEventListener("focusin", scheduleReveal, true);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      if (frame != null) cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
      if (viewportTimer) clearTimeout(viewportTimer);
    };
  }, []);
  return null;
}

/** Mounted once, above the router and the dialogs. Metro resolves this file for the web only. */
export function KeyboardSafeRoot({ children }: { children: ReactNode }) {
  return (
    <>
      <MobileWebKeyboardFocus />
      {children}
    </>
  );
}
