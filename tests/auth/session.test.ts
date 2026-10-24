/**
 * The account session (SPEC 2.1) over a stubbed Supabase and the real write
 * layer on Node's SQLite, the sync engine replaced by a recorder. A workspace
 * belongs to one account, sync runs only while its account is open, a
 * sign-out sends what is waiting and asks before it destroys what could not
 * leave, and a deleted account leaves nothing behind — with two departures: the first account adopts the rows made
 * before accounts, and a session Supabase ends keeps what was never sent
 * behind sign-in rather than wiping it.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CloudUser {
  id: string;
  email: string;
  password: string;
}

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
const device = vi.hoisted(() => ({
  os: "ios",
  stored: new Map<string, string>(),
  /** Keys a blocked store drops on write, as a browser with site data off does. */
  dropped: new Set<string>(),
  /** Keys whose every read and write throws, as a locked keychain does. */
  failing: new Set<string>(),
  /** Keys whose next read throws, and the one after answers. */
  readFailsOnce: new Set<string>(),
  /** Times every scheduled reminder was taken off the phone. */
  cancelled: 0,
}));
const cloud = vi.hoisted(() => ({
  configured: true,
  users: [] as CloudUser[],
  session: null as { user: { id: string; email: string; last_sign_in_at?: string } } | null,
  sessionError: null as { name: string; message: string } | null,
  rpcError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  signUpError: null as { message: string } | null,
  resetError: null as { message: string } | null,
  verifyError: null as { name: string; message: string; code?: string } | null,
  signUpSession: true,
  savedPassword: null as string | null,
  /** The code each address of an e-mail change still owes, as Auth holds them. */
  emailChange: null as { to: string; owed: Map<string, string> } | null,
  /** A client that throws instead of answering, as a fetch polyfill can. */
  throws: false,
  calls: [] as string[],
  listeners: new Set<(event: string) => void>(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return device.os;
    },
  },
}));
vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});
vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);
vi.mock("../../src/services/kv", () => {
  const reach = (key: string) => {
    if ([...device.failing].some((prefix) => key.startsWith(prefix))) throw new Error("keychain locked");
  };
  return {
    kv: {
      get: async (key: string) => {
        reach(key);
        if (device.readFailsOnce.delete(key)) throw new Error("keychain busy");
        return device.stored.get(key) ?? null;
      },
      set: async (key: string, value: string) => void (reach(key), device.dropped.has(key) || device.stored.set(key, value)),
      remove: async (key: string) => void (reach(key), device.stored.delete(key)),
    },
    // The guide's lists, as far as an account switch reaches them: forgetting.
    kvList: (key: string) => ({ forget: async () => void device.stored.delete(key) }),
  };
});
const sync = vi.hoisted(() => ({
  calls: [] as string[],
  flushSends: false,
  /** What a flush that sends took from the outbox. */
  sent: [] as Record<string, unknown>[],
  onFlush: null as (() => void) | null,
  purgeFails: false,
}));
vi.mock("../../src/services/reminders", () => ({ cancelReminders: async () => void device.cancelled++ }));
vi.mock("../../src/sync/engine", () => ({
  startSyncSession: (userId: string) => void sync.calls.push(`start:${userId}`),
  stopSyncSession: async () => void sync.calls.push("stop"),
  flushOutbox: async () => {
    sync.calls.push("flush");
    sync.onFlush?.();
    if (!sync.flushSends) return;
    const waiting = harness.db!.prepare("SELECT payload FROM outbox ORDER BY id").all() as { payload: string }[];
    sync.sent.push(...waiting.map(({ payload }) => JSON.parse(payload) as Record<string, unknown>));
    harness.db!.exec("DELETE FROM outbox");
  },
}));
vi.mock("../../src/sync/photos", () => ({
  purgeOwnPhotos: async () => {
    cloud.calls.push("photos:purge");
    if (sync.purgeFails) throw new Error("Failed to fetch");
  },
}));
vi.mock("../../src/sync/documents", () => ({
  purgeOwnDocuments: async () => {
    cloud.calls.push("documents:purge");
  },
}));
vi.mock("../../src/sync/supabase", () => {
  const user = (found: CloudUser) => ({ id: found.id, email: found.email, last_sign_in_at: "2026-09-26T09:00:00.000Z" });
  const client = {
    auth: {
      getSession: async () => {
        if (cloud.throws) throw new TypeError("Network request failed");
        return { data: { session: cloud.session }, error: cloud.sessionError };
      },
      getUser: async () => ({ data: { user: cloud.session?.user ?? null } }),
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        // Auth reads an address in any case.
        const found = cloud.users.find((candidate) => candidate.email === email.toLowerCase() && candidate.password === password);
        if (!found) return { data: { user: null, session: null }, error: { message: "Invalid login credentials" } };
        cloud.session = { user: user(found) };
        return { data: { user: user(found), session: cloud.session }, error: null };
      },
      signUp: async ({ email, password }: { email: string; password: string }) => {
        if (cloud.signUpError) return { data: { user: null, session: null }, error: cloud.signUpError };
        const created = { id: `u-${email}`, email, password };
        cloud.users.push(created);
        cloud.session = cloud.signUpSession ? { user: user(created) } : null;
        return { data: { user: user(created), session: cloud.session }, error: null };
      },
      signOut: async ({ scope }: { scope: string }) => {
        cloud.calls.push(`signOut:${scope}`);
        if (cloud.throws) throw new TypeError("Network request failed");
        // Every other device's session ends; this one's stays.
        if (scope !== "others") cloud.session = null;
        // A global revoke after the account is deleted finds no user to revoke.
        return { error: scope === "global" ? { message: "User not found" } : null };
      },
      updateUser: async (change: Record<string, string>) => {
        cloud.calls.push(`updateUser:${Object.keys(change).sort().join(",")}`);
        return { error: cloud.updateError };
      },
      verifyOtp: async ({ email, token, type }: { email: string; token: string; type: string }) => {
        cloud.calls.push(`verifyOtp:${email}:${token}:${type}`);
        if (type === "email_change") {
          const change = cloud.emailChange;
          if (cloud.verifyError) return { data: { user: null, session: null }, error: cloud.verifyError };
          if (!change || change.owed.get(email) !== token) return { data: { user: null, session: null }, error: { name: "AuthApiError", message: "Token has expired or is invalid" } };
          change.owed.delete(email);
          // One side taken is not the change: Auth answers with nobody until both are in.
          if (change.owed.size) return { data: { user: null, session: null }, error: null };
          const moved = { ...cloud.session!.user, email: change.to };
          cloud.session = { user: moved };
          return { data: { user: moved, session: cloud.session }, error: null };
        }
        const found = cloud.users.find((candidate) => candidate.email === email);
        if (cloud.verifyError || !found) return { data: { user: null, session: null }, error: cloud.verifyError ?? { name: "AuthApiError", message: "Token has expired or is invalid" } };
        cloud.session = { user: user(found) };
        return { data: { user: user(found), session: cloud.session }, error: null };
      },
      resend: async ({ type, email }: { type: string; email: string }) => {
        cloud.calls.push(`resend:${type}:${email}`);
        return { error: cloud.resetError };
      },
    },
    rpc: async (name: string) => {
      cloud.calls.push(`rpc:${name}`);
      return { error: cloud.rpcError };
    },
  };
  const recovery = {
    auth: {
      resetPasswordForEmail: async (email: string, options?: unknown) => {
        cloud.calls.push(`reset:${email}${options === undefined ? "" : ":with-options"}`);
        return { error: cloud.resetError };
      },
      verifyOtp: async ({ email, token, type }: { email: string; token: string; type: string }) => {
        cloud.calls.push(`recovery:verifyOtp:${email}:${token}:${type}`);
        return { error: cloud.verifyError };
      },
      updateUser: async ({ password }: { password: string }) => {
        cloud.calls.push("recovery:updateUser");
        if (cloud.updateError) return { error: cloud.updateError };
        // A new password ends the account's other sessions, the app's among them.
        cloud.savedPassword = password;
        cloud.session = null;
        return { error: null };
      },
      signOut: async ({ scope }: { scope: string }) => {
        cloud.calls.push(`recovery:signOut:${scope}`);
        return { error: null };
      },
    },
  };
  return {
    get isSupabaseConfigured() {
      return cloud.configured;
    },
    getSupabase: () => (cloud.configured ? client : null),
    createRecoveryClient: () => (cloud.configured ? recovery : null),
    subscribeSupabaseAuthEvents: (listener: (event: string) => void) => {
      cloud.listeners.add(listener);
      return () => cloud.listeners.delete(listener);
    },
  };
});

