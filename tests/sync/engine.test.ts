/**
 * Sync end to end: two devices of one person, each a real SQLite database
 * under the real migrations and write layer, through the shipped engine,
 * against `fake-cloud.ts` — which keeps the server's clock, its delete
 * generations and its row rules. Only the network is a stand-in. The rows are
 * settings, the one entity the shell syncs; what holds for them holds for the
 * tables a feature adds.
 *
 * The rule the outbox keeps: a row leaves it only when the server
 * has said it has it, under the session that sent it.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCloud } from "./fake-cloud";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null, cloud: null as unknown as { client(): unknown }, version: "1.4.1", kv: new Map<string, string>(), update: "SELECT 1" }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});
vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);
// The update's own migration is the test's; what `migrateDb` does after any is the code's.
vi.mock("../../src/db/migrations/migrations", () => ({ default: { journal: { entries: [{ idx: 0, when: 1, tag: "update" }] }, migrations: { get m0000() { return harness.update; } } } }));
vi.mock("../../src/sync/supabase", () => ({ getSupabase: () => harness.cloud.client() }));
vi.mock("../../src/services/kv", () => ({
  kv: {
    get: async (key: string) => harness.kv.get(key) ?? null,
    set: async (key: string, value: string) => void harness.kv.set(key, value),
    remove: async (key: string) => void harness.kv.delete(key),
  },
}));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { version: harness.version };
    },
  },
}));

const { isFrozen, readSettings, setAccountFrozen, writeSetting } = await import("../../src/data/settings");
const { deleteRows, pendingOutboxCount, undoRows, writeRows } = await import("../../src/db/mutations");
const { flushOutbox, scheduleSync, startSyncSession, stopSyncSession, syncNow } = await import("../../src/sync/engine");
const { dismissDeadLetter, readDeadLetters, retryDeadLetter } = await import("../../src/sync/dead-letters");
const { pulledOnce, useSyncStatus } = await import("../../src/sync/status");
const { tr } = await import("../../src/i18n/tr");
const { migratedDatabase } = await import("../helpers");
const { migrateDb } = await import("../../src/db/migrate");
const { deterministicId, naturalKeys } = await import("../../src/db/ids");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let cloud: FakeCloud;
let devices: { A: DatabaseSync; B: DatabaseSync; C: DatabaseSync };
/** A and B are one person's two devices; C is another person's. */
const OWNER_OF = { A: USER, B: USER, C: OTHER } as const;

/** Work on one device, its sync session open for the length of it, as the app holds one while signed in. */
async function on<T>(device: keyof typeof devices, work: () => Promise<T>): Promise<T> {
  harness.db = devices[device];
  cloud.user = signedIn = OWNER_OF[device];
  startSyncSession(signedIn);
  try {
    return await work();
  } finally {
    await stopSyncSession();
  }
}

let signedIn = USER;
const sync = () => syncNow(signedIn);
const idOf = (key: string) => deterministicId(naturalKeys.setting(key));
const put = (key: string, value: unknown) => writeSetting(key, value);
const valueOf = async (key: string) => {
  const found = (await readSettings()).find((setting) => setting.key === key);
  return found ? (JSON.parse(found.value) as unknown) : undefined;
};
const serverRow = (id: string) => cloud.rows("settings").find((row) => row.id === id);
/** A value the server refuses, whatever the person is: it holds a setting of 10,000 characters at most. */
const TOO_LONG = "x".repeat(10_001);
/** Delete a setting, as a feature's delete would, and take it back. */
const deleteAndRestore = async (id: string) => undoRows((await deleteRows("settings", [id]))!);

beforeEach(() => {
  cloud = new FakeCloud();
  cloud.user = USER;
  harness.cloud = cloud;
  harness.version = "1.4.1";
  harness.update = "SELECT 1";
  devices = { A: migratedDatabase(), B: migratedDatabase(), C: migratedDatabase() };
  useSyncStatus.getState().set({ state: "idle", error: null, lastSyncAt: null });
});

