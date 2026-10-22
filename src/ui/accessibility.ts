/** Focus behavior for modal surfaces. */

import { useEffect, useRef, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Platform, type View } from "react-native";

function moveAccessibilityFocus(target: View | null): void {
  if (!target) return;
  if (Platform.OS === "web") {
    (target as unknown as { focus?: () => void }).focus?.();
    return;
  }
  const handle = findNodeHandle(target);
  if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="checkbox"], [role="option"], [role="radio"], [role="slider"], [role="spinbutton"], [role="switch"], [role="tab"]'),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.getClientRects().length > 0,
  );
}

/**
 * Moves focus to a modal's heading when it opens, keeps Tab inside it on the
 * web, and gives focus back to what had it when it closes. `focusHeading` is
 * false for a prompt, whose field takes focus itself.
 */
export function useModalAccessibility(open: boolean, focusKey?: unknown, focusHeading = true): RefObject<View | null> {
  const titleRef = useRef<View>(null);

  useEffect(() => {
    if (!open) return;
    const web = Platform.OS === "web" && typeof document !== "undefined";
    const previous = web ? (document.activeElement as HTMLElement | null) : null;
    const modal = web ? (titleRef.current as unknown as HTMLElement | null)?.closest<HTMLElement>('[aria-modal="true"]') ?? null : null;
    // The web modal exists by the time this runs; a delayed focus would let the
    // browser's own autofocus win and then steal focus back from a quick Tab.
    if (focusHeading && web) moveAccessibilityFocus(titleRef.current);
    const timer = focusHeading && !web ? setTimeout(() => moveAccessibilityFocus(titleRef.current), 40) : undefined;
    const trapFocus = web
      ? (event: KeyboardEvent) => {
          if (event.key !== "Tab" || !modal) return;
          if (Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) !== modal) return;
          const focusable = focusableElements(modal);
          const active = document.activeElement as HTMLElement | null;
          const index = active ? focusable.indexOf(active) : -1;
          const leaving = index === focusable.length - 1 || (index === 0 && event.shiftKey);
          const outside = !active || !modal.contains(active) || active === (titleRef.current as unknown as HTMLElement);
          if (!leaving && !outside) return;
          event.preventDefault();
          (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
        }
      : null;
    if (trapFocus) document.addEventListener("keydown", trapFocus, true);
    return () => {
      if (timer != null) clearTimeout(timer);
      if (trapFocus) document.removeEventListener("keydown", trapFocus, true);
      setTimeout(() => {
        // Focus a person already moved elsewhere in the same tick stays where they put it.
        const active = web ? (document.activeElement as HTMLElement | null) : null;
        const moved = active != null && active !== document.body && active !== document.documentElement && !modal?.contains(active);
        if (!moved) previous?.focus?.();
      }, 0);
    };
  }, [open, focusKey, focusHeading]);

  return titleRef;
}
