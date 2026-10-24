import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, View, useColorScheme } from "react-native";
import { router, Stack } from "expo-router";
import Head from "expo-router/head";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import DatabaseZap from "lucide-react-native/icons/database-zap";
import LockKeyhole from "lucide-react-native/icons/lock-keyhole";

import { useSession } from "../auth/session";
import { takeDatabaseRebuilt } from "../db/client";
import { migrateDb } from "../db/migrate";
import { tr } from "../i18n/tr";
import { kv } from "../services/kv";
import { followReminderTaps, remindersAvailable, replanReminders } from "../services/reminders";
import { useAccountFrozen, useHouseholds } from "../data/hooks";
import { scheduleSync, syncNow } from "../sync/engine";
import { followCabinets, startLive, stopLive } from "../sync/live";
import { realtimeAccess } from "../sync/supabase";
import { heldInvite, holdInvite, inviteFromPage } from "../sync/sharing";
import { Button, EmptyState } from "../ui/components";
import { appError, OverlaySlot } from "../ui/dialog";
import { FOCUS_PROPERTY } from "../ui/focus-ring";
import { KeyboardSafeRoot } from "../ui/keyboard-safe";
import { useAppLock, useNavigationAcrossLock } from "../ui/app-lock";
import { useDatabaseHandoff } from "../ui/database-handoff";
import { Launch } from "../ui/launch";
import { APPEARANCE_KEYS, isThemePreference, PALETTES, resolvePaletteId, ThemeContext } from "../ui/theme";
import { subscribeAppearance, ThemeDissolve, type Appearance } from "../ui/theme-transition";
import { ErrorBoundary } from "../ui/error-boundary";
import { FrozenGate, OperationWait } from "../ui/operation-wait";
import { clearUndo, UndoSnackbar } from "../ui/undo";

// Subset faces copied byte for byte: Fiala has no subsetting script (`docs/ARCHITECTURE.md`).
const Inter_400Regular = require("../../assets/fonts/Inter_400Regular.ttf");
const Inter_500Medium = require("../../assets/fonts/Inter_500Medium.ttf");
const Inter_600SemiBold = require("../../assets/fonts/Inter_600SemiBold.ttf");
const IBMPlexSerif_600SemiBold = require("../../assets/fonts/IBMPlexSerif_600SemiBold.ttf");

const WEB = Platform.OS === "web" && typeof location !== "undefined";

/**
 * A web invitation opened signed out: signing in sends the page to the tabs
 * and the fragment with it, so the token is held here, once, and the
 * invitation reopened after (Gital's).
 */
const invitedTo = WEB ? inviteFromPage(location) : null;
if (invitedTo) void holdInvite(invitedTo);

// At module load, as the package asks: from inside a component it can come
// after the splash has already gone. `Launch` hides it.
SplashScreen.preventAutoHideAsync().catch(() => {});

/** Every screen reads the database, so none draws until it is migrated; a failure gets its own screen.
 *  "retrying" keeps that screen up with its button busy rather than dropping to plain ground. */
function useDatabase() {
  const [database, setDatabase] = useState<"opening" | "ready" | "failed" | "retrying">("opening");
  const [openAttempt, setOpenAttempt] = useState(0);
  const { heldElsewhere } = useDatabaseHandoff(database === "ready", database === "failed");

  useEffect(() => {
    let cancelled = false;
    migrateDb().then(
      () => {
        if (cancelled) return;
        setDatabase("ready");
        void takeDatabaseRebuilt().then((rebuilt) => {
          if (rebuilt) void appError(tr.errors.databaseRebuilt);
        });
      },
      () => !cancelled && setDatabase("failed"),
    );
    return () => {
      cancelled = true;
    };
  }, [openAttempt]);

  const retry = useCallback(() => {
    setDatabase("retrying");
    setOpenAttempt((n) => n + 1);
  }, []);
  return { database, failed: database === "failed" || database === "retrying", heldElsewhere, retry };
}