describe("two devices of one person", () => {
  it("brings a setting from one to the other", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      expect(await sync()).toBe(true);
      expect(await pendingOutboxCount(), "what the server acknowledged has left the outbox").toBe(0);
    });
    expect(cloud.rows("settings").map((row) => row.user_id), "a row is keyed by its person").toEqual([USER]);

    await on("B", async () => {
      expect(await sync()).toBe(true);
      expect(await valueOf("greeting")).toBe("merhaba");
      expect(useSyncStatus.getState()).toMatchObject({ state: "idle", error: null });
      expect(useSyncStatus.getState().lastSyncAt).not.toBeNull();
    });
  });

  it("does not show one person's setting to another", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
    });
    await on("C", async () => {
      expect(await sync()).toBe(true);
      expect(await readSettings()).toEqual([]);
    });
  });

  it("carries a frozen account to the person's other device, and its reopening back", async () => {
    await on("A", async () => {
      await setAccountFrozen(true);
      await sync();
    });
    await on("B", async () => {
      await sync();
      expect(isFrozen(await readSettings())).toBe(true);
      await setAccountFrozen(false);
      await sync();
    });
    await on("A", async () => {
      await sync();
      expect(isFrozen(await readSettings())).toBe(false);
    });
  });

  it("settles two edits on the server's clock: the later write wins on both", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
    });
    await on("B", sync);
    await on("A", async () => {
      await put("greeting", "selam");
      await sync();
    });
    await on("B", async () => {
      await put("greeting", "günaydın");
      await sync();
      expect(await valueOf("greeting")).toBe("günaydın");
    });
    await on("A", async () => {
      await sync();
      expect(await valueOf("greeting")).toBe("günaydın");
    });
  });

  it("keeps a delete over an edit from a device that never saw it", async () => {
    const id = await idOf("greeting");
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
    });
    await on("B", sync);
    await on("A", async () => {
      await deleteRows("settings", [id]);
      await sync();
    });
    await on("B", async () => {
      await put("greeting", "selam");
      await sync();
      expect(await valueOf("greeting"), "the stale edit did not bring it back").toBeUndefined();
      expect(await pendingOutboxCount()).toBe(0);
    });
    expect(serverRow(id)).toMatchObject({ tombstone_version: 1 });
    expect(serverRow(id)?.deleted_at).not.toBeNull();
  });

  it("puts a row made afresh, on a device that never saw it deleted, back", async () => {
    const id = await idOf("greeting");
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
      await deleteRows("settings", [id]);
      await sync();
    });
    await on("B", async () => {
      await put("greeting", "yeniden");
      await sync();
      expect(await valueOf("greeting"), "B's add is not lost to A's older delete").toBe("yeniden");
      expect(await pendingOutboxCount()).toBe(0);
    });
    await on("A", async () => {
      await sync();
      expect(await valueOf("greeting")).toBe("yeniden");
    });
    expect(serverRow(id)?.deleted_at).toBeNull();
  });

  it("pulls a row that committed late, at its table's next change", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
    });
    await on("B", sync);
    const late = "019f6bba-2c65-7ea8-a6c9-96d891155e99";
    cloud.insertLate("settings", { user_id: USER, id: late, key: "late", value: '"geç"' }, 400);
    await on("A", async () => {
      await put("greeting", "selam");
      await sync();
    });
    await on("B", async () => {
      await sync();
      expect(await valueOf("late")).toBe("geç");
    });
  });

  it("asks only whether anything moved when nothing did", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
      cloud.requests.length = 0;
      await sync();
    });
    expect(cloud.requests).toEqual(["rpc sync_cursors"]);
  });
});

