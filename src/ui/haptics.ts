/** iOS-only haptics; Android and web are no-ops. Notification feedback is for an outcome, never for the press that started it. */

import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/** An enhancement: unsupported hardware must never turn a tap into an unhandled rejection. */
function feel(play: () => Promise<void>): void {
  if (Platform.OS !== "ios") return;
  void Promise.resolve().then(play).catch(() => {});
}

export function selectionTap(): void {
  feel(() => Haptics.selectionAsync());
}

export function selectionTapIfChanged(previous: string | null | undefined, next: string): void {
  if (previous !== next) selectionTap();
}

export function mediumTap(): void {
  feel(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

export function errorNotice(): void {
  feel(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}
