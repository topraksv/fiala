/**
 * The account session (SPEC 2.1). The last account signed in is kept on the
 * device, so the app opens offline, and Supabase refreshes the session when it
 * can. Sync runs exactly while an account is open here: this file starts it,
 * and stops it before anything empties the device under it.
 *
 * The first account to sign in adopts the rows made before accounts; a session
 * Supabase ends by itself keeps what was never sent behind the sign-in screen
 * rather than wiping it; and no account signs in over another's rows while any
 * change is unsent (`docs/ARCHITECTURE.md`).
 */

import { create } from "zustand";
import { Platform } from "react-native";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordDeviceLogin, setAccountFrozen } from "../data/settings";
import { pendingOutboxCount, resetLocalWorkspace } from "../db/mutations";
import { useSyncStatus } from "../sync/status";
import { tr } from "../i18n/tr";
import { kv } from "../services/kv";
import { forgetGuide } from "../services/guide";
import { forgetReminderPreferences } from "../services/reminder-preferences";
import { cancelReminders } from "../services/reminders";
import { flushOutbox, startSyncSession, stopSyncSession } from "../sync/engine";
import { createRecoveryClient, getSupabase, subscribeSupabaseAuthEvents } from "../sync/supabase";
import { purgeOwnDocuments } from "../sync/documents";
import { purgeOwnPhotos } from "../sync/photos";
import { friendlyAuthError } from "./auth-errors";
import { deviceName } from "../domain/logins";
import { deviceId, loadPreviousLogin, recordSuccessfulLogin, startLoginHistory } from "./login-history";
import { IDLE_BRAKE, isVerificationBlocked, recordVerificationFailure, recordVerificationSuccess } from "./verification-brake";

/** The local copy emptied, and with it what was pulled into it: "nothing here" waits for the next pull (`pulledOnce`). */
async function wipeWorkspace(): Promise<void> {
  await resetLocalWorkspace();
  useSyncStatus.getState().set({ state: "idle", error: null, lastSyncAt: null });
}

/** The one account of a build with no Supabase, which runs on the device alone. */
export const LOCAL_USER_ID = "local";

/** The server's `minimum_password_length`, checked before asking so the form can say it. */
const PASSWORD_MIN = 8;

export function isValidNewPassword(password: string): boolean {
  return [...password].length >= PASSWORD_MIN;
}

/** Compared by identity, so the account screen offers "sign out anyway" instead of an error. */
export const SIGN_OUT_PENDING_CHANGES = tr.auth.signOutPending;

const LAST_USER_KEY = "fiala.auth.last_user";
/** Kept so a password check still knows the address after an offline start. */
const LAST_EMAIL_KEY = "fiala.auth.last_email";
/** Whose rows the database holds; absent means the rows from before accounts. */
const OWNER_KEY = "fiala.auth.owner";
/** A deleted account whose wipe failed: whoever signs in next wipes first. */
const WIPE_PENDING = "__wipe_pending__";

let brake = IDLE_BRAKE;
let explicitSignOut = false;
let listening = false;
/**
 * The bootstrap under way. One that overlaps it — React's double effect in
 * development, a remount mid-start — shares it rather than reading `ready`
 * before either has set it and counting the same opening twice.
 */
let opening: Promise<void> | null = null;

const signedOut = { userId: null, email: null, previousLoginAt: null } as const;

/** Catches for the convenience work `claim` describes. */
const ignore = () => {};
const absent = () => null;

/** Auth could not be reached, which is not the same as Auth saying no. */
const unreachable = (error: { name?: string } | null) => error?.name === "AuthRetryableFetchError";

/** This device's row among the account's sign-ins; a store that refuses it costs the line, never the session. */
async function recordThisDevice(at: string, previous: string | null): Promise<void> {
  const device = deviceName({
    os: Platform.OS,
    isPad: Platform.OS === "ios" && Platform.isPad,
    model: (Platform.constants as { Model?: string } | undefined)?.Model,
    agent: globalThis.navigator?.userAgent,
  });
  await deviceId(kv)
    .then((id) => recordDeviceLogin(id, { at, previous, device }))
    .catch(ignore);
}