describe("what the server will not take", () => {
  it("sets a refused row aside and sends the rest of its batch", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await put("big", TOO_LONG);
      expect(await sync()).toBe(true);
      expect(cloud.rows("settings").map((row) => row.key)).toEqual(["greeting"]);
      expect(await pendingOutboxCount()).toBe(0);
      expect(await readDeadLetters(), "named as the person knows it").toMatchObject([{ tableName: "settings", reason: "refused", subject: "big" }]);
      expect(useSyncStatus.getState()).toMatchObject({ state: "attention", error: null });
    });
  });

  it("sends a delete taken back, or made twice, before either reached the server", async () => {
    await on("A", async () => {
      await put("undone", 1);
      await put("twice", 2);
      const [undone, twice] = [await idOf("undone"), await idOf("twice")];
      await sync();
      // Only the newest event of a row is sent, so the server never sees the
      // generation these moved through.
      await deleteAndRestore(undone);
      await deleteAndRestore(twice);
      await deleteRows("settings", [twice]);
      expect(await sync()).toBe(true);
      expect(await readDeadLetters()).toEqual([]);
      expect(serverRow(undone)).toMatchObject({ deleted_at: null, tombstone_version: 0 });
      expect(serverRow(twice)).toMatchObject({ tombstone_version: 1 });
      expect(serverRow(twice)?.deleted_at).not.toBeNull();
      expect(await valueOf("undone")).toBe(1);
      expect(await valueOf("twice")).toBeUndefined();

      // The device is back at the server's generation, so its next write is taken at once.
      const before = cloud.requests.length;
      await put("undone", 3);
      await sync();
      expect(cloud.requests.slice(before).filter((request) => request === "upsert settings"), "no refusal to work around").toHaveLength(1);
      expect(serverRow(undone)?.value).toBe("3");
    });
  });

  it("does not bring back, by stepping down, a row another device deleted", async () => {
    const id = await idOf("greeting");
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
    });
    await on("B", async () => {
      await sync();
      await deleteRows("settings", [id]);
      await sync();
    });
    await on("A", async () => {
      // Offline, A never saw B's delete, and took back its own twice.
      await deleteAndRestore(id);
      await deleteAndRestore(id);
      await sync();
      expect(serverRow(id)?.deleted_at, "B's delete stands").not.toBeNull();
      expect(await valueOf("greeting")).toBeUndefined();
    });
  });

  it("keeps the row queued when the server cannot be asked which generation it holds", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      const id = await idOf("greeting");
      await sync();
      await deleteAndRestore(id);
      const release = cloud.hold("upsert settings");
      const running = sync();
      await vi.waitFor(() => expect(cloud.requests.at(-1)).toBe("upsert settings"));
      cloud.failures.push({ message: "Failed to fetch" });
      release();
      expect(await running, "the network, not a refusal").toBe(false);
      expect(await readDeadLetters()).toEqual([]);
      expect(await pendingOutboxCount()).not.toBe(0);
    });
  });

  it("sets aside an event it cannot read, and still sends the others", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      devices.A.prepare(
        "INSERT INTO outbox (table_name, row_id, op, payload, idempotency_key, created_at) VALUES ('settings', 'x', 'upsert', '{', 'broken', '2026-09-27')",
      ).run();
      await sync();
      expect(cloud.rows("settings")).toHaveLength(1);
      const letters = await readDeadLetters();
      expect(letters).toMatchObject([{ rowId: "x", reason: "malformed_payload", subject: null }]);
      expect(await retryDeadLetter(letters[0]!.id), "no row on the device to send").toBe("missing");
    });
  });

  it("sets aside a row the schema could not have written", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      const id = await idOf("odd");
      devices.A.prepare(
        "INSERT INTO outbox (table_name, row_id, op, payload, idempotency_key, created_at) VALUES ('settings', ?, 'upsert', ?, 'odd', '2026-09-27')",
      ).run(id, JSON.stringify({ id, key: "odd", value: "1", bogus: true }));
      expect(await sync()).toBe(true);
      expect(cloud.rows("settings").map((row) => row.key)).toEqual(["greeting"]);
      expect(await readDeadLetters()).toMatchObject([{ rowId: id, reason: "invalid_row", subject: "odd" }]);
    });
  });

  it("keeps a refused batch queued when one of its rows then meets the network", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await put("farewell", "hoşça kal");
      cloud.failures.push({ message: "refused", code: "23514" }, { message: "Failed to fetch" });
      expect(await sync()).toBe(false);
      expect(await readDeadLetters()).toEqual([]);
      expect(await pendingOutboxCount()).toBe(2);
    });
  });

  it("sets a row aside that the server's policy refuses, whatever else its batch holds", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failures.push({ message: 'new row violates row-level security policy for table "settings"', code: "42501" });
      expect(await sync()).toBe(true);
      expect(await readDeadLetters(), "refused alone, so set aside alone").toMatchObject([{ reason: "refused" }]);
      expect(await pendingOutboxCount()).toBe(0);
    });
  });

  it("does not treat a missing permission as a bad row", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failures.push({ message: "permission denied for table settings", code: "42501" });
      expect(await sync(), "a request with no signed-in role is a new session's to fix").toBe(false);
      expect(await readDeadLetters()).toEqual([]);
      expect(await pendingOutboxCount()).toBe(1);
    });
  });

  it("fails the sync and keeps the outbox when the server fails for another reason", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failures.push({ message: "upstream connect error", code: "XX000" });
      expect(await sync()).toBe(false);
      expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errGeneric });

      await put("big", TOO_LONG);
      const release = cloud.hold("upsert settings");
      const running = sync();
      await vi.waitFor(() => expect(cloud.requests).toContain("upsert settings"));
      cloud.failures.push({ message: "Failed to fetch" });
      release();
      expect(await running, "a row sent alone that meets the network, not a refusal").toBe(false);
      expect(await readDeadLetters()).toEqual([]);
      expect(await pendingOutboxCount()).toBe(2);
    });
  });

  it("pulls every table when the server cannot say what moved, and keeps its place when a pull fails", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
      cloud.requests.length = 0;
      cloud.failures.push({ message: "Could not find the function public.sync_cursors", code: "PGRST202" });
      expect(await sync()).toBe(true);
      expect(await sync()).toBe(true);
      expect(cloud.requests.filter((request) => request === "rpc sync_cursors"), "asked once this session").toHaveLength(1);
    });
    await on("A", async () => {
      cloud.failures.push({ message: "canceling statement due to statement timeout", code: "57014" });
      expect(await sync(), "a probe that fails otherwise fails the sync").toBe(false);
    });
    await on("B", async () => {
      cloud.failures.push({ message: "canceling statement due to statement timeout", code: "57014" });
      expect(await sync()).toBe(false);
      expect(await readSettings()).toEqual([]);
      expect(await sync()).toBe(true);
      expect(await valueOf("greeting")).toBe("merhaba");
    });
  });

  it("fails the sync, and keeps its place, when a table's pull fails", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failOn.set("select settings", { message: "connection reset", code: "08006" });
      expect(await sync()).toBe(false);
      expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errGeneric });
      expect(await sync()).toBe(true);
    });
  });

  it("pulls a table longer than one page", async () => {
    const rows = Array.from({ length: 1001 }, (_, at) => ({
      table: "settings" as const,
      row: { id: `019f6bba-2c65-7ea8-a6c9-${String(at).padStart(12, "0")}`, key: `k${at}`, value: String(at) },
    }));
    await on("A", async () => {
      await writeRows(rows);
      expect(await sync()).toBe(true);
    });
    await on("B", async () => {
      expect(await sync()).toBe(true);
      expect(await readSettings()).toHaveLength(1001);
    });
  });

  it("names a set-aside row by its key, and has nothing to send for a table this build does not know", async () => {
    await on("A", async () => {
      const insert = devices.A.prepare(
        "INSERT INTO sync_dead_letters (outbox_id, table_name, row_id, payload, reason, quarantined_at) VALUES (?, ?, ?, ?, ?, '2026-09-27T00:00:00.000Z')",
      );
      insert.run(1, "settings", "019f6bba-2c65-7ea8-a6c9-96d891155e04", '{"key":"greeting"}', "refused");
      insert.run(2, "baskets", "019f6bba-2c65-7ea8-a6c9-96d891155e05", '{"name":5}', "invalid_row");
      const letters = await readDeadLetters();
      expect(letters.map((letter) => letter.subject)).toEqual(["greeting", null]);
      expect(await retryDeadLetter(letters[1]!.id)).toBe("missing");
    });
  });

  it("sends a set-aside row again on a retry, forgets it once a newer version lands, and forgets the clue on a dismiss", async () => {
    await on("A", async () => {
      const id = await idOf("big");
      await put("big", TOO_LONG);
      await sync();
      const [letter] = await readDeadLetters();
      expect(await retryDeadLetter(letter!.id)).toBe("requeued");
      expect(await pendingOutboxCount()).toBe(1);
      await sync();
      expect(await readDeadLetters(), "refused again, set aside again").toMatchObject([{ rowId: id, reason: "refused" }]);

      await put("big", "short");
      await sync();
      expect(serverRow(id)?.value).toBe('"short"');
      expect(await readDeadLetters(), "the version it named is history").toEqual([]);
      expect(useSyncStatus.getState().state).toBe("idle");

      await put("big", TOO_LONG);
      await sync();
      const [again] = await readDeadLetters();
      await dismissDeadLetter(again!.id);
      expect(await readDeadLetters()).toEqual([]);
      expect(devices.A.prepare("SELECT key FROM settings WHERE id = ?").get(id), "the row itself stays").toEqual({ key: "big" });
      expect(await retryDeadLetter(again!.id)).toBe("missing");
    });
  });

  it("sends what an older version set aside once more after an update, and a refusal of its own only once", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      const id = await idOf("greeting");
      await sync();
      // A delete taken back, refused for its generation, set aside with nothing
      // left to send.
      await deleteAndRestore(id);
      devices.A.prepare("DELETE FROM outbox").run();
      devices.A.prepare(
        "INSERT INTO sync_dead_letters (outbox_id, table_name, row_id, payload, reason, quarantined_at) VALUES (1, 'settings', ?, '{}', 'refused', '2026-09-30T14:27:31.000Z')",
      ).run(id);
      await sync();
      expect(await readDeadLetters(), "this version has had its look").toHaveLength(1);

      harness.version = "1.4.2";
      expect(await sync()).toBe(true);
      expect(await readDeadLetters()).toEqual([]);
      expect(serverRow(id)).toMatchObject({ deleted_at: null, tombstone_version: 0 });
      expect(useSyncStatus.getState().state).toBe("idle");

      await put("big", TOO_LONG);
      await sync();
      const before = cloud.requests.length;
      await sync();
      expect(cloud.requests.slice(before), "not sent on every sync").not.toContain("upsert settings");
      expect(await readDeadLetters()).toMatchObject([{ reason: "refused" }]);
    });
  });
});

