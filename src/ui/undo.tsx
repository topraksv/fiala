/**
 * The undo bar: it takes back what just happened, and
 * without an action it confirms what has nothing to take back.
 */

import { useEffect, useState } from "react";
import { Animated, Platform, StyleSheet, Text, View } from "react-native";
import Check from "lucide-react-native/icons/check";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { tr } from "../i18n/tr";
import { SlideUp, SuccessPop, announce } from "./components";
import { appError } from "./dialog";
import { selectionTap } from "./haptics";
import { useDragAway } from "./motion";
import { alpha, controlSize, font, iconStroke, motion, navigationInset, radius, spacing, stateOpacity, themeShadow, type, undoBar, useTheme } from "./theme";
import { Press } from "./press";

interface UndoOffer {
  message: string;
  onUndo: (() => Promise<unknown>) | null;
  /** `warning` once an undo has failed and the bar is offering it again. */
  tone: "success" | "warning";
}

const useUndo = create<{ offer: UndoOffer | null }>(() => ({ offer: null }));

let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Also at an account change: an offer to undo the last account's delete must not reach the next one. */
export function clearUndo(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  useUndo.setState({ offer: null });
}

/**
 * Offer to take back what just happened. The caller plays the event's own
 * haptic; the bar plays none, or a delete would be felt twice.
 */
function showUndo(message: string, onUndo: () => Promise<unknown>, tone: UndoOffer["tone"] = "success"): void {
  present({ message, onUndo, tone });
}

export function showNotice(message: string): void {
  present({ message, onUndo: null, tone: "success" });
}

function present(offer: UndoOffer): void {
  if (hideTimer) clearTimeout(hideTimer);
  useUndo.setState({ offer });
  announce(offer.message);
  // Two holds: a bare confirmation leaves quickly, an offer stays long enough to be taken.
  hideTimer = setTimeout(clearUndo, offer.onUndo ? motion.undoHold : motion.noticeHold);
}

/**
 * The drag that pushes the bar out of the way. Measured against the bar's own
 * height, about 64 points: half of it is unmistakably a drag and still in
 * reach of one thumb.
 */
const DISMISS_DISTANCE = 32;
/** Far enough below its place to be gone behind the edge. */
const DISMISS_TRAVEL = 140;

export function UndoSnackbar() {
  const { palette } = useTheme();
  const offer = useUndo((s) => s.offer);
  const insets = useSafeAreaInsets();
  const [undoing, setUndoing] = useState(false);
  const { dragY, panHandlers } = useDragAway(DISMISS_DISTANCE, DISMISS_TRAVEL, clearUndo);
  // A new confirmation arrives at rest, however the last one was pushed away.
  useEffect(() => {
    dragY.setValue(0);
  }, [dragY, offer]);

  if (!offer) return null;
  const { message, onUndo, tone } = offer;
  const nav = navigationInset({ bottomInset: insets.bottom, isWeb: Platform.OS === "web" });

  const undo = async () => {
    if (undoing || !onUndo) return;
    selectionTap();
    setUndoing(true);
    try {
      await onUndo();
      clearUndo();
    } catch {
      // A failed restore must never look like a successful one: the bar comes
      // back for another try, and the dialog says what happened.
      showUndo(message, onUndo, "warning");
      void appError(tr.errors.undoFailed);
    }
    setUndoing(false);
  };

  return (
    <View
      pointerEvents="box-none"
      // It floats over the tab bar's clearance, not a hard-coded offset that drifts when the bar changes.
      style={{ position: "absolute", left: spacing.lg, right: spacing.lg, bottom: nav.bottom + spacing.md, alignItems: "center" }}
    >
      {/* Keyed on the message: a second confirmation re-enters, and its mark
          pops again, because it is a different event. */}
      <SlideUp key={message} distance={motion.travel.bar}>
        {/* Announced, because for a delete this is the only confirmation.
            Polite: it reports what the person just did and must not interrupt. */}
        <Animated.View
          {...panHandlers}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={{
            transform: [{ translateY: dragY }],
            opacity: dragY.interpolate({ inputRange: [0, DISMISS_TRAVEL], outputRange: [1, 0], extrapolate: "clamp" }),
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            backgroundColor: palette.text,
            borderRadius: radius.md,
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.lg,
            ...themeShadow.overlay(palette),
          }}
        >
          <View
            accessible={false}
            style={{
              width: undoBar.mark,
              height: undoBar.mark,
              flexShrink: 0,
              borderRadius: radius.md,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: palette.background + alpha.edge,
              backgroundColor: palette.background + alpha.inverseTint,
            }}
          >
            <SuccessPop>
              {tone === "warning" ? (
                <TriangleAlert size={undoBar.actionIcon} color={palette.background} />
              ) : (
                <Check size={undoBar.markIcon} color={palette.background} strokeWidth={iconStroke.mark} />
              )}
            </SuccessPop>
          </View>
          <Text style={[type.body, { color: palette.background, flexShrink: 1, minWidth: 0 }]}>{message}</Text>
          {onUndo ? <Press
            accessibilityRole="button"
            accessibilityState={{ busy: undoing, disabled: undoing }}
            disabled={undoing}
            onPress={undo}
            // Opacity, not `interactionSurface`: the bar is inverted, and the
            // shared fill mixes its tint for a surface the right way up.
            style={({ pressed }) => ({
              minHeight: controlSize.minimumTarget,
              justifyContent: "center",
              paddingHorizontal: spacing.sm,
              marginHorizontal: -spacing.sm,
              borderRadius: radius.sm,
              opacity: pressed ? stateOpacity.pressed : 1,
            })}
          >
            {/* On the inverted bar an accent would all but vanish, so the
                action shares the message's ink and stands apart by weight. */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <RotateCcw accessible={false} size={undoBar.actionIcon} color={palette.background} />
              <Text style={[type.body, { color: palette.background, fontFamily: font.semibold }]}>{tr.common.undo}</Text>
            </View>
          </Press> : null}
        </Animated.View>
      </SlideUp>
    </View>
  );
}