/**
 * Prove the database is `userId`'s before the account opens on it. Read,
 * write and read back: a read that fails must not pass for "no owner", which
 * is the answer that skips a wipe, and on the web `kv` drops a write the
 * browser refuses, so only reading the marker back proves it landed.
 */
async function ensureWorkspaceFor(userId: string): Promise<string | null> {
  let owner: string | null;
  try {
    owner = await kv.get(OWNER_KEY);
  } catch {
    return tr.auth.errWorkspaceOwner;
  }
  if (owner === userId) return null;
  if (owner) {
    try {
      // Another account's rows may exist nowhere else yet. The one exception
      // is a deleted account's: nobody is left to send them to.
      if (owner !== WIPE_PENDING && (await pendingOutboxCount()) > 0) return tr.auth.errOtherAccountPending;
      await cancelReminders().catch(ignore);
      await forgetReminderPreferences().catch(ignore);
      await forgetGuide().catch(ignore);
      await wipeWorkspace();
    } catch {
      return tr.auth.errWorkspaceReset;
    }
  }
  const recorded = await kv
    .set(OWNER_KEY, userId)
    .then(() => kv.get(OWNER_KEY))
    .catch(absent);
  return recorded === userId ? null : tr.auth.errWorkspaceOwner;
}

/**
 * Open the account on this device once its workspace is proven its own, or
 * end the session Auth just gave. Past the proof, everything is convenience —
 * who to reopen offline, a date to show — and a store that refuses it costs
 * the convenience, never the session.
 */
async function claim(supabase: SupabaseClient, user: { id: string; email?: string }, email: string): Promise<string | null> {
  const refused = await ensureWorkspaceFor(user.id);
  if (refused) {
    await endAuthSession(supabase, "local");
    return refused;
  }
  await kv.set(LAST_USER_KEY, user.id).catch(ignore);
  await kv.set(LAST_EMAIL_KEY, user.email ?? email).catch(ignore);
  return null;
}

async function forgetAccount(): Promise<void> {
  for (const key of [OWNER_KEY, LAST_USER_KEY, LAST_EMAIL_KEY]) await kv.remove(key).catch(ignore);
}

/**
 * End the session on this device only, unless the account itself is going:
 * Supabase's default scope is global, which would end every other device's
 * session. A refused revoke still clears it here, or the next launch would
 * find it.
 */
async function endAuthSession(supabase: SupabaseClient, scope: "local" | "global"): Promise<void> {
  explicitSignOut = true;
  try {
    const { error } = await supabase.auth.signOut({ scope }).catch((failure: unknown) => ({ error: failure }));
    if (error) await supabase.auth.signOut({ scope: "local" }).catch(ignore);
  } finally {
    explicitSignOut = false;
  }
}

/**
 * A session that ended without a sign-out — revoked, deleted elsewhere,
 * replaced — closes the app on the sign-in screen. The device is wiped once
 * nothing is waiting to be sent; what is waiting may exist nowhere else, so it
 * stays, still owned, and only its account reopens it.
 */
async function closeEndedSession(): Promise<void> {
  useSession.setState(signedOut);
  await stopSyncSession();
  await kv.remove(LAST_USER_KEY).catch(ignore);
  await cancelReminders().catch(ignore);
  // A count that fails is not a zero.
  if ((await pendingOutboxCount().catch(ignore)) === 0) await wipeWorkspace().then(forgetAccount, ignore);
}

function listenForEndedSessions(): void {
  if (listening) return;
  listening = true;
  subscribeSupabaseAuthEvents((event) => {
    // Supabase warns against auth work inside its own callback.
    if (event === "SIGNED_OUT" && !explicitSignOut) queueMicrotask(() => void closeEndedSession());
  });
}

type SignUpResult = { status: "signed-in" } | { status: "confirmation-required" } | { status: "error"; message: string };