export default function RootLayout() {
  const systemScheme = useColorScheme();
  const [appearance, setAppearanceState] = useState<Appearance | null>(null);
  const [fontGrace, setFontGrace] = useState(false);
  const [fontsLoaded, fontsError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, IBMPlexSerif_600SemiBold });
  const { database, failed, heldElsewhere, retry } = useDatabase();
  // The first real screen — the routes, or a failure's own — has drawn.
  const [settled, setSettled] = useState(false);
  const settle = useCallback(() => setSettled(true), []);

  useEffect(() => {
    // Fonts are cosmetic: a slow web fetch must not hold the app on a blank screen.
    const timer = setTimeout(() => setFontGrace(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeAppearance((next) => setAppearanceState((current) => current && { ...current, ...next }));
    Promise.all([kv.get(APPEARANCE_KEYS.theme), kv.get(APPEARANCE_KEYS.palette)])
      .catch(() => [null, null] as const)
      .then(([theme, palette]) => {
        setAppearanceState({ theme: isThemePreference(theme) ? theme : "system", palette: resolvePaletteId(palette) });
      });
    return unsubscribe;
  }, []);

  const preference = appearance?.theme ?? "system";
  const paletteId = appearance?.palette ?? resolvePaletteId(null);
  const scheme = preference === "system" ? (systemScheme === "dark" ? "dark" : "light") : preference;
  const theme = { palette: PALETTES[paletteId][scheme], scheme, paletteId, preference };

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.style.setProperty(FOCUS_PROPERTY, theme.palette.focus);
    // A browser takes the first `theme-color` whose media matches, so the shell's two are
    // overwritten and lose their media rather than a third being added.
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", theme.palette.background);
      meta.removeAttribute("media");
    });
  }, [scheme, theme.palette.focus, theme.palette.background]);

  // The root view shows wherever no screen is drawn and is the system's white unset.
  // Expo Go repaints it white on each foreground; store builds do not.
  useEffect(() => {
    if (Platform.OS === "web") return;
    void SystemUI.setBackgroundColorAsync(theme.palette.background).catch(() => {});
  }, [theme.palette.background]);

  const ready = appearance != null && database !== "opening" && (fontsLoaded || fontsError != null || fontGrace);
  // Both branches keep `Launch` in one place, so becoming ready does not
  // remount it and restart the draw.
  return (
    <ThemeContext.Provider value={theme}>
      <WebTitle />
      {ready ? (
        <KeyboardSafeRoot>
          <View style={{ flex: 1, backgroundColor: theme.palette.background }}>
            {failed ? (
              <BootFailure
                retrying={database === "retrying"}
                heldElsewhere={heldElsewhere}
                onShown={settle}
                onRetry={retry}
              />
            ) : (
              <ErrorBoundary onShown={settle}>
                <Routes background={theme.palette.background} onSettled={settle} />
              </ErrorBoundary>
            )}
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            <UndoSnackbar />
            <OverlaySlot />
            <ThemeDissolve />
          </View>
        </KeyboardSafeRoot>
      ) : (
        // The web document already wears the stored ground (`+html.tsx`); a colour here would differ
        // between static and first client render, which hydration never repairs.
        <View style={{ flex: 1, backgroundColor: Platform.OS === "web" ? undefined : theme.palette.background }} />
      )}
      {/* Shown once the stored palette is known, so neither ground nor mark changes colour mid-draw. */}
      <Launch shown={appearance != null} ready={settled} />
    </ThemeContext.Provider>
  );
}

/** On the web a failed open breaks wa-sqlite's VFS for this document, so retry reloads; native re-opens the file.
 *  While another tab holds the database there is no button: this tab opens when that one closes. */
function BootFailure({ retrying, heldElsewhere, onShown, onRetry }: { retrying: boolean; heldElsewhere: boolean; onShown: () => void; onRetry: () => void }) {
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ flex: 1 }} onLayout={onShown}>
      <EmptyState
        icon={DatabaseZap}
        title={tr.errors.bootFailedTitle}
        hint={heldElsewhere ? tr.errors.bootHeldElsewhere : tr.errors.bootFailedHint}
        action={
          heldElsewhere ? undefined : (
            <Button
              label={tr.common.retry}
              loading={retrying}
              onPress={() => (WEB ? location.reload() : onRetry())}
            />
          )
        }
      />
    </View>
  );
}

/**
 * Expo Router's head writes a <title> ahead of the shell's and the browser shows the first.
 * Rendered ready or not: the static export renders the layout before it is ready.
 */
function WebTitle() {
  if (Platform.OS !== "web") return null;
  return (
    <Head>
      <title>{tr.meta.title}</title>
    </Head>
  );
}

/** The account decides the routes. Expo Router's guard rather than a redirect,
 *  which throws when it runs before the navigator mounts. */