const { LOCAL_USER_ID, SIGN_OUT_PENDING_CHANGES, useSession } = await import("../../src/auth/session");
const { VERIFY_COOLDOWN_MS, VERIFY_MAX_FAILURES } = await import("../../src/auth/verification-brake");
const { frozenFrom, isFrozen, readSettings, setAccountFrozen, writeSetting } = await import("../../src/data/settings");
const { deviceId } = await import("../../src/auth/login-history");
const { lastLogin } = await import("../../src/domain/logins");
const { kv: harnessKv } = await import("../../src/services/kv");
const { tr } = await import("../../src/i18n/tr");
const { pulledOnce, useSyncStatus } = await import("../../src/sync/status");
const { migratedDatabase } = await import("../helpers");

const OWNER = "fiala.auth.owner";
const LAST_USER = "fiala.auth.last_user";
const LAST_EMAIL = "fiala.auth.last_email";
const A: CloudUser = { id: "user-a", email: "a@ev.com", password: "parola-a1" };
const B: CloudUser = { id: "user-b", email: "b@ev.com", password: "parola-b1" };

const session = () => useSession.getState();
const count = (table: string) => Number((harness.db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const sent = () => harness.db!.exec("DELETE FROM outbox");
/** A row the account made, which a device must hold for one account only. */
const makeRow = () => writeSetting("market", 1);
const rows = () => Number((harness.db!.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'market'").get() as { n: number }).n);
/** Let the auth listener's deferred work run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  harness.db = migratedDatabase();
  device.os = "ios";
  device.stored.clear();
  device.dropped.clear();
  device.failing.clear();
  device.readFailsOnce.clear();
  device.cancelled = 0;
  Object.assign(cloud, { configured: true, users: [A, B], session: null, sessionError: null, rpcError: null, updateError: null, signUpError: null, resetError: null, verifyError: null, signUpSession: true, savedPassword: null, emailChange: null, throws: false, calls: [] });
  Object.assign(sync, { calls: [], flushSends: false, sent: [], onFlush: null, purgeFails: false });
  useSession.setState({ userId: null, email: null, ready: false, previousLoginAt: null });
});

describe("whose rows the device holds", () => {
  it("gives the rows made before accounts to the first account that signs in", async () => {
    await makeRow();
    expect(await session().signIn(A.email, A.password)).toBeNull();
    expect(session()).toMatchObject({ userId: A.id, email: A.email });
    expect(rows()).toBe(1);
    expect(device.stored.get(OWNER)).toBe(A.id);
    expect(device.stored.get(LAST_USER)).toBe(A.id);
    expect(sync.calls, "and syncs them under it").toEqual([`start:${A.id}`]);
  });

  it("will not let another account sign in over rows never sent, and empties the device once they were", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    device.stored.set("fiala.reminders.names", "true");
    device.stored.set("fiala.guide.recentMedicines", '[{"id":"a","title":"Parol"}]');
    device.stored.set("fiala.guide.place", '{"province":"İzmir","district":null}');
    useSession.setState({ userId: null });

    expect(await session().signIn(B.email, B.password)).toBe(tr.auth.errOtherAccountPending);
    expect(device.stored.get("fiala.reminders.names"), "A's opt-in, while A's rows wait").toBe("true");
    expect(cloud.calls).toContain("signOut:local");
    expect(session().userId).toBeNull();
    expect(rows()).toBe(1);

    sent();
    expect(await session().signIn(B.email, B.password)).toBeNull();
    expect(rows()).toBe(0);
    expect(count("outbox"), "B's own sign-in, its flag and its device, and nothing of A's").toBe(2);
    expect(device.stored.get(OWNER)).toBe(B.id);
    expect(device.cancelled, "A's reminders, with A's rows").toBe(1);
    expect(device.stored.has("fiala.reminders.names"), "B has not let a lock screen name its medicines").toBe(false);
    expect(["fiala.guide.recentMedicines", "fiala.guide.place"].map((key) => device.stored.has(key)), "nor opened A's medicines, or chosen A's place").toEqual([false, false]);
  });

  it("refuses a sign-in whose ownership it could not record, or read", async () => {
    device.dropped.add(OWNER);
    expect(await session().signIn(A.email, A.password)).toBe(tr.auth.errWorkspaceOwner);
    expect(session().userId).toBeNull();
    expect(cloud.calls).toEqual(["signOut:local"]);
    // A read that fails is not "no owner", the answer that would skip the
    // wipe and hand one account's rows to the next.
    device.dropped.clear();
    await session().signIn(A.email, A.password);
    await makeRow();
    sent();
    useSession.setState({ userId: null });
    device.readFailsOnce.add(OWNER);
    expect(await session().signIn(B.email, B.password)).toBe(tr.auth.errWorkspaceOwner);
    expect([rows(), device.stored.get(OWNER)]).toEqual([1, A.id]);
  });

  it("opens the account though the device will not remember it, which then cannot reopen offline", async () => {
    device.failing.add(LAST_USER).add(LAST_EMAIL).add("fiala.login.");
    expect(await session().signIn(A.email, A.password)).toBeNull();
    expect(session()).toMatchObject({ userId: A.id, email: A.email, previousLoginAt: null });

    useSession.setState({ userId: null, ready: false });
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: A.id, previousLoginAt: null });

    useSession.setState({ userId: null, ready: false });
    cloud.session = null;
    cloud.sessionError = { name: "AuthRetryableFetchError", message: "Failed to fetch" };
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: null });
  });

  it("writes this device's sign-in to the account, with the one before it", async () => {
    await session().signIn(A.email, A.password);
    const first = session().previousLoginAt;
    useSession.setState({ userId: null });
    await session().signIn(A.email, A.password);
    const device = await deviceId(harnessKv);
    const [row] = (await readSettings()).filter(({ key }) => key === `login.${device}`);
    expect(JSON.parse(row!.value)).toMatchObject({ previous: expect.any(String), device: "iPhone" });
    expect(lastLogin(await readSettings(), device)).toMatchObject({ here: true, at: JSON.parse(row!.value).previous });
    expect(first).toBeNull();
  });

  it("names a wrong password in Turkish", async () => {
    expect(await session().signIn(A.email, "yanlis-parola")).toBe(tr.auth.errInvalidCredentials);
  });
});

describe("opening the app", () => {
  it("opens a live session's own workspace; opening is a sign-in, so previous is the open before", async () => {
    cloud.session = { user: { id: A.id, email: A.email, last_sign_in_at: "2026-09-26T09:00:00.000Z" } };
    device.stored.set(OWNER, A.id);
    device.stored.set(`fiala.login.current.${A.id}`, "2026-09-25T08:00:00.000Z");
    device.stored.set(`fiala.login.previous.${A.id}`, "2026-09-24T08:00:00.000Z");
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: A.id, email: A.email, previousLoginAt: "2026-09-25T08:00:00.000Z" });
    expect(sync.calls).toEqual([`start:${A.id}`]);
    expect(device.stored.get(`fiala.login.previous.${A.id}`)).toBe("2026-09-25T08:00:00.000Z");
    expect(device.stored.get(`fiala.login.current.${A.id}`)).not.toBe("2026-09-25T08:00:00.000Z");
  });

  it("advances on every cold start, but not twice in one launch after a sign-in", async () => {
    cloud.session = { user: { id: A.id, email: A.email, last_sign_in_at: "2026-09-26T09:00:00.000Z" } };
    device.stored.set(OWNER, A.id);
    await session().bootstrap();
    const first = device.stored.get(`fiala.login.current.${A.id}`);
    expect(session().previousLoginAt, "a first open has no open before it").toBeNull();
    useSession.setState({ userId: null, ready: false });
    await new Promise((r) => setTimeout(r, 5));
    await session().bootstrap();
    expect(session().previousLoginAt).toBe(first);
    const second = device.stored.get(`fiala.login.current.${A.id}`);
    await session().bootstrap();
    expect(device.stored.get(`fiala.login.current.${A.id}`), "already open: no second record").toBe(second);
  });

  it("counts one opening when two starts overlap, as React's double effect makes them", async () => {
    cloud.session = { user: { id: A.id, email: A.email, last_sign_in_at: "2026-09-26T09:00:00.000Z" } };
    device.stored.set(OWNER, A.id);
    device.stored.set(`fiala.login.current.${A.id}`, "2026-09-25T08:00:00.000Z");
    await Promise.all([session().bootstrap(), session().bootstrap()]);
    expect(session().previousLoginAt, "not the overlapping start's own record").toBe("2026-09-25T08:00:00.000Z");
  });

  it("opens the last account offline, and nobody once Auth has refused the session", async () => {
    device.stored.set(OWNER, A.id);
    device.stored.set(LAST_USER, A.id);
    device.stored.set(LAST_EMAIL, A.email);
    cloud.sessionError = { name: "AuthRetryableFetchError", message: "Failed to fetch" };
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: A.id, email: A.email });
    expect(sync.calls, "offline too: it syncs once the network is back").toEqual([`start:${A.id}`]);

    useSession.setState({ userId: null, ready: false });
    cloud.sessionError = null;
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: null });
  });

  it("takes a client that throws for one that cannot reach Auth", async () => {
    device.stored.set(OWNER, A.id);
    device.stored.set(LAST_USER, A.id);
    cloud.throws = true;
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: A.id });
    // The revoke throws too, and the device still ends up signed out.
    expect(await session().signOut()).toBeNull();
    expect(session().userId).toBeNull();
    expect(cloud.calls).toEqual(["signOut:local", "signOut:local"]);
  });

  it("signs a session out whose workspace belongs to rows another account never sent", async () => {
    device.stored.set(OWNER, A.id);
    await makeRow();
    cloud.session = { user: { id: B.id, email: B.email } };
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: null });
    expect(cloud.calls).toEqual(["signOut:local"]);
  });

  it("runs on the device as one local account when the build has no Supabase, adopting nothing", async () => {
    cloud.configured = false;
    await session().bootstrap();
    expect(session()).toMatchObject({ ready: true, userId: LOCAL_USER_ID });
    expect(device.stored.has(OWNER)).toBe(false);
    expect(sync.calls, "with no server there is nothing to sync with").toEqual([]);
    for (const refused of [
      session().signIn(A.email, A.password),
      session().signUp(A.email, A.password).then((result) => result.status === "error" && result.message),
      session().requestPasswordReset(A.email),
      session().confirmSignUp(A.email, "123456"),
      session().resendSignUpCode(A.email),
      session().resetPassword(A.email, "123456", "yeni-parola1"),
      session().signOut({ force: true }),
      session().deleteAccount(),
      session().verifyPassword(A.password),
      session().changeEmail(A.email),
      session().changePassword(A.password, "yeni-parola1"),
      session().signOutOthers(),
    ]) {
      expect(await refused).toBe(tr.auth.errNotConfigured);
    }
  });

  it("keeps what was never sent behind sign-in when Supabase ends the session by itself", async () => {
    await session().bootstrap();
    await session().signIn(A.email, A.password);
    await makeRow();
    for (const listener of cloud.listeners) listener("SIGNED_OUT");
    await settle();
    expect(session().userId).toBeNull();
    expect(sync.calls).toEqual([`start:${A.id}`, "stop"]);
    expect(rows()).toBe(1);
    expect(device.stored.has(LAST_USER)).toBe(false);
    expect(device.stored.get(OWNER)).toBe(A.id);
    expect(device.cancelled, "the rows wait behind sign-in, not on the lock screen").toBe(1);

    for (const listener of cloud.listeners) listener("TOKEN_REFRESHED");
    await session().signIn(A.email, A.password);
    expect(rows()).toBe(1);
  });

  it("empties the device when Supabase ends a session whose rows the server already holds", async () => {
    await session().bootstrap();
    await session().signIn(A.email, A.password);
    await makeRow();
    sent();
    for (const listener of cloud.listeners) listener("SIGNED_OUT");
    await vi.waitFor(() => expect(rows()).toBe(0));
    expect(session().userId).toBeNull();
    for (const key of [OWNER, LAST_USER, LAST_EMAIL]) expect(device.stored.has(key)).toBe(false);
  });
});

describe("creating an account", () => {
  it("opens a new account at once when Auth gives it a session, with no sign-in before", async () => {
    expect(await session().signUp("c@ev.com", "yeni-parola1")).toEqual({ status: "signed-in" });
    expect(session()).toMatchObject({ userId: "u-c@ev.com", email: "c@ev.com", previousLoginAt: null });
    expect(device.stored.get(OWNER)).toBe("u-c@ev.com");
  });

  it("waits for the address to be confirmed, and refuses a short password before asking", async () => {
    cloud.signUpSession = false;
    expect(await session().signUp("c@ev.com", "yeni-parola1")).toEqual({ status: "confirmation-required" });
    expect(session().userId).toBeNull();
    expect(await session().signUp("d@ev.com", "kisa")).toEqual({ status: "error", message: tr.auth.errWeakPassword });
    expect(cloud.users.map((user) => user.email)).not.toContain("d@ev.com");
    cloud.signUpError = { message: "User already registered" };
    expect(await session().signUp(A.email, "yeni-parola1")).toEqual({ status: "error", message: tr.auth.errUserExists });
  });

  it("opens the account with the code the e-mail carries, telling a refused code from a dropped connection", async () => {
    cloud.signUpSession = false;
    await session().signUp("c@ev.com", "yeni-parola1");
    cloud.verifyError = { name: "AuthApiError", message: "Token has expired or is invalid" };
    expect(await session().confirmSignUp("c@ev.com", "000000")).toBe(tr.auth.errCode);
    cloud.verifyError = { name: "AuthRetryableFetchError", message: "Failed to fetch" };
    expect(await session().confirmSignUp("c@ev.com", "123456")).toBe(tr.auth.errNetwork);
    cloud.verifyError = { name: "AuthApiError", message: "Too many requests" };
    expect(await session().confirmSignUp("c@ev.com", "123456")).toBe(tr.auth.errRateLimit);
    expect(session().userId).toBeNull();
    cloud.verifyError = null;
    expect(await session().confirmSignUp(" c@ev.com ", "123456")).toBeNull();
    expect(cloud.calls.at(-1), "a reset code is no sign-up code").toBe("verifyOtp:c@ev.com:123456:signup");
    expect(session()).toMatchObject({ userId: "u-c@ev.com", email: "c@ev.com", previousLoginAt: null, operation: null });
    expect(device.stored.get(OWNER)).toBe("u-c@ev.com");
    expect(sync.calls).toEqual(["start:u-c@ev.com"]);
  });

  it("mails the sign-up code again on asking", async () => {
    expect(await session().resendSignUpCode(" c@ev.com ")).toBeNull();
    expect(cloud.calls).toEqual(["resend:signup:c@ev.com"]);
    cloud.resetError = { message: "Email rate limit exceeded" };
    expect(await session().resendSignUpCode("c@ev.com")).toBe(tr.auth.errRateLimit);
  });
});

describe("signing out", () => {
  it("sends what is waiting first, and then has nothing to ask", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    sync.flushSends = true;
    expect(await session().signOut()).toBeNull();
    expect(sync.calls, "sync stops before the device is emptied under it").toEqual([`start:${A.id}`, "flush", "stop"]);
    expect(rows()).toBe(0);
  });

  it("asks before destroying what could not be sent, then empties the device", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    device.stored.set("fiala.reminders.names", "true");
    device.stored.set("fiala.guide.starredMedicines", '[{"id":"a","title":"Parol"}]');
    expect(await session().signOut()).toBe(SIGN_OUT_PENDING_CHANGES);
    expect(session().userId).toBe(A.id);
    expect(rows()).toBe(1);

    expect(await session().signOut({ force: true })).toBeNull();
    expect(session().userId).toBeNull();
    expect([rows(), count("outbox")]).toEqual([0, 0]);
    // Only this device: the phone stays signed in when the web signs out.
    expect(cloud.calls).toEqual(["signOut:local"]);
    for (const key of [OWNER, LAST_USER, LAST_EMAIL]) expect(device.stored.has(key)).toBe(false);
    expect(device.cancelled).toBe(1);
    // With the owner mark gone, the next account's sign-in sees no switch to forget them at.
    expect(["fiala.reminders.names", "fiala.guide.starredMedicines"].map((key) => device.stored.has(key)), "A's opt-in and A's stars").toEqual([false, false]);
  });

  it("keeps everything, the account still signed in, when the device cannot be emptied", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    harness.db!.exec("CREATE TRIGGER stuck BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const waiting = count("outbox");
    expect(await session().signOut({ force: true })).toBe(tr.auth.errWorkspaceReset);
    expect(session().userId).toBe(A.id);
    expect([rows(), count("outbox")]).toEqual([1, waiting]);
    expect(cloud.calls).toEqual([]);
    expect(sync.calls.at(-1), "still signed in, so still syncing").toBe(`start:${A.id}`);

    // Nor does another account's sign-in go ahead over rows it could not clear.
    useSession.setState({ userId: null });
    sent();
    expect(await session().signIn(B.email, B.password)).toBe(tr.auth.errWorkspaceReset);
    expect(device.stored.get(OWNER)).toBe(A.id);
  });

  it("signs out without asking when nothing is waiting", async () => {
    await session().signIn(A.email, A.password);
    sent();
    useSyncStatus.getState().set({ state: "idle", error: null, lastSyncAt: "2026-10-04T10:00:00.000Z" });
    expect(await session().signOut()).toBeNull();
    expect(session().userId).toBeNull();
    expect(pulledOnce(useSyncStatus.getState()), "the emptied copy has pulled nothing yet").toBe(false);
  });
});

describe("freezing the account", () => {
  const frozenSent = () => sync.sent.filter((payload) => payload.key === "account_frozen").map((payload) => payload.value);

  it("locks nothing until the device knows, and opens the app on a read that failed", () => {
    const frozen = [{ key: "account_frozen", value: "true" }];
    expect(frozenFrom({ data: [], status: "loading", updatedAt: undefined })).toBeNull();
    expect(frozenFrom({ data: frozen, status: "ready", updatedAt: new Date() })).toBe(true);
    expect(frozenFrom({ data: [{ key: "account_frozen", value: "false" }], status: "stale", updatedAt: new Date() })).toBe(false);
    expect(frozenFrom({ data: [], status: "error", updatedAt: undefined })).toBe(false);
  });

  it("sends the freeze with everything else, then signs out", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    sync.flushSends = true;
    expect(await session().freezeAccount()).toBeNull();
    expect(frozenSent().at(-1)).toBe("true");
    expect(session()).toMatchObject({ userId: null, operation: null });
    expect(rows()).toBe(0);
  });

  it("freezes nothing, and keeps the account open, when what waits cannot be sent", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    expect(await session().freezeAccount()).toBe(tr.account.freezeSyncFailed);
    expect(session()).toMatchObject({ userId: A.id, operation: null });
    expect(isFrozen(await readSettings())).toBe(false);
    expect(rows()).toBe(1);
  });

  it("puts the flag back when the device cannot be emptied, and says why", async () => {
    await session().signIn(A.email, A.password);
    sync.flushSends = true;
    harness.db!.exec("CREATE TRIGGER stuck BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    await makeRow();
    sent();
    expect(await session().freezeAccount()).toBe(tr.auth.errWorkspaceReset);
    expect(isFrozen(await readSettings())).toBe(false);
  });

  it("puts the flag back when the sign-out fails outright", async () => {
    await session().signIn(A.email, A.password);
    sync.onFlush = () => {
      throw new Error("Failed to fetch");
    };
    expect(await session().freezeAccount()).toBe(tr.account.freezeSyncFailed);
    expect(session()).toMatchObject({ userId: A.id, operation: null });
    expect(isFrozen(await readSettings())).toBe(false);
  });

  it("says so when the flag cannot be put back, since every launch here opens on the lock", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    sync.onFlush = () => harness.db!.exec("CREATE TRIGGER stuck BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    expect(await session().freezeAccount()).toBe(tr.account.freezeRollbackFailed);
    expect(isFrozen(await readSettings())).toBe(true);
  });

  it("has nothing to freeze while signed out", async () => {
    expect(await session().freezeAccount()).toBe(tr.auth.errNotConfigured);
  });

  it("holds the gate back on this device while it freezes", async () => {
    await session().signIn(A.email, A.password);
    sync.flushSends = true;
    let during: string | null | undefined;
    sync.onFlush = () => (during = session().operation);
    await session().freezeAccount();
    expect(during, "its own sign-out stays a freeze").toBe("freeze");
  });

  it("names each account operation while it runs, and nothing after", async () => {
    let during: string | null | undefined;
    sync.onFlush = () => (during = session().operation);
    await session().signIn(A.email, A.password);
    await session().signOut();
    expect(during).toBe("sign-out");
    expect(session().operation).toBeNull();
    const signing = session().signIn(A.email, A.password);
    expect(session().operation).toBe("sign-in");
    await signing;
    expect(session().operation).toBeNull();
  });

  it("is reopened by signing in, which is the password check", async () => {
    await session().signIn(A.email, A.password);
    await setAccountFrozen(true);
    useSession.setState({ userId: null });
    await session().signIn(A.email, A.password);
    expect(isFrozen(await readSettings())).toBe(false);
  });
});

describe("deleting the account", () => {
  it("deletes nothing on the device when the server could not delete the account", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    cloud.rpcError = { message: "Failed to fetch" };
    expect(await session().deleteAccount()).toBe(tr.account.deleteCloudFailed);
    cloud.rpcError = { message: "JWT expired" };
    expect(await session().deleteAccount()).toBe(tr.auth.errSessionExpired);
    expect(session().userId).toBe(A.id);
    expect(rows()).toBe(1);
    expect(sync.calls.at(-1), "and syncs again, the photos it took down sent back").toBe(`start:${A.id}`);
  });

  it("deletes nothing when the account's photos could not be taken down first", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    sync.purgeFails = true;
    expect(await session().deleteAccount()).toBe(tr.account.deleteCloudFailed);
    expect(cloud.calls).toEqual(["photos:purge"]);
    expect(session().userId).toBe(A.id);
    expect(rows()).toBe(1);
  });

  it("then empties the device and ends every session the account had", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    expect(await session().deleteAccount()).toBeNull();
    expect(sync.calls).toEqual([`start:${A.id}`, "stop"]);
    expect(cloud.calls).toEqual(["photos:purge", "documents:purge", "rpc:delete_own_account", "signOut:global", "signOut:local"]);
    expect(session().userId).toBeNull();
    expect(rows()).toBe(0);
    for (const key of [OWNER, LAST_USER, LAST_EMAIL]) expect(device.stored.has(key)).toBe(false);
    expect(device.cancelled).toBe(1);
  });

  it("leaves a device it could not empty to be emptied by whoever signs in next", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    harness.db!.exec("CREATE TRIGGER stuck BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    expect(await session().deleteAccount()).toBe(tr.account.deleteWipeFailed);
    expect(session().userId).toBeNull();
    expect(rows()).toBe(1);
    harness.db!.exec("DROP TRIGGER stuck");
    // Nobody is left to send the deleted account's rows to, so they never block the next one.
    expect(await session().signIn(B.email, B.password)).toBeNull();
    expect(rows()).toBe(0);
    expect(device.stored.get(OWNER)).toBe(B.id);
  });

  it("never leaves that device ownerless when the marker cannot be written", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    harness.db!.exec("CREATE TRIGGER stuck BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    device.dropped.add(OWNER);
    expect(await session().deleteAccount()).toBe(tr.account.deleteWipeFailed);
    expect(device.stored.get(OWNER)).toBe(A.id);
    harness.db!.exec("DROP TRIGGER stuck");
    device.dropped.clear();
    expect(await session().signIn(B.email, B.password)).toBe(tr.auth.errOtherAccountPending);
    expect(session().userId).toBeNull();
  });
});

describe("changing the e-mail address", () => {
  const NEW = "yeni@ev.com";
  /** Signed in as A, with a change to NEW asked and its two codes mailed. */
  async function asked(owed: [string, string][] = [[A.email, "111111"], [NEW, "222222"]]) {
    expect(await session().signIn(A.email, A.password)).toBeNull();
    expect(await session().changeEmail(` ${NEW} `)).toBeNull();
    cloud.emailChange = { to: NEW, owed: new Map(owed) };
    cloud.calls = [];
  }
  const checked = () => cloud.calls.filter((call) => call.endsWith(":email_change"));

  it("makes the change once both codes are in, the new address's first", async () => {
    await asked();
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "222222" })).toEqual({ error: null, accepted: { current: true, next: true } });
    expect(checked()).toEqual([`verifyOtp:${NEW}:222222:email_change`, `verifyOtp:${A.email}:111111:email_change`]);
    expect(session().email).toBe(NEW);
    expect(device.stored.get(LAST_EMAIL), "an offline start reopens the account under its new address").toBe(NEW);
  });

  it("says which code was refused, and does not check again the one Auth took", async () => {
    await asked();
    expect(await session().confirmEmailChange(NEW, { current: "999999", next: "222222" })).toEqual({ error: tr.account.emailCodeRefused.current, accepted: { current: false, next: true } });
    expect(session().email).toBe(A.email);
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "" })).toMatchObject({ error: null });
    expect(checked()).toEqual([`verifyOtp:${NEW}:222222:email_change`, `verifyOtp:${A.email}:999999:email_change`, `verifyOtp:${A.email}:111111:email_change`]);
    await asked();
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "000000" })).toMatchObject({ error: tr.account.emailCodeRefused.next, accepted: { current: false, next: false } });
  });

  it("starts over when the codes are asked for again, or for another address", async () => {
    await asked();
    await session().confirmEmailChange(NEW, { current: "999999", next: "222222" });
    expect(await session().changeEmail(NEW)).toBeNull();
    cloud.emailChange = { to: NEW, owed: new Map([[A.email, "333333"], [NEW, "444444"]]) };
    expect(await session().confirmEmailChange(NEW, { current: "333333", next: "444444" })).toMatchObject({ error: null });
    expect(checked().slice(-2), "fresh codes replace every one already taken").toEqual([`verifyOtp:${NEW}:444444:email_change`, `verifyOtp:${A.email}:333333:email_change`]);
  });

  it("keeps the codes Auth took when a resend is refused", async () => {
    await asked();
    await session().confirmEmailChange(NEW, { current: "999999", next: "222222" });
    cloud.updateError = { message: "For security purposes, you can only request this after 60 seconds." };
    expect(await session().changeEmail(NEW)).not.toBeNull();
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "" })).toMatchObject({ error: null });
  });

  it("calls the change made only on Auth's session, and starts over when Auth did", async () => {
    await asked();
    await session().confirmEmailChange(NEW, { current: "999999", next: "222222" });
    // Asked again in another tab: Auth owes both codes anew, this device still holds one as taken.
    cloud.emailChange = { to: NEW, owed: new Map([[A.email, "333333"], [NEW, "444444"]]) };
    expect(await session().confirmEmailChange(NEW, { current: "333333", next: "" })).toEqual({ error: tr.account.emailChangeRestarted, accepted: { current: false, next: false } });
    expect(session().email).toBe(A.email);
    expect(await session().confirmEmailChange(NEW, { current: "", next: "444444" })).toMatchObject({ error: tr.account.emailCodeRefused.current });
  });

  it("tells a dropped connection from a refused code, and changes nothing on either", async () => {
    await asked();
    cloud.verifyError = { name: "AuthRetryableFetchError", message: "Failed to fetch" };
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "222222" })).toEqual({ error: tr.auth.errNetwork, accepted: { current: false, next: false } });
    expect(session().email).toBe(A.email);
  });

  it("asks for a sign-in with no account open, and says when there is no project", async () => {
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "222222" })).toMatchObject({ error: tr.auth.errSessionExpired });
    cloud.configured = false;
    expect(await session().confirmEmailChange(NEW, { current: "111111", next: "222222" })).toMatchObject({ error: tr.auth.errNotConfigured });
    expect(checked()).toEqual([]);
  });
});