interface SessionStore {
  userId: string | null;
  email: string | null;
  /** False until the first launch has decided who, if anyone, is signed in. */
  ready: boolean;
  /** The sign-in before this session's, for the account screen. */
  previousLoginAt: string | null;
  /**
   * What this device is doing to the account, drawn over the app while it
   * runs. A freeze signs out as its last step, so it stays "freeze" — which
   * also keeps the frozen gate shut on the device doing the freezing.
   */
  operation: AccountOperation | null;
  bootstrap: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  /** The code the confirmation e-mail carries, which opens the new account here. */
  confirmSignUp: (email: string, code: string) => Promise<string | null>;
  resendSignUpCode: (email: string) => Promise<string | null>;
  requestPasswordReset: (email: string) => Promise<string | null>;
  /** The reset e-mail's code and the new password; signs nobody in here. */
  resetPassword: (email: string, code: string, newPassword: string) => Promise<string | null>;
  /** Empties the device. Refuses with `SIGN_OUT_PENDING_CHANGES` while a change is unsent, unless `force`. */
  signOut: (options?: { force?: boolean }) => Promise<string | null>;
  deleteAccount: () => Promise<string | null>;
  /** Lock the account on every device until a sign-in; frozen only once the server has it. */
  freezeAccount: () => Promise<string | null>;
  /** Confirm the password before a delete or a credential change; a run of failures pauses it. */
  verifyPassword: (password: string) => Promise<string | null>;
  /** Mails a code to the current address and one to the new; the change waits for both. */
  changeEmail: (newEmail: string) => Promise<string | null>;
  /** Checks the two codes `changeEmail` mailed; a code already accepted is not asked again. */
  confirmEmailChange: (newEmail: string, codes: EmailChangeCodes) => Promise<EmailChangeAnswer>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<string | null>;
  /**
   * Ends the account's session on every other device (`docs/TASKS.md` F1.30);
   * this one stays. Each finds out at its next token refresh, within the hour,
   * and empties itself as any session Supabase ended does.
   */
  signOutOthers: () => Promise<string | null>;
}

/** The code mailed to the address now on the account, and the one mailed to the address it moves to. */
export type EmailChangeCodes = { current: string; next: string };
/** No error is the change made; otherwise which codes Auth has already taken. */
type EmailChangeAnswer = { error: string | null; accepted: Record<keyof EmailChangeCodes, boolean> };

export type AccountOperation = "sign-in" | "sign-out" | "freeze" | "delete";

/** `work` shown as `operation`, unless one already runs: a freeze's own sign-out stays a freeze. */
async function running<T>(operation: AccountOperation, work: () => Promise<T>): Promise<T> {
  if (useSession.getState().operation) return work();
  useSession.setState({ operation });
  try {
    return await work();
  } finally {
    useSession.setState({ operation: null });
  }
}

/** A refused code: spent, mistyped or expired read alike, since Auth does not say which. Unreached is not refused. */
function codeRefusal(error: { name?: string; message: string } | null): string {
  return error && !unreachable(error) && !/rate limit|too many/i.test(error.message) ? tr.auth.errCode : friendlyAuthError(error?.message ?? "");
}

/** A reset code already checked, kept until its password is saved or another code is asked for. */
let verifiedReset: { email: string; client: SupabaseClient } | null = null;

/** The codes of the change last asked for that Auth has taken: each is spent once checked. */
let acceptedChange: { email: string; accepted: EmailChangeAnswer["accepted"] } | null = null;

/** A first session for an account just made: its workspace, its first sign-in, its sync. */
async function openNewAccount(supabase: SupabaseClient, user: { id: string; email?: string }, email: string): Promise<string | null> {
  const refused = await claim(supabase, user, email);
  if (refused) return refused;
  const at = new Date().toISOString();
  await startLoginHistory(kv, user.id, at).catch(ignore);
  await recordThisDevice(at, null);
  startSyncSession(user.id);
  useSession.setState({ userId: user.id, email: user.email ?? email, previousLoginAt: null });
  return null;
}

