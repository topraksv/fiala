/**
 * One guard for every form that can lose a draft it
 * holds in memory, and one question before it does. A route asks on its back
 * control, the iOS edge swipe and a web reload; a panel asks on its scrim, its
 * handle and its Vazgeç.
 */

import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useIsFocused, useNavigation } from "expo-router";
// `usePreventRemove` has no root export yet.
import { usePreventRemove } from "expo-router/react-navigation";

import { tr } from "../i18n/tr";
import { appConfirm } from "./dialog";
import { registerDirtyExitFallback } from "./navigation";

let confirming = false;

/** Runs `action` at once on a clean draft, and after "Değişiklikleri sil" on a dirty one. */
export function confirmDiscard(dirty: boolean, action: () => void): void {
  if (!dirty) return action();
  // A second back press while the question is up asks nothing twice.
  if (confirming) return;
  confirming = true;
  void appConfirm(tr.forms.discardTitle, tr.forms.discardBody, tr.forms.discardAction)
    .then((discard) => discard && action())
    .finally(() => {
      confirming = false;
    });
}

/** A route's guard. `allowExit` runs an action after a save without asking. */
export function useDirtyExitGuard(dirty: boolean): { allowExit: (action: () => void) => void } {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const dirtyRef = useRef(dirty);
  const [exitAllowed, setExitAllowed] = useState(false);
  const exitAllowedRef = useRef(exitAllowed);
  const pendingExitRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    dirtyRef.current = dirty;
    exitAllowedRef.current = exitAllowed;
  });
  const blocking = () => dirtyRef.current && !exitAllowedRef.current;

  const permitExit = (action: () => void) => {
    pendingExitRef.current = action;
    setExitAllowed(true);
  };

  // The prevented action itself is dispatched again, so an unrelated
  // navigation in between is still guarded.
  usePreventRemove(dirty && !exitAllowed, ({ data }) => confirmDiscard(true, () => navigation.dispatch(data.action)));

  useEffect(() => {
    if (!exitAllowed) return;
    const action = pendingExitRef.current;
    pendingExitRef.current = null;
    action?.();
    const timer = setTimeout(() => setExitAllowed(false), 0);
    return () => clearTimeout(timer);
  }, [exitAllowed]);

  // On iOS the prevented swipe slides the screen away and
  // back before asking, which reads as the draft lost and then found. A dirty
  // form offers no swipe; its back control asks before anything moves.
  useEffect(() => {
    if (Platform.OS === "web") return;
    navigation.setOptions({ gestureEnabled: !dirty || exitAllowed });
  }, [navigation, dirty, exitAllowed]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!blocking()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // A direct link has no stack action to prevent, so the back control asks here.
  useEffect(() => {
    if (!focused) return;
    return registerDirtyExitFallback((action) => {
      if (!blocking()) return false;
      confirmDiscard(true, () => permitExit(action));
      return true;
    });
  }, [focused]);

  return { allowExit: permitExit };
}