describe("checking the password again", () => {
  it("says a wrong password plainly, and pauses after a run of them", async () => {
    await session().signIn(A.email, A.password);
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) expect(await session().verifyPassword("yanlis")).toBe(tr.account.wrongPassword);
    expect(await session().verifyPassword(A.password)).toBe(tr.auth.errRateLimit);
    vi.useFakeTimers({ now: Date.now() + VERIFY_COOLDOWN_MS, toFake: ["Date"] });
    expect(await session().verifyPassword(A.password)).toBeNull();
    vi.useRealTimers();
  });

  it("finds the address when the app opened offline, and accepts the right password", async () => {
    await session().signIn(A.email, A.password);
    useSession.setState({ email: null });
    expect(await session().verifyPassword(A.password)).toBeNull();
    expect(session().email).toBe(A.email);
  });

  it("ends a session the check opened for another account, keeping the rows for this one", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    useSession.setState({ email: B.email });
    expect(await session().verifyPassword(B.password)).toBe(tr.auth.errSessionExpired);
    expect(cloud.calls).toEqual(["signOut:local"]);
    expect(session().userId).toBeNull();
    expect(device.stored.get(OWNER)).toBe(A.id);
    expect(await session().signIn(A.email, A.password)).toBeNull();
    expect(rows()).toBe(1);
  });

  it("changes the password with the current one, and the address trimmed", async () => {
    await session().signIn(A.email, A.password);
    expect(await session().changePassword(A.password, "kisa")).toBe(tr.auth.errWeakPassword);
    expect(await session().changePassword(A.password, "yeni-parola1")).toBeNull();
    expect(await session().changeEmail("  yeni@ev.com ")).toBeNull();
    expect(cloud.calls.slice(-2)).toEqual(["updateUser:current_password,password", "updateUser:email"]);
    cloud.updateError = { message: "New password should be different from the old password." };
    expect(await session().changePassword(A.password, A.password)).toBe(tr.auth.errSamePassword);
    cloud.updateError = { message: "Email rate limit exceeded" };
    expect(await session().changeEmail("yeni@ev.com")).toBe(tr.auth.errRateLimit);
  });

  it("ends the account's other sessions and keeps this one, with its data", async () => {
    await session().signIn(A.email, A.password);
    await makeRow();
    cloud.calls.length = 0;
    expect(await session().signOutOthers()).toBeNull();
    expect(cloud.calls).toEqual(["signOut:others"]);
    expect(session().userId).toBe(A.id);
    expect(rows()).toBe(1);
  });

  it("asks for a new sign-in when no address is known anywhere", async () => {
    await session().signIn(A.email, A.password);
    useSession.setState({ email: null });
    cloud.session = null;
    device.stored.delete(LAST_EMAIL);
    expect(await session().verifyPassword(A.password)).toBe(tr.auth.errSessionExpired);
  });
});