export const useSession = create<SessionStore>((set, get) => ({
  userId: null,
  email: null,
  ready: false,
  previousLoginAt: null,
  operation: null,

  bootstrap: () =>
    (opening ??= (async () => {
      const supabase = getSupabase();
      if (!supabase) {
        set({ userId: LOCAL_USER_ID, ready: true });
        return;
      }
      listenForEndedSessions();
      let offline = false;
      try {
        const { data, error } = await supabase.auth.getSession();
        const user = data.session?.user;
        if (user) {
          if (await claim(supabase, user, "")) {
            set({ ...signedOut, ready: true });
            return;
          }
          // Opening the account counts as a sign-in (SPEC 2.6): sessions refresh
          // for good, so waiting for a password sign-in would never advance it.
          // Already open on this account (a sign-in just ran) is not a new open.
          const open = get().ready && get().userId === user.id;
          let previousLoginAt = get().previousLoginAt;
          if (!open) {
            const at = new Date().toISOString();
            previousLoginAt = await recordSuccessfulLogin(kv, user.id, at).catch(absent);
            await recordThisDevice(at, previousLoginAt);
          }
          startSyncSession(user.id);
          set({ userId: user.id, email: user.email ?? null, ready: true, previousLoginAt });
          return;
        }
        offline = unreachable(error);
      } catch {
        offline = true;
      }
      // Only an unreachable Auth reopens the last account. One that answered
      // with no session has refused it, and reopening it would hide that.
      const lastUser = offline ? await kv.get(LAST_USER_KEY).catch(absent) : null;
      if (lastUser && !(await ensureWorkspaceFor(lastUser))) {
        startSyncSession(lastUser);
        set({
          userId: lastUser,
          email: await kv.get(LAST_EMAIL_KEY).catch(absent),
          ready: true,
          previousLoginAt: await loadPreviousLogin(kv, lastUser).catch(absent),
        });
        return;
      }
      set({ ...signedOut, ready: true });
    })().finally(() => {
      opening = null;
    })),

  signIn: (email, password) =>
    running("sign-in", async () => {
      const supabase = getSupabase();
      if (!supabase) return tr.auth.errNotConfigured;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return friendlyAuthError(error.message);
      const refused = await claim(supabase, data.user, email);
      if (refused) return refused;
      const at = data.user.last_sign_in_at ?? new Date().toISOString();
      const previousLoginAt = await recordSuccessfulLogin(kv, data.user.id, at).catch(absent);
      // Signing in is the password check, so it reopens a frozen account: a
      // write newer than the freeze, which the gate on every device follows.
      await setAccountFrozen(false).catch(ignore);
      await recordThisDevice(at, previousLoginAt);
      startSyncSession(data.user.id);
      set({ userId: data.user.id, email: data.user.email ?? email, previousLoginAt });
      return null;
    }),

  signUp: async (email, password) => {
    const supabase = getSupabase();
    if (!supabase) return { status: "error", message: tr.auth.errNotConfigured };
    if (!isValidNewPassword(password)) return { status: "error", message: tr.auth.errWeakPassword };
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error || !data.user) return { status: "error", message: friendlyAuthError(error?.message ?? "") };
    // With confirmation on, Auth gives no session until the address is
    // proven by the code it mails (`confirmSignUp`).
    if (!data.session) return { status: "confirmation-required" };
    const refused = await openNewAccount(supabase, data.user, email);
    return refused ? { status: "error", message: refused } : { status: "signed-in" };
  },

  confirmSignUp: (email, code) =>
    running("sign-in", async () => {
      const supabase = getSupabase();
      if (!supabase) return tr.auth.errNotConfigured;
      // "signup", not "email": Auth takes a reset code as "email" too, which would
      // open an existing account here as a new one.
      const { data, error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code, type: "signup" });
      if (error || !data.user) return codeRefusal(error);
      return openNewAccount(supabase, data.user, email);
    }),

  resendSignUpCode: async (email) => {
    const supabase = getSupabase();
    if (!supabase) return tr.auth.errNotConfigured;
    const { error } = await supabase.auth.resend({ type: "signup", email: email.trim() });
    return error ? friendlyAuthError(error.message) : null;
  },

  requestPasswordReset: async (email) => {
    const client = createRecoveryClient();
    if (!client) return tr.auth.errNotConfigured;
    const { error } = await client.auth.resetPasswordForEmail(email.trim());
    // A refused resend (Auth allows one a minute) leaves the sent code standing, and the session it opened.
    // An address with no account reads as sent, so the form never says which addresses have one.
    if (error && !/user.*not found|email.*not found/i.test(error.message)) return friendlyAuthError(error.message);
    verifiedReset = null;
    return null;
  },

  resetPassword: async (email, code, newPassword) => {
    if (!isValidNewPassword(newPassword)) return tr.auth.errWeakPassword;
    const address = email.trim();
    // On a client of its own: the code opens a session for the account it
    // resets, which need not be the one this device is signed in with. Kept
    // past a refused save, since the code is spent once checked.
    let client = verifiedReset?.email === address ? verifiedReset.client : null;
    if (!client) {
      client = createRecoveryClient();
      if (!client) return tr.auth.errNotConfigured;
      const { error } = await client.auth.verifyOtp({ email: address, token: code, type: "recovery" });
      if (error) return codeRefusal(error);
      verifiedReset = { email: address, client };
    }
    const { error: refused } = await client.auth.updateUser({ password: newPassword });
    if (refused) return friendlyAuthError(refused.message);
    verifiedReset = null;
    await client.auth.signOut({ scope: "local" }).catch(ignore);
    // A new password ends the account's other sessions, this device's among
    // them: its next refresh would fail and sign it out, so it signs in again now.
    const signedIn = get().email;
    if (signedIn?.toLowerCase() !== address.toLowerCase()) return null;
    // The code is spent and the password saved: a retry would only be told the code is wrong.
    return (await get().signIn(signedIn, newPassword)) ? tr.auth.passwordResetSignInAgain : null;
  },

  signOut: (options) =>
    running("sign-out", async () => {
      // A build with no accounts has nothing to sign out of, and its data no other copy.
      const supabase = getSupabase();
      if (!supabase) return tr.auth.errNotConfigured;
      const userId = get().userId;
      // Send what is waiting first, so the question is asked only about what truly cannot leave.
      if (userId) await flushOutbox(userId);
      if (!options?.force && (await pendingOutboxCount()) > 0) return SIGN_OUT_PENDING_CHANGES;
      await stopSyncSession();
      const [, wiped] = await Promise.all([cancelReminders().catch(ignore), wipeWorkspace().then(() => true, () => false)]);
      if (!wiped) {
        if (userId) startSyncSession(userId);
        return tr.auth.errWorkspaceReset;
      }
      // The owner mark goes below, so the next account to sign in meets no switch to forget these at.
      await Promise.all([forgetReminderPreferences().catch(ignore), forgetGuide().catch(ignore)]);
      set(signedOut);
      await Promise.all([endAuthSession(supabase, "local"), forgetAccount()]);
      return null;
    }),

  freezeAccount: () =>
    running("freeze", async () => {
      const userId = get().userId;
      if (!getSupabase() || !userId) return tr.auth.errNotConfigured;
      // The sign-out sends everything first and refuses while anything is
      // unsent, so its success is the proof that the freeze reached the server.
      await setAccountFrozen(true);
      const refused = await get().signOut().catch(() => tr.account.freezeSyncFailed);
      if (!refused) return null;
      // A failure after the flag must put it back, or every launch opens on the gate.
      if (!(await setAccountFrozen(false).then(() => true, () => false))) return tr.account.freezeRollbackFailed;
      return refused === SIGN_OUT_PENDING_CHANGES ? tr.account.freezeSyncFailed : refused;
    }),

  deleteAccount: () =>
    running("delete", async () => {
      const supabase = getSupabase();
      const userId = get().userId;
      if (!supabase || !userId) return tr.auth.errNotConfigured;
      // Nothing is sent while the account is taken apart. Its photos and
      // documents' files go first, since nothing cascades to Storage; then the
      // account, and if the server keeps it, the device keeps everything and
      // sync sends the files back.
      await stopSyncSession();
      let error: { message: string } | null;
      try {
        await purgeOwnPhotos();
        await purgeOwnDocuments(supabase);
        ({ error } = await supabase.rpc("delete_own_account"));
      } catch (failure) {
        error = { message: failure instanceof Error ? failure.message : String(failure) };
      }
      if (error) {
        startSyncSession(userId);
        const friendly = friendlyAuthError(error.message);
        return friendly === tr.auth.errSessionExpired ? friendly : tr.account.deleteCloudFailed;
      }
      // The identity is gone, so every device's session goes with it: the one
      // global revoke. A round trip beside a local wipe that does not need it.
      const [, , wiped] = await Promise.all([
        cancelReminders().catch(ignore),
        endAuthSession(supabase, "global"),
        wipeWorkspace().then(() => true, () => false),
      ]);
      if (!wiped) {
        set(signedOut);
        // The marker replaces the owner rather than following its removal: a
        // device left with no owner adopts the next account with these rows.
        await kv.set(OWNER_KEY, WIPE_PENDING).catch(ignore);
        for (const key of [LAST_USER_KEY, LAST_EMAIL_KEY]) await kv.remove(key).catch(ignore);
        return tr.account.deleteWipeFailed;
      }
      set(signedOut);
      await forgetAccount();
      return null;
    }),

  verifyPassword: async (password) => {
    const supabase = getSupabase();
    const owner = get().userId;
    if (!supabase || !owner) return tr.auth.errNotConfigured;
    if (isVerificationBlocked(brake, owner, Date.now())) return tr.auth.errRateLimit;
    // After an offline start the store has no address; Auth or the device may.
    let email = get().email;
    if (!email) {
      email = (await supabase.auth.getUser().catch(absent))?.data.user?.email ?? (await kv.get(LAST_EMAIL_KEY).catch(absent));
      if (!email) return tr.auth.errSessionExpired;
      set({ email });
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      brake = recordVerificationFailure(brake, owner, Date.now());
      return /invalid login credentials|invalid_credentials/i.test(error.message) ? tr.account.wrongPassword : friendlyAuthError(error.message);
    }
    if (data.user.id !== owner) {
      // The address was another account's, whose session just replaced this
      // one's: end it, and let this account sign in again to its own rows.
      await endAuthSession(supabase, "local");
      await closeEndedSession();
      return tr.auth.errSessionExpired;
    }
    brake = recordVerificationSuccess(brake, owner);
    return null;
  },

  changeEmail: async (newEmail) => {
    const supabase = getSupabase();
    if (!supabase) return tr.auth.errNotConfigured;
    const { error } = await supabase.auth.updateUser({ email: newEmail.trim() });
    // A refused resend leaves the sent codes, and the ones Auth took, standing.
    if (error) return friendlyAuthError(error.message);
    acceptedChange = null;
    return null;
  },

  confirmEmailChange: async (newEmail, codes) => {
    const supabase = getSupabase();
    const current = get().email;
    const address = newEmail.trim();
    if (acceptedChange?.email !== address) acceptedChange = { email: address, accepted: { current: false, next: false } };
    const { accepted } = acceptedChange;
    if (!supabase || !current) return { error: supabase ? tr.auth.errSessionExpired : tr.auth.errNotConfigured, accepted: { ...accepted } };
    let changed = false;
    for (const side of ["next", "current"] as const) {
      if (accepted[side]) continue;
      const { data, error } = await supabase.auth.verifyOtp({ email: side === "next" ? address : current, token: codes[side], type: "email_change" });
      if (error) {
        const refused = codeRefusal(error);
        return { error: refused === tr.auth.errCode ? tr.account.emailCodeRefused[side] : refused, accepted: { ...accepted } };
      }
      accepted[side] = true;
      // Auth answers the first of the two codes with no session, so only a
      // session says the change is made; the flags are this device's memory.
      changed = Boolean(data.session);
    }
    acceptedChange = null;
    // Auth started over behind this device (a resend whose reply was lost,
    // another tab), so a code taken earlier no longer counts.
    if (!changed) return { error: tr.account.emailChangeRestarted, accepted: { current: false, next: false } };
    set({ email: address });
    await kv.set(LAST_EMAIL_KEY, address).catch(ignore);
    return { error: null, accepted: { current: true, next: true } };
  },

  changePassword: async (currentPassword, newPassword) => {
    const supabase = getSupabase();
    if (!supabase) return tr.auth.errNotConfigured;
    if (!isValidNewPassword(newPassword)) return tr.auth.errWeakPassword;
    const { error } = await supabase.auth.updateUser({ current_password: currentPassword, password: newPassword });
    return error ? friendlyAuthError(error.message) : null;
  },

  signOutOthers: async () => {
    const supabase = getSupabase();
    if (!supabase) return tr.auth.errNotConfigured;
    const { error } = await supabase.auth.signOut({ scope: "others" });
    return error ? friendlyAuthError(error.message) : null;
  },
}));
