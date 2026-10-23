/**
 * Sync end to end: two devices of one person, each a real SQLite database
 * under the real migrations and write layer, through the shipped engine,
 * against `fake-cloud.ts` — which keeps the server's clock, its delete
 * generations and its row rules. Only the network is a stand-in. The rows are
 * mostly settings: the engine treats every table alike, and the cabinet's
 * tests prove what differs, their key.
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
const { addPackage, readCabinet, remainingMilli, setPhoto, takeFrom } = await import("../../src/data/cabinet");
const { readPhoto } = await import("../../src/data/photos");
const { purgeOwnPhotos } = await import("../../src/sync/photos");
const { acceptInvite, answerOffer, cancelInvites, createInvite, offerCabinet, peekInvite, useOffers } = await import("../../src/sync/sharing");

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
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64")}`;
/** A box with a photo of it, on the device in hand; its id and the photo's. */
async function boxWithPhoto(name = "Parol"): Promise<{ box: string; photoId: string }> {
  const box = await addPackage(signedIn, { name }, { unit: "tablet" }, 1000);
  await setPhoto("packages", box, { data: JPEG, thumb: JPEG });
  return { box, photoId: String((harness.db!.prepare("SELECT photo_id FROM packages WHERE id = ?").get(box) as { photo_id: string }).photo_id) };
}
const thumbs = async () => (await readCabinet()).flatMap((product) => product.boxes.map((box) => box.thumb));
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

  it("brings a box to the other device under its cabinet, counts a use made on each offline, and shows it to no one else", async () => {
    const box = await on("A", async () => {
      const made = await addPackage(USER, { name: "Parol", gtin: "8699546090112" }, { unit: "tablet", expiresOn: "2027-03-31" }, 20_000);
      expect(await sync()).toBe(true);
      return made;
    });
    expect(cloud.rows("packages")).toEqual([expect.objectContaining({ cabinet_id: USER, id: box, expires_on: "2027-03-31" })]);
    expect(cloud.rows("packages")[0], "a cabinet's row names no person").not.toHaveProperty("user_id");

    await on("B", async () => {
      await sync();
      await takeFrom(box, 1000);
    });
    await on("A", () => takeFrom(box, 2000));
    for (const device of ["B", "A", "B"] as const) await on(device, sync);
    expect(await on("A", () => remainingMilli(box))).toBe(17_000);
    expect(await on("B", () => remainingMilli(box))).toBe(17_000);

    await on("C", async () => {
      expect(await sync()).toBe(true);
      expect(await remainingMilli(box)).toBe(0);
      expect(devices.C.prepare("SELECT COUNT(*) AS n FROM packages").get()).toEqual({ n: 0 });
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
    // `created_at` is what tells a row made afresh from an edit, to the
    // millisecond: made in A's millisecond, B's row would be an edit.
    await new Promise((resolve) => setTimeout(resolve, 2));
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

describe("photos", () => {
  it("sends a photo before the row naming it, and the other device fetches it", async () => {
    const { photoId } = await on("A", async () => {
      const made = await boxWithPhoto();
      await sync();
      return made;
    });
    expect(cloud.requests.indexOf(`upload ${photoId}/full.jpg`)).toBeLessThan(cloud.requests.indexOf("upsert packages"));
    expect([...cloud.objects.keys()].sort()).toEqual([`${photoId}/full.jpg`, `${photoId}/thumb.jpg`]);

    await on("B", async () => {
      await sync();
      expect(await thumbs()).toEqual([JPEG]);
      expect(await readPhoto(photoId)).toBe(JPEG);
    });
  });

  it("sends a product's and a person's photo before their rows", async () => {
    const ids = await on("A", async () => {
      await addPackage(USER, { name: "Parol" }, { unit: "tablet" }, 1000);
      const product = String((devices.A.prepare("SELECT id FROM products").get() as { id: string }).id);
      await setPhoto("products", product, { data: JPEG, thumb: JPEG });
      await writeRows([{ table: "people", row: { id: "019f6bba-2c65-7ea8-a6c9-000000000001", cabinetId: USER, name: "Zeynep" } }]);
      await setPhoto("people", "019f6bba-2c65-7ea8-a6c9-000000000001", { data: JPEG, thumb: JPEG });
      await sync();
      return devices.A.prepare("SELECT photo_id FROM products UNION ALL SELECT photo_id FROM people").all().map((row) => String((row as { photo_id: string }).photo_id));
    });
    for (const [table, photoId] of [["products", ids[0]], ["people", ids[1]]] as const) {
      expect(cloud.requests.indexOf(`upload ${photoId}/full.jpg`), table).toBeLessThan(cloud.requests.indexOf(`upsert ${table}`));
    }
  });

  it("is never another cabinet's to fetch", async () => {
    const { photoId } = await on("A", async () => {
      const made = await boxWithPhoto();
      await sync();
      return made;
    });
    await on("C", async () => {
      expect((await cloud.client().storage.from("photos").download(`${photoId}/full.jpg`)).error).toMatchObject({ status: 404 });
    });
  });

  it("removes, a month on, the photos no row names any more, from Storage and from the device", async () => {
    const { box, photoId } = await on("A", async () => {
      const made = await boxWithPhoto();
      await sync();
      return made;
    });
    const kept = await on("A", async () => {
      await deleteRows("packages", [box]);
      const { photoId: other } = await boxWithPhoto("Arveles");
      await sync();
      return other;
    });
    expect(devices.A.prepare("SELECT id FROM photos WHERE id = ?").all(photoId), "within the month, the device keeps it").toHaveLength(1);
    for (const object of cloud.objects.values()) object.at -= 31 * 86_400_000;
    devices.A.prepare("UPDATE photos SET created_at = ?").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    await on("A", () => sync());
    expect([...cloud.objects.keys()].sort(), "an object its row named a month ago goes; a named one stays").toEqual([`${kept}/full.jpg`, `${kept}/thumb.jpg`]);
    expect(devices.A.prepare("SELECT id FROM photos").all(), "and the device's copy").toEqual([{ id: kept }]);
  });

  it("asks again for a photo that the network, not Storage, kept from arriving", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      await sync();
    });
    await on("B", async () => {
      cloud.downloadFailure = { message: "Failed to fetch" };
      expect(await sync(), "an unreachable Storage fails the sync").toBe(false);
      cloud.downloadFailure = null;
      expect(await sync()).toBe(true);
      expect(await thumbs()).toEqual([JPEG]);
    });
  });

  it("tells a photo Storage does not have from a Storage that did not answer", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      await sync();
    });
    await on("B", async () => {
      cloud.downloadFailure = { message: "Internal error", status: 503 };
      expect(await sync(), "a server error is not an answer").toBe(false);
      cloud.downloadFailure = { message: "Object not found", status: 404 };
      expect(await sync(), "not there is an answer: the rows sync without it").toBe(true);
      cloud.downloadFailure = null;
      const before = cloud.requests.length;
      await sync();
      expect(cloud.requests.slice(before).filter((request) => request.startsWith("download")), "not asked again this session").toEqual([]);
      expect(await thumbs()).toEqual([null]);
    });
  });

  it("passes over a photo Storage refuses for good, and sends again one it only failed", async () => {
    await on("A", async () => {
      const { photoId } = await boxWithPhoto();
      const uploaded = () => devices.A.prepare("SELECT uploaded_at FROM photos WHERE id = ?").get(photoId) as { uploaded_at: string | null };

      cloud.failOn.set("upload", { message: "Internal error", status: 503 });
      expect(await sync(), "a failed send fails the sync").toBe(false);
      expect(uploaded().uploaded_at).toBeNull();
      expect(cloud.rows("packages"), "and holds back the row naming it").toEqual([]);

      cloud.failOn.set("upload", { message: "new row violates row-level security policy", status: 403 });
      expect(await sync(), "a refusal for good does not hold the rest").toBe(true);
      expect(uploaded().uploaded_at, "still unsent").toBeNull();
      expect(cloud.rows("packages")).toHaveLength(1);

      const before = cloud.requests.length;
      await sync();
      expect(cloud.requests.slice(before).filter((request) => request.startsWith("upload")), "not offered again this session").toEqual([]);
    });
  });

  it("finishes a photo whose send was cut short between its two sizes", async () => {
    await on("A", async () => {
      const { photoId } = await boxWithPhoto();
      cloud.objects.set(`${photoId}/full.jpg`, { owner: USER, bytes: new Uint8Array([0xff, 0xd8, 0xff]), at: Date.now() });
      expect(await sync()).toBe(true);
      expect([...cloud.objects.keys()].sort()).toEqual([`${photoId}/full.jpg`, `${photoId}/thumb.jpg`]);
      expect(devices.A.prepare("SELECT uploaded_at FROM photos WHERE id = ?").get(photoId)).not.toMatchObject({ uploaded_at: null });
    });
  });

  it("removes photos from Storage a hundred at a time", async () => {
    const old = Date.now() - 31 * 86_400_000;
    for (let at = 0; at < 100; at++) {
      const id = `019f6bba-2c65-7ea8-a6c9-${String(at).padStart(12, "0")}`;
      for (const size of ["full", "thumb"]) cloud.objects.set(`${id}/${size}.jpg`, { owner: USER, bytes: new Uint8Array([0xff]), at: old });
    }
    await on("A", async () => {
      const before = cloud.requests.length;
      cloud.failOn.set("rpc unnamed_photos", { message: "boom", code: "XX000" });
      expect(await sync(), "a sweep that cannot ask waits for the next session").toBe(true);
      expect(cloud.objects.size).toBe(200);
      expect(cloud.requests.slice(before).filter((request) => request.startsWith("remove"))).toEqual([]);
    });
    await on("A", async () => {
      const before = cloud.requests.length;
      await sync();
      expect(cloud.objects.size).toBe(0);
      expect(cloud.requests.slice(before).filter((request) => request.startsWith("remove"))).toEqual(["remove 100", "remove 100"]);
    });
    for (let at = 0; at < 100; at++) {
      const id = `019f6bba-2c65-7ea8-a6c9-${String(at).padStart(12, "0")}`;
      for (const size of ["full", "thumb"]) cloud.objects.set(`${id}/${size}.jpg`, { owner: USER, bytes: new Uint8Array([0xff]), at: Date.now() });
    }
    await on("A", async () => {
      const before = cloud.requests.length;
      await purgeOwnPhotos();
      expect(cloud.objects.size).toBe(0);
      expect(cloud.requests.slice(before).filter((request) => request.startsWith("remove"))).toEqual(["remove 100", "remove 100"]);
    });
  });

  it("keeps the row naming a photo back while the photo cannot be sent", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      cloud.failures.push({ message: "Failed to fetch" });
      expect(await sync()).toBe(false);
      expect(cloud.rows("packages")).toEqual([]);
      expect(await sync()).toBe(true);
      expect(cloud.rows("packages")).toHaveLength(1);
    });
  });

  it("reads a fetched photo through FileReader where the Blob cannot give its bytes, as on a phone", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      await sync();
    });
    const bytes = Blob.prototype.arrayBuffer;
    const failing = new Set(["first"]);
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        error: Error | null = null;
        onloadend: () => void = () => {};
        readAsDataURL(blob: Blob) {
          void bytes.call(blob).then((buffer) => {
            if (failing.delete("first")) this.error = new Error("read failed");
            else this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString("base64")}`;
            this.onloadend();
          });
        }
      },
    );
    Object.defineProperty(Blob.prototype, "arrayBuffer", { value: undefined, configurable: true });
    try {
      await on("B", async () => {
        expect(await sync(), "a read that fails fails the sync").toBe(false);
        expect(await sync()).toBe(true);
        expect(await thumbs()).toEqual([JPEG]);
      });
    } finally {
      Object.defineProperty(Blob.prototype, "arrayBuffer", { value: bytes, configurable: true });
      vi.unstubAllGlobals();
    }
  });

  it("asks Storage once a launch for a photo it does not have, and never for a path a row made up", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      const other = await addPackage(USER, { name: "Arveles" }, { unit: "tablet" }, 1000);
      // What another build could send: the server takes any uuid here, and the device any text.
      const { fromDbShape } = await import("../../src/db/mutations");
      await writeRows([{ table: "packages", row: { ...fromDbShape("packages", devices.A.prepare("SELECT * FROM packages WHERE id = ?").get(other) as Record<string, unknown>), photoId: "../../avatars/someone" } }]);
      await sync();
    });
    cloud.objects.clear();
    await on("B", async () => {
      expect(await sync()).toBe(true);
      expect(await sync()).toBe(true);
      expect(cloud.requests.filter((request) => request.startsWith("download")), "one ask per size, and only for a photo's own path").toHaveLength(2);
      expect(await thumbs()).toEqual([null, null]);
    });
  });

  it("takes a file that is not a JPEG for no photo at all", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      await sync();
    });
    for (const object of cloud.objects.values()) object.bytes = new TextEncoder().encode("<script>");
    await on("B", async () => {
      expect(await sync()).toBe(true);
      expect(await thumbs()).toEqual([null]);
    });
  });

  it("removes every photo the account sent, and marks them to send again", async () => {
    await on("A", async () => {
      await boxWithPhoto();
      await sync();
      cloud.failures.push({ message: "Failed to fetch" });
      await expect(purgeOwnPhotos(), "a list it could not get").rejects.toThrow("photo purge");
      const release = cloud.hold("rpc own_photo_objects");
      const purging = purgeOwnPhotos();
      await vi.waitFor(() => expect(cloud.requests.at(-1)).toBe("rpc own_photo_objects"));
      cloud.failures.push({ message: "Failed to fetch" });
      release();
      await expect(purging, "a removal that failed").rejects.toThrow("photo purge");
      expect(devices.A.prepare("SELECT uploaded_at FROM photos").all(), "still marked sent").not.toEqual([{ uploaded_at: null }]);

      await purgeOwnPhotos();
      expect(cloud.objects.size).toBe(0);
      expect(devices.A.prepare("SELECT uploaded_at FROM photos").all()).toEqual([{ uploaded_at: null }]);
    });
  });
});

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

describe("a shared cabinet", () => {
  const HOUSE = "0190a000-0000-7000-8000-00000000a0a0";
  const count = (device: DatabaseSync, sql: string) => (device.prepare(sql).get() as { n: number }).n;

  /** C's household with a box in it, then A's own box synced, so every cursor on A is past the household's rows; then A is let in. */
  async function joined(role: "editor" | "viewer" = "editor"): Promise<{ box: string; mine: string }> {
    cloud.insertAsServer("cabinets", { id: HOUSE, owner_id: OTHER, name: "Ev" });
    const box = await on("C", async () => {
      const made = await addPackage(HOUSE, { name: "Ventolin" }, { unit: "doz" }, 200_000);
      await sync();
      return made;
    });
    const mine = await on("A", async () => {
      const made = await addPackage(USER, { name: "Parol", gtin: "8699546090112" }, { unit: "tablet" }, 20_000);
      await sync();
      return made;
    });
    cloud.insertAsServer("cabinet_members", { id: "0190a000-0000-7000-8000-00000000b0b1", cabinet_id: HOUSE, user_id: OTHER, role: "owner", name: "Can", seen_at: null });
    cloud.insertAsServer("cabinet_members", { id: "0190a000-0000-7000-8000-00000000b0b2", cabinet_id: HOUSE, user_id: USER, role, name: "Ece", seen_at: null });
    return { box, mine };
  }

  it("fetches a cabinet whole the first time its membership arrives, older than every cursor", async () => {
    const { box, mine } = await joined();
    // Someone's copy of A's own product id, in the household: it must not move A's.
    const product = String(cloud.rows("products").find((row) => row.cabinet_id === USER)!.id);
    cloud.insertAsServer("products", { cabinet_id: HOUSE, id: product, name: "Başka" });
    await on("A", async () => {
      expect(await sync(), String(useSyncStatus.getState().error)).toBe(true);
      expect(await remainingMilli(box)).toBe(200_000);
      expect(await remainingMilli(mine)).toBe(20_000);
    });
    expect(devices.A.prepare("SELECT cabinet_id, name FROM products WHERE id = ?").get(product), "the device's own row stays its own").toEqual({ cabinet_id: USER, name: "Parol" });
    expect(count(devices.A, `SELECT COUNT(*) AS n FROM cabinets WHERE id = '${HOUSE}'`)).toBe(1);
    expect(count(devices.A, `SELECT COUNT(*) AS n FROM cabinet_members WHERE cabinet_id = '${HOUSE}'`)).toBe(2);
    cloud.requests.length = 0;
    await on("A", sync);
    expect(cloud.requests.filter((request) => request === "select packages"), "once a device").toEqual([]);

    // A's use in the household reaches its owner.
    await on("A", () => takeFrom(box, 1000));
    await on("A", sync);
    expect(await on("C", async () => (await sync(), remainingMilli(box)))).toBe(199_000);
  });

  it("drops the cabinet, and what was still to send for it, once the person is removed", async () => {
    const { box, mine } = await joined();
    await on("A", sync);
    await on("A", () => takeFrom(box, 1000));
    const member = cloud.tables.get("cabinet_members")!.get("0190a000-0000-7000-8000-00000000b0b2")!;
    cloud.tables.get("cabinet_members")!.set(String(member.id), { ...member, deleted_at: "2030-01-02T00:00:00.000000+00:00", tombstone_version: 1, updated_at: "2031-01-01T00:00:00.000000+00:00" });
    await on("A", async () => {
      await sync();
      expect(await remainingMilli(box)).toBe(0);
      expect(await remainingMilli(mine), "A's own cabinet stays").toBe(20_000);
    });
    for (const table of ["cabinets", "packages", "package_moves", "products"]) {
      const column = table === "cabinets" ? "id" : "cabinet_id";
      expect(count(devices.A, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = '${HOUSE}'`), table).toBe(0);
    }
    expect(count(devices.A, "SELECT COUNT(*) AS n FROM outbox") + count(devices.A, "SELECT COUNT(*) AS n FROM sync_dead_letters"), "nothing waits for a cabinet the server will not take it into").toBe(0);
  });

  it("lets a viewer read the household and sends none of its writes", async () => {
    const { box } = await joined("viewer");
    await on("A", async () => {
      await sync();
      await takeFrom(box, 1000);
      await sync();
    });
    expect(count(devices.A, "SELECT COUNT(*) AS n FROM sync_dead_letters"), "set aside, as any refused row").toBe(1);
    expect(await on("C", async () => (await sync(), remainingMilli(box)))).toBe(200_000);
  });

  it("drops a household whose owner deleted the account, which no pull would have said", async () => {
    const { box } = await joined();
    await on("A", sync);
    cloud.deleteAccount(OTHER);
    await on("A", async () => {
      await sync();
      expect(await remainingMilli(box)).toBe(0);
    });
    expect(count(devices.A, `SELECT COUNT(*) AS n FROM cabinet_members`)).toBe(0);
  });
});