describe("a forgotten password", () => {
  it("mails a code, and says the same for an address with no account", async () => {
    expect(await session().requestPasswordReset("  a@ev.com ")).toBeNull();
    expect(cloud.calls, "a code needs no page to come back to").toEqual(["reset:a@ev.com"]);
    cloud.resetError = { message: "User not found" };
    expect(await session().requestPasswordReset("x@ev.com")).toBeNull();
    cloud.resetError = { message: "User with this address was not found" };
    expect(await session().requestPasswordReset("x@ev.com")).toBeNull();
    cloud.resetError = { message: "Email rate limit exceeded" };
    expect(await session().requestPasswordReset("a@ev.com")).toBe(tr.auth.errRateLimit);
  });

  it("sets the new password with the code on a client of its own, signing nobody in", async () => {
    expect(await session().resetPassword("a@ev.com", "123456", "kisa")).toBe(tr.auth.errWeakPassword);
    expect(cloud.calls, "a short password spends no code").toEqual([]);
    cloud.updateError = { message: "New password should be different from the old password." };
    expect(await session().resetPassword("a@ev.com", "123456", "eski-parola1")).toBe(tr.auth.errSamePassword);
    cloud.updateError = null;
    expect(await session().resetPassword(" a@ev.com ", "000000", "yeni-parola1")).toBeNull();
    expect(cloud.calls, "a refused save keeps the code it already spent").toEqual([
      "recovery:verifyOtp:a@ev.com:123456:recovery", "recovery:updateUser",
      "recovery:updateUser", "recovery:signOut:local",
    ]);
    expect(cloud.savedPassword).toBe("yeni-parola1");
    expect(session().userId).toBeNull();
    await session().resetPassword("a@ev.com", "654321", "yeni-parola2");
    expect(cloud.calls.at(-3), "a saved password spends the kept client").toBe("recovery:verifyOtp:a@ev.com:654321:recovery");
  });

  it("checks a fresh code once another is asked for, or for another address", async () => {
    cloud.updateError = { message: "New password should be different from the old password." };
    await session().resetPassword("a@ev.com", "123456", "eski-parola1");
    await session().resetPassword("b@ev.com", "222222", "eski-parola1");
    await session().requestPasswordReset("a@ev.com");
    cloud.updateError = null;
    await session().resetPassword("a@ev.com", "333333", "yeni-parola1");
    expect(cloud.calls.filter((call) => call.startsWith("recovery:verifyOtp"))).toEqual([
      "recovery:verifyOtp:a@ev.com:123456:recovery",
      "recovery:verifyOtp:b@ev.com:222222:recovery",
      "recovery:verifyOtp:a@ev.com:333333:recovery",
    ]);
  });

  it("keeps the checked code when a resend is refused", async () => {
    cloud.updateError = { message: "New password should be different from the old password." };
    await session().resetPassword("a@ev.com", "123456", "eski-parola1");
    cloud.resetError = { message: "For security purposes, you can only request this after 60 seconds." };
    expect(await session().requestPasswordReset("a@ev.com")).not.toBeNull();
    cloud.updateError = null;
    expect(await session().resetPassword("a@ev.com", "123456", "yeni-parola1")).toBeNull();
    expect(cloud.calls.filter((call) => call.startsWith("recovery:verifyOtp"))).toEqual(["recovery:verifyOtp:a@ev.com:123456:recovery"]);
  });

  it("says the password is saved when signing in again with it fails", async () => {
    expect(await session().signIn(A.email, A.password)).toBeNull();
    expect(await session().resetPassword(A.email, "123456", "yeni-parola1")).toBe(tr.auth.passwordResetSignInAgain);
  });

  it("signs this device in again when it reset its own account, whose sessions the new password ended", async () => {
    const renewed = { ...A };
    cloud.users = [renewed, B];
    expect(await session().signIn(A.email, A.password)).toBeNull();
    // Reopened offline, the device holds the address as it was typed.
    useSession.setState({ email: "A@EV.com" });
    renewed.password = "yeni-parola1";
    expect(await session().resetPassword("a@Ev.com", "123456", "yeni-parola1")).toBeNull();
    expect(session()).toMatchObject({ userId: A.id, email: A.email });
    expect(cloud.session?.user.email, "the main client holds a session the reset did not revoke").toBe(A.email);
    cloud.session = { user: { id: A.id, email: A.email, last_sign_in_at: "2026-09-26T09:00:00.000Z" } };
    expect(await session().resetPassword(B.email, "123456", "baska-parola1"), "another account's reset leaves this one alone").toBeNull();
    expect(session().userId).toBe(A.id);
  });

  it("tells a refused code from a dropped connection, and saves nothing on either", async () => {
    cloud.verifyError = { name: "AuthRetryableFetchError", message: "Failed to fetch" };
    expect(await session().resetPassword("a@ev.com", "123456", "yeni-parola1")).toBe(tr.auth.errNetwork);
    cloud.verifyError = { name: "AuthApiError", message: "Token has expired or is invalid", code: "otp_expired" };
    expect(await session().resetPassword("a@ev.com", "123456", "yeni-parola1")).toBe(tr.auth.errCode);
    expect(cloud.calls.filter((call) => call === "recovery:updateUser")).toEqual([]);
  });
});

