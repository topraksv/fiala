/**
 * The app lock (`docs/TASKS.md` F1.30), Helix's `useBiometricLock` and
 * `useNavigationAcrossLock` (`src/ui/root-lifecycle.ts` there): a phone signed
 * in with the lock on opens behind the device's own face, finger or passcode
 * check, and locks again each time it goes to the background. The web has no
 * such check, so it never locks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useNavigationContainerRef } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";

import { tr } from "../i18n/tr";
import { kv } from "../services/kv";

/** On this device only, as in Helix: the lock is how one phone is held, not the account. */
export const LOCK_KEY = "fiala.lock";

/**
 * How long a resumed app settles before the authentication sheet is presented:
 * the app-switcher cover is dismissed on the same resume, and presenting into
 * that dismissal is how a prompt goes missing while its promise stays pending.
 */
const PROMPT_SETTLE_MS = 400;

/**
 * How long an unanswered prompt is given after a resume before it is written
 * off. Generous on purpose: too short interrupts a prompt that was answered
 * and asks a second time — the passcode fallback settles as its screen
 * dismisses, the same moment the resume arrives.
 */
const PROMPT_RECOVERY_MS = 2_500;

/**
 * Whether the OS has a window to present a system prompt into. `inactive` is
 * also iOS's state while its own sheet is up, so refusing there keeps one
 * prompt off another; `unknown`, Android's before its first event, passes.
 */
function canPresentPrompt(): boolean {
  const state = AppState.currentState;
  return state !== "background" && state !== "inactive";
}

/** Prompt only from the foreground: a backgrounded iOS prompt may never settle, and an identity (not a flag) lets an abandoned prompt be replaced. */
export function useAppLock(ready: boolean, userId: string | null) {
  const [locked, setLocked] = useState<boolean | null>(null);
  /** Read by the once-registered AppState listener, so written with the state, not in an effect. */
  const lockedRef = useRef<boolean | null>(null);
  const prompt = useRef<number | null>(null);
  const promptSeq = useRef(0);
  /** Last preference read: the SecureStore read on leaving can reject under iOS file protection. */
  const preference = useRef<boolean | null>(null);

  const applyLocked = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);

  /**
   * Whether to lock; always resolves, since a null `locked` is a blank app. On
   * failure keep the last value, else lock — safe ONLY because the prompt
   * keeps the passcode fallback. Reads and returns, setting nothing, so an
   * effect may call it; signed out is never locked, which is read below.
   */
  const readLock = useCallback(async () => {
    try {
      const enabled = (await kv.get(LOCK_KEY)) === "true";
      preference.current = enabled;
      return enabled && Platform.OS !== "web";
    } catch {
      return lockedRef.current ?? Platform.OS !== "web";
    }
  }, []);

  useEffect(() => {
    if (!ready || !userId) return;
    void readLock().then(applyLocked);
  }, [ready, userId, readLock, applyLocked]);

  /** True when the person passed; asks and answers, setting nothing, for the same reason as `readLock`. */
  const ask = useCallback(async () => {
    if (prompt.current !== null) return false;
    // A prompt asked of a backgrounded app may never settle; the resume handler asks instead.
    if (!canPresentPrompt()) return false;
    const id = (promptSeq.current += 1);
    prompt.current = id;
    // Face first, passcode as fallback. Never biometrics-only: a lock on one's own data needs a second key.
    // A failure leaves the button: the next tap asks again.
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: tr.lock.prompt }).catch(() => null);
    // An abandoned prompt does not get to speak: its late "success" would open the app under a sheet still on screen.
    if (prompt.current !== id) return false;
    prompt.current = null;
    return result?.success === true;
  }, []);
  const unlock = useCallback(() => ask().then((passed) => passed && applyLocked(false)), [ask, applyLocked]);

  useEffect(() => {
    if (Platform.OS === "web" || !userId) return;
    let resume: ReturnType<typeof setTimeout> | null = null;
    const cancelResume = () => {
      if (resume !== null) clearTimeout(resume);
      resume = null;
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Also the retry of a read that failed at launch.
        if (lockedRef.current === null) {
          void readLock().then(applyLocked);
          return;
        }
        if (lockedRef.current === false) return;
        cancelResume();
        // A prompt still unanswered here was never presented, and needs the longer margin.
        const delay = prompt.current === null ? PROMPT_SETTLE_MS : PROMPT_RECOVERY_MS;
        resume = setTimeout(() => {
          resume = null;
          if (!canPresentPrompt() || lockedRef.current !== true) return;
          // Anything unanswered in a foregrounded app was never presented: drop it, so the guard cannot outlive it.
          prompt.current = null;
          void unlock();
        }, delay);
        return;
      }
      if (state !== "background") return;
      cancelResume();
      const prompting = prompt.current !== null;
      void kv
        .get(LOCK_KEY)
        .then((value) => {
          preference.current = value === "true";
        })
        .catch(() => {})
        .finally(() => {
          // The authentication sheet backgrounds the app itself (iOS passcode,
          // Android device credentials): locking then would answer a successful
          // unlock by asking again.
          if (preference.current === true && !prompting) applyLocked(true);
        });
    });
    return () => {
      cancelResume();
      subscription.remove();
    };
  }, [userId, readLock, unlock, applyLocked]);

  useEffect(() => {
    if (locked === true) void unlock();
  }, [locked, unlock]);

  return { locked: userId ? locked : false, unlock };
}

/**
 * Restore the stack after unlock: the lock screen replaces the navigator
 * (native sheets would sit above a drawn cover), and a remount forgets the
 * stack. Mounted before the reminder taps, so a tapped reminder lands on top
 * of the restored stack.
 */
export function useNavigationAcrossLock(locked: boolean | null, navigatorShown: boolean, userId: string | null): void {
  const navigation = useNavigationContainerRef();
  type RootState = NonNullable<ReturnType<typeof navigation.getRootState>>;
  const last = useRef<RootState | null>(null);
  const parked = useRef<RootState | null>(null);

  useEffect(
    () =>
      navigation.addListener("state", (event) => {
        // The unmount itself reports no state; that is the moment to remember.
        if (event.data.state) last.current = event.data.state as RootState;
      }),
    [navigation],
  );

  useEffect(() => {
    last.current = null;
    parked.current = null;
  }, [userId]);

  useEffect(() => {
    if (locked === true && last.current) parked.current = last.current;
  }, [locked]);

  useEffect(() => {
    if (locked !== false || !navigatorShown || !parked.current || !navigation.isReady()) return;
    const root = navigation.getRootState();
    const state = parked.current;
    parked.current = null;
    // SDK 58's container ref has no `resetRoot`; a reset keyed to the root navigator replaces its whole tree.
    if (root) navigation.reset({ ...state, key: root.key });
  }, [locked, navigatorShown, navigation]);
}

/**
 * The name of the device's own lock, asked of the hardware (Helix's
 * `biometricName`): pure, so the rule is what a test holds.
 */
export function lockName({ ios, facial, fingerprint }: { ios: boolean; facial: boolean; fingerprint: boolean }): string {
  if (ios) {
    if (facial) return tr.lock.faceId;
    if (fingerprint) return tr.lock.touchId;
    return tr.lock.name;
  }
  if (facial && !fingerprint) return tr.lock.face;
  if (fingerprint) return tr.lock.fingerprint;
  // Neither enrolled, or a sensor this app has no word for: the neutral name is right on every device.
  return tr.lock.name;
}