function Routes({ background, onSettled }: { background: string; onSettled: () => void }) {
  const ready = useSession((s) => s.ready);
  const userId = useSession((s) => s.userId);
  const operation = useSession((s) => s.operation);
  const signedIn = userId != null;
  const frozen = useAccountFrozen(signedIn);
  const { locked: lockedHere, unlock } = useAppLock(ready, userId);
  // The device that freezes signs out; its own freezing is not a lock.
  const locked = frozen === true && operation !== "freeze";
  useNavigationAcrossLock(lockedHere, lockedHere === false && !locked, userId);
  useEffect(() => {
    // A launch that cannot decide opens on sign-in rather than on nothing.
    useSession.getState().bootstrap().catch(() => useSession.setState({ ready: true }));
  }, []);
  // An undo offered to one account must not run against the next one's data.
  useEffect(() => clearUndo(), [userId]);
  useEffect(() => {
    if (!signedIn || !WEB) return;
    void heldInvite({ take: true }).then((token) => {
      // Signed in already, the invitation page opened with its own fragment.
      if (token && !/\/invite\/?$/.test(location.pathname)) router.push({ pathname: "/invite", params: { token } });
    });
  }, [signedIn]);
  const settled = ready && !(signedIn && frozen == null) && lockedHere != null;
  // The launch screen stays over this gap, so it never shows as a blank frame.
  useEffect(() => {
    if (settled) onSettled();
  }, [settled, onSettled]);
  if (!settled) return null;
  return (
    <>
      {lockedHere ? (
        <View style={{ flex: 1, backgroundColor: background }}>
          <EmptyState icon={LockKeyhole} title={tr.lock.title} hint={tr.lock.prompt} action={<Button label={tr.lock.button} onPress={() => void unlock()} />} />
        </View>
      ) : locked ? (
        <FrozenGate />
      ) : (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="sync-issues" />
            <Stack.Screen name="data-reset" />
            <Stack.Screen name="account-security" />
            <Stack.Screen name="add-box" />
            <Stack.Screen name="box/[id]" />
            <Stack.Screen name="boxes" />
            <Stack.Screen name="documents" />
            <Stack.Screen name="add-document" />
            <Stack.Screen name="document/[id]" />
            <Stack.Screen name="doses" />
            <Stack.Screen name="dose-plan" />
            <Stack.Screen name="import" />
            <Stack.Screen name="product/[id]" />
            <Stack.Screen name="names/[table]" />
            <Stack.Screen name="household/[id]" />
            <Stack.Screen name="invite" />
            <Stack.Screen name="households" />
            <Stack.Screen name="person/[id]" />
            <Stack.Screen name="to-buy" />
            <Stack.Screen name="to-dispose" />
            <Stack.Screen name="notices" />
            <Stack.Screen name="status-cards" />
            <Stack.Screen name="profile" />
            <Stack.Screen name="help" />
            <Stack.Screen name="medicine/[id]" />
            <Stack.Screen name="pharmacies" />
            <Stack.Screen name="pharmacy/[id]" />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="(auth)/sign-in" />
          </Stack.Protected>
          <Stack.Screen name="privacy" />
          {/* Signed out too: sign-in sends a failure here. */}
          <Stack.Screen name="feedback" />
        </Stack>
      )}
      {/* Kept while locked: the reopening may come from another device. */}
      {signedIn ? (
        <>
          <SyncRunner userId={userId} />
          <LiveRunner userId={userId} />
          <ReminderPlanner userId={userId} />
          {locked || lockedHere ? null : <ReminderTaps />}
        </>
      ) : null}
      {operation ? <OperationWait operation={operation} /> : null}
    </>
  );
}

/** How often an open app looks for the other phone's changes. */
const SYNC_POLL_MS = 30_000;

/** When to sync (a write schedules its own): on opening, on coming to the front, and every half
 *  minute in front, since the other phone's changes arrive unannounced. */
function SyncRunner({ userId }: { userId: string }) {
  useEffect(() => {
    const sync = () => void syncNow(userId);
    sync();
    const subscription = AppState.addEventListener("change", (state) => state === "active" && sync());
    const poll = setInterval(() => AppState.currentState === "active" && sync(), SYNC_POLL_MS);
    return () => {
      subscription.remove();
      clearInterval(poll);
    };
  }, [userId]);
  return null;
}

/**
 * A shared household is live (`docs/TASKS.md` F2.6): what someone else
 * changed is pulled within seconds rather than at the next poll, which stays
 * behind it for a nudge the socket lost. A person who shares nothing never
 * loads the socket. Gital's.
 */
function LiveRunner({ userId }: { userId: string }) {
  const households = useHouseholds().households.data;
  const cabinets = households
    .filter((household) => household.members.length > 1 && household.members.some((member) => member.userId === userId))
    .map((household) => household.id)
    .join(",");
  const shared = cabinets !== "";
  useEffect(() => {
    const access = shared ? realtimeAccess() : null;
    if (!access) return;
    startLive({ ...access, userId, onMoved: () => scheduleSync(userId) }).catch(() => {});
    return stopLive;
  }, [userId, shared]);
  useEffect(() => followCabinets(cabinets ? cabinets.split(",") : []), [cabinets]);
  return null;
}

/** At opening and each time the app leaves the screen, when what it holds may have changed. Gital's. */
function ReminderPlanner({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (!remindersAvailable) return;
    const plan = () => void replanReminders(userId).catch(() => {});
    plan();
    const subscription = AppState.addEventListener("change", (state) => state === "background" && plan());
    return () => subscription.remove();
  }, [userId]);
  return null;
}

/** Not while the account is frozen or the app locked: a tap must not open a screen behind the lock. */
function ReminderTaps() {
  useEffect(() => (remindersAvailable ? followReminderTaps((route) => router.push(route)) : undefined), []);
  return null;
}