describe("an invitation into a household (F2.2)", () => {
  const HOUSE = "0190a000-0000-7000-8000-00000000c0c0";
  const SECOND = "0190a000-0000-7000-8000-00000000c0c1";
  const MINE = "0190a000-0000-7000-8000-00000000c0c2";
  const received = () => useOffers.getState().received;
  const household = (id: string, name: string) => writeRows([{ table: "cabinets", row: { id, ownerId: OTHER, name } }]);

  /** C's household with a box in it, made a moment ago and not yet sent, and A let in by C's link. */
  async function invited(): Promise<string> {
    const { token, box } = await on("C", async () => {
      await household(HOUSE, "Ev");
      const made = await addPackage(HOUSE, { name: "Ventolin" }, { unit: "doz" }, 200_000);
      const sent = vi.fn(sync);
      const link = await createInvite(HOUSE, "editor", "Can", sent);
      expect(sent, "the household goes to the server first").toHaveBeenCalledTimes(1);
      return { token: (link as { token: string }).token, box: made };
    });
    await on("A", async () => {
      expect(await peekInvite(token)).toEqual({ name: "Ev", inviter: "Can", role: "editor" });
      expect(await acceptInvite(token, "Ece")).toEqual({ cabinetId: HOUSE });
      expect(await acceptInvite(token, "Ece"), "a link works once").toEqual({ refused: tr.sharing.errInvite });
    });
    return box;
  }

  it("lets the person in, and the household arrives with their next sync", async () => {
    const box = await invited();
    await on("A", async () => {
      expect(await remainingMilli(box)).toBe(0);
      await sync();
      expect(await remainingMilli(box)).toBe(200_000);
    });
    expect(devices.A.prepare("SELECT user_id, role, name FROM cabinet_members ORDER BY role").all()).toEqual([
      { user_id: USER, role: "editor", name: "Ece" },
      { user_id: OTHER, role: "owner", name: "Can" },
    ]);
  });

  it("says why an invitation could not be made, used or taken back", async () => {
    await invited();
    await on("C", async () => {
      const sent = vi.fn(sync);
      expect(await createInvite(OTHER, "editor", "Can", sent)).toEqual({ refused: tr.sharing.errPersonal });
      expect(sent, "only a household the server lacks is sent and asked again").not.toHaveBeenCalled();
      const link = (await createInvite(HOUSE, "viewer", "Can", sync)) as { token: string };
      expect(await cancelInvites(HOUSE)).toEqual({ cancelled: 1 });
      expect(await peekInvite(link.token), "taken back, it leads nowhere").toBeNull();
      cloud.failures.push({ message: "TypeError: Failed to fetch" }, { message: "boom", code: "XX000" });
      expect(await cancelInvites(HOUSE)).toEqual({ refused: tr.sync.errNetwork });
      expect(await cancelInvites(HOUSE)).toEqual({ refused: tr.sharing.errGeneric });
    });
    await on("A", async () => {
      const sent = vi.fn(sync);
      expect(await createInvite(HOUSE, "editor", "Ece", sent), "only the owner invites").toEqual({ refused: tr.sharing.errNotOwner });
      expect(sent, "sent, then asked once more").toHaveBeenCalledTimes(1);
    });
    harness.cloud = { client: () => null };
    expect(await acceptInvite("a".repeat(64), "Ece")).toEqual({ refused: tr.auth.errNotConfigured });
  });

  it("reaches someone already in a household as an offer with their next sync, and lets them in once they accept", async () => {
    await invited();
    // A offers one of their own first, which waits on C, never on A.
    await on("A", async () => {
      await writeRows([{ table: "cabinets", row: { id: MINE, ownerId: USER, name: "Yazlık" } }]);
      expect(await offerCabinet(MINE, OTHER, "editor", "Ece", sync)).toEqual({ offered: true });
    });
    await on("C", async () => {
      await household(SECOND, "Annemler");
      expect(await offerCabinet(SECOND, USER, "viewer", "Can", sync)).toEqual({ offered: true });
      expect(await offerCabinet(HOUSE, USER, "editor", "Can", sync), "told who is in, not that a link expired").toEqual({ refused: tr.sharing.errAlreadyIn });
    });
    await on("A", async () => {
      expect(received()).toEqual([]);
      await sync();
      expect(received()).toEqual([{ cabinetId: SECOND, cabinetName: "Annemler", role: "viewer", fromName: "Can", to: USER }]);
      cloud.requests.length = 0;
      await sync();
      expect(cloud.requests.filter((request) => request === "rpc cabinet_offers"), "asked again only when they change").toEqual([]);
      expect(await answerOffer(SECOND, true, "Ece")).toEqual({ cabinetId: SECOND });
      expect(received(), "gone at once, not at the next sync").toEqual([]);
      await sync();
      expect(received()).toEqual([]);
    });
    expect(devices.A.prepare(`SELECT role FROM cabinet_members WHERE cabinet_id = '${SECOND}' AND user_id = '${USER}'`).get()).toEqual({ role: "viewer" });
  });

  it("forgets the offers with the session, follows a withdrawal, and tries again when they do not arrive", async () => {
    await invited();
    await on("C", async () => {
      await household(SECOND, "Annemler");
      await household(MINE, "Yazlık");
      await offerCabinet(SECOND, USER, "editor", "Can", sync);
      const sent = vi.fn(sync);
      expect(await offerCabinet(MINE, USER, "editor", "Can", sent)).toEqual({ offered: true });
      expect(sent, "a household the server holds is not sent again").not.toHaveBeenCalled();
    });
    await on("A", async () => {
      cloud.failOn.set("rpc cabinet_offers", { message: "TypeError: fetch failed" });
      expect(await sync(), "the sync owes nothing to the offers").toBe(true);
      expect(received()).toEqual([]);
      await sync();
      expect(received()).toHaveLength(2);
      expect(await answerOffer(MINE, false, "Ece")).toEqual({ cabinetId: null });
      expect(received().map((offer) => offer.cabinetId), "declining one leaves the other").toEqual([SECOND]);
    });
    await on("A", async () => expect(received(), "a new session starts empty").toEqual([]));
    await on("C", async () => {
      await sync();
      expect(received(), "the one who offered has nothing waiting").toEqual([]);
      expect(await offerCabinet(SECOND, USER, null, "Can", sync)).toEqual({ offered: true });
    });
    await on("A", async () => {
      await sync();
      expect(received(), "withdrawn").toEqual([]);
      expect(await answerOffer(SECOND, true, "Ece"), "a withdrawn offer cannot be accepted").toEqual({ refused: tr.sharing.errInvite });
    });
  });
});