describe("the session", () => {
  it("sends nothing under another account's session", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.user = OTHER;
      expect(await sync()).toBe(false);
      cloud.user = null;
      expect(await sync(), "nor under none").toBe(false);
      expect(cloud.requests.some((request) => request.startsWith("upsert"))).toBe(false);
      expect(await pendingOutboxCount()).toBe(1);
      expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errReauth });
    });
  });

  it("keeps everything and says so when the session cannot be read", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.sessionFailure = { message: "Failed to fetch" };
      expect(await sync()).toBe(false);
      expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errNetwork });
      expect(await pendingOutboxCount()).toBe(1);
    });
  });

  it("renews an expired token and carries on without asking", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failures.push({ message: "JWT expired", code: "PGRST301" });
      await sync();
      await vi.waitFor(async () => expect(await pendingOutboxCount()).toBe(0));
      expect(useSyncStatus.getState().state).toBe("idle");
    });
  });

  it("renews once, and asks for a sign-in when the renewed token is refused too", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failures.push({ message: "JWT expired", code: "PGRST301" }, { message: "JWT expired", code: "PGRST301" });
      await sync();
      await vi.waitFor(() => expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errReauth }));
      expect(await pendingOutboxCount()).toBe(1);
    });
  });

  it("waits and tries again, asking nothing, when the renewal cannot reach Auth", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await on("A", async () => {
        await put("greeting", "merhaba");
        cloud.failures.push({ message: "JWT expired", code: "PGRST301" });
        cloud.refreshFailures.push({ message: "Failed to fetch", code: "AuthRetryableFetchError" });
        expect(await sync()).toBe(false);
        expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errNetwork });
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() => expect(useSyncStatus.getState().state).toBe("idle"));
        expect(await pendingOutboxCount()).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a sign-in once the session cannot be renewed, and keeps what is unsent", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      cloud.failures.push({ message: "JWT expired", code: "PGRST301" });
      cloud.refreshFailures.push({ message: "Invalid Refresh Token: Already Used" });
      await sync();
      expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: tr.sync.errReauth });
      expect(await pendingOutboxCount()).toBe(1);
    });
  });

  it("keeps the outbox when the session ends while the server is answering", async () => {
    harness.db = devices.A;
    startSyncSession(USER);
    await put("greeting", "merhaba");
    const release = cloud.hold("upsert settings");
    const running = sync();
    await vi.waitFor(() => expect(cloud.requests).toContain("upsert settings"));
    const stopping = stopSyncSession();
    release();
    await stopping;
    expect(await running).toBe(false);
    expect(cloud.rows("settings"), "the server took it").toHaveLength(1);
    expect(await pendingOutboxCount(), "but this session never heard so").toBe(1);
  });

  it("says nothing of a failure that reaches a session which has ended", async () => {
    harness.db = devices.A;
    startSyncSession(USER);
    await put("greeting", "merhaba");
    const release = cloud.hold("upsert settings");
    const running = sync();
    await vi.waitFor(() => expect(cloud.requests).toContain("upsert settings"));
    const stopping = stopSyncSession();
    cloud.failures.push({ message: "Failed to fetch" });
    useSyncStatus.getState().set({ state: "idle", error: null });
    release();
    await stopping;
    expect(await running).toBe(false);
    expect(useSyncStatus.getState(), "the next session starts from its own state").toMatchObject({ error: null });
  });

  it("reads an app with no version as one that has had no look yet", async () => {
    harness.version = undefined as unknown as string;
    await on("A", async () => {
      await put("greeting", "merhaba");
      expect(await sync()).toBe(true);
    });
  });

  it("keeps an edit made while its row's push was in flight, even when sending it fails", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      const release = cloud.hold("upsert settings");
      const running = sync();
      await vi.waitFor(() => expect(cloud.requests).toContain("upsert settings"));
      await put("greeting", "selam");
      cloud.failures.push({ message: "Failed to fetch" });
      release();
      expect(await running).toBe(false);
      expect(await valueOf("greeting"), "the answer for the older value did not put it back").toBe("selam");
      expect(await pendingOutboxCount()).toBe(1);
    });
  });

  it("does not let a pull put back a row whose newer edit is still to be sent", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      const release = cloud.hold("upsert settings");
      const running = sync();
      await vi.waitFor(() => expect(cloud.requests).toContain("upsert settings"));
      await put("greeting", "selam");
      release();
      await running;
      expect(await valueOf("greeting")).toBe("selam");
      await sync();
      expect(serverRow(await idOf("greeting"))?.value).toBe('"selam"');
    });
  });

  it("does nothing for an account whose session is not open, nor on a build with no server", async () => {
    harness.db = devices.A;
    await put("greeting", "merhaba");
    expect(await sync()).toBe(false);
    scheduleSync(USER);
    await flushOutbox(USER);
    expect(cloud.requests).toEqual([]);

    harness.cloud = { client: () => null };
    await on("A", async () => {
      expect(await sync()).toBe(true);
      await flushOutbox(USER);
    });
    expect(await pendingOutboxCount()).toBe(1);
  });

  it("runs one more pass for a write made while a sync was running", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      // Held while pulling, so its push has already emptied the outbox.
      const release = cloud.hold("select settings");
      const running = sync();
      await vi.waitFor(() => expect(cloud.requests).toContain("select settings"));
      await put("farewell", "hoşça kal");
      const joined = sync();
      release();
      expect(await joined, "the second call waits on the run under way").toBe(await running);
      expect(cloud.rows("settings")).toHaveLength(1);
      await vi.waitFor(() => expect(cloud.rows("settings"), "sooner than the write's own 1.5 s").toHaveLength(2), { timeout: 1000 });
    });
  });

  it("flushes the outbox without pulling, for a sign-out", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await flushOutbox(USER);
      expect(await pendingOutboxCount()).toBe(0);
      expect(cloud.requests.filter((request) => request.startsWith("select") || request.startsWith("rpc"))).toEqual([]);
    });
  });
});

/** A build before a column existed: it pulled the row without it, and the update adds it empty. */
async function downgradeWithoutDeletedAt() {
  devices.B.exec("ALTER TABLE settings DROP COLUMN deleted_at");
  harness.update = "ALTER TABLE settings ADD deleted_at text";
  await migrateDb();
}

describe("what one copy must not do to another's", () => {
  /** A setting A deleted, which B then pulls: the server holds a column B's build is about to lose. */
  async function deletedSetting() {
    const id = await idOf("greeting");
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
      await deleteRows("settings", [id]);
      await sync();
    });
    return id;
  }

  it("says a device signed in again has nothing only once its first pull has answered", async () => {
    await on("A", async () => {
      await put("greeting", "merhaba");
      await sync();
    });
    useSyncStatus.getState().set({ state: "idle", error: null, lastSyncAt: null });
    await on("B", async () => {
      expect(await readSettings()).toEqual([]);
      expect(pulledOnce(useSyncStatus.getState()), "an empty copy before the pull is not an empty account").toBe(false);
      await sync();
      expect(pulledOnce(useSyncStatus.getState())).toBe(true);
      expect(await valueOf("greeting")).toBe("merhaba");
    });
    useSyncStatus.getState().set({ state: "error", error: "offline", lastSyncAt: null });
    expect(pulledOnce(useSyncStatus.getState()), "a pull that failed says what the device holds").toBe(true);
  });

  it("keeps a column a device pulled before its build knew it", async () => {
    const id = await deletedSetting();
    await on("B", async () => {
      await sync();
      await downgradeWithoutDeletedAt();
      await sync();
      await writeRows([{ table: "settings", row: { id, key: "greeting", value: '"selam"' } }]);
      await sync();
    });
    expect(serverRow(id)?.deleted_at, "the edit did not send the migration's empty column over the delete").not.toBeNull();
  });

  it("keeps that column when the edit comes before the re-pull, as on an offline launch", async () => {
    const id = await deletedSetting();
    await on("B", async () => {
      await sync();
      await downgradeWithoutDeletedAt();
      await writeRows([{ table: "settings", row: { id, key: "greeting", value: '"selam"' } }]);
      await sync();
      expect(devices.B.prepare("SELECT table_name FROM sync_state WHERE table_name LIKE 'unpulled:%'").all(), "the pull after it finished").toEqual([]);
      expect(devices.B.prepare("SELECT deleted_at FROM settings").get(), "the server's answer, taken").toMatchObject({ deleted_at: expect.any(String) });
    });
    expect(serverRow(id)?.deleted_at).not.toBeNull();
  });

  it("keeps that column unpulled while a refused edit of it waits to be retried", async () => {
    const id = await deletedSetting();
    await on("B", async () => {
      await sync();
      await downgradeWithoutDeletedAt();
      devices.B.prepare("INSERT INTO sync_dead_letters (outbox_id, table_name, row_id, payload, reason, quarantined_at) VALUES (1, 'settings', ?, '{}', 'refused', ?)").run(id, new Date().toISOString());
      await sync();
      const marks = () => devices.B.prepare("SELECT table_name FROM sync_state WHERE table_name LIKE 'unpulled:%'").all();
      expect(marks(), "a retry would send the empty column").toEqual([{ table_name: "unpulled:settings" }]);
      await dismissDeadLetter((await readDeadLetters())[0]!.id);
      await sync();
      expect(marks()).toEqual([]);
    });
  });

  it("keeps a column an event queued before the update does not carry", async () => {
    const id = await deletedSetting();
    await on("B", async () => {
      await sync();
      await writeRows([{ table: "settings", row: { id, key: "greeting", value: '"selam"' } }]);
      // What a build before the column queued: the same edit without it.
      devices.B.prepare("UPDATE outbox SET payload = json_remove(payload, '$.deleted_at') WHERE table_name = 'settings'").run();
      expect(await sync()).toBe(true);
    });
    expect(serverRow(id)).toMatchObject({ deleted_at: expect.any(String), value: '"selam"' });
  });

  // One statement stamps every row it writes with one now(); a cursor cut to
  // the millisecond matched them all again.
  it("pulls past a full page of rows one statement stamped", async () => {
    const at = "2030-01-01T00:00:00.123456+00:00";
    for (let n = 0; n < 1001; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      cloud.tables.get("settings")!.set(`${USER}|${id}`, { user_id: USER, id, key: `k${n}`, value: "1", created_at: at, updated_at: at, deleted_at: null, tombstone_version: 0 });
    }
    const outcome = await on("A", () => Promise.race([sync(), new Promise((resolve) => setTimeout(() => resolve("still pulling"), 3000))]));
    expect(outcome).toBe(true);
    expect(cloud.requests.filter((request) => request === "select settings")).toHaveLength(2);
    expect(devices.A.prepare("SELECT count(*) AS n FROM settings").get()).toEqual({ n: 1001 });
  });
});
