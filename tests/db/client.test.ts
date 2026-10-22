/**
 * The one way into the database, over a stand-in for expo-sqlite: it opens
 * with the pragmas each platform takes, waits out a lock held by the previous
 * page, rebuilds a corrupt copy once and says so once, never caches a failure,
 * runs one transaction at a time, and hands Drizzle raw rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  deleteDatabase: vi.fn(async (_name: string) => {}),
  platform: { OS: "ios" },
  stored: new Map<string, string>(),
  kvFails: false,
  removeFails: false,
}));

vi.mock("react-native", () => ({ Platform: harness.platform }));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: harness.open, deleteDatabaseAsync: harness.deleteDatabase }));
vi.mock("../../src/services/kv", () => ({
  kv: {
    get: async (key: string) => {
      if (harness.kvFails) throw new Error("keychain locked");
      return harness.stored.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      if (harness.kvFails) throw new Error("keychain locked");
      harness.stored.set(key, value);
    },
    remove: async (key: string) => {
      if (harness.kvFails || harness.removeFails) throw new Error("keychain locked");
      harness.stored.delete(key);
    },
  },
}));

const REBUILT_KEY = "fiala.database-rebuilt";
const corrupt = () => Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" });
const locked = () => new Error("Invalid VFS state");

function fakeDatabase(rows: unknown[][] = []) {
  const finalized = vi.fn(async () => {});
  return {
    execAsync: vi.fn(async (_sql: string) => undefined),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (task: () => Promise<void>) => task()),
    runAsync: vi.fn(async (_sql: string, _params: unknown[]) => undefined),
    prepareAsync: vi.fn(async (_sql: string) => ({
      executeForRawResultAsync: async (_params: unknown[]) => ({ getAllAsync: async () => rows }),
      finalizeAsync: finalized,
    })),
    finalized,
  };
}

/** A fresh module: its handle and its transaction queue start empty. */
async function load() {
  vi.resetModules();
  return import("../../src/db/client");
}

beforeEach(() => {
  harness.open.mockReset();
  harness.deleteDatabase.mockClear();
  harness.platform.OS = "ios";
  harness.stored.clear();
  harness.kvFails = false;
  harness.removeFails = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("opening", () => {
  it("asks for change events and sets WAL and foreign keys on a phone", async () => {
    const db = fakeDatabase();
    harness.open.mockResolvedValue(db);
    const { getSqliteAsync } = await load();

    await expect(getSqliteAsync()).resolves.toBe(db);
    expect(harness.open).toHaveBeenCalledWith("fiala.db", { enableChangeListener: true });
    expect(db.execAsync.mock.calls.map(([sql]) => sql)).toEqual(["PRAGMA journal_mode = WAL;", "PRAGMA foreign_keys = ON;"]);
  });

  it("skips WAL on the web, whose OPFS backend has no shared memory", async () => {
    harness.platform.OS = "web";
    const db = fakeDatabase();
    harness.open.mockResolvedValue(db);
    const { getSqliteAsync } = await load();

    await getSqliteAsync();
    expect(db.execAsync.mock.calls.map(([sql]) => sql)).toEqual(["PRAGMA foreign_keys = ON;"]);
  });

  it("opens once and hands every caller the same connection", async () => {
    harness.open.mockResolvedValue(fakeDatabase());
    const { getSqliteAsync } = await load();

    const [first, second] = await Promise.all([getSqliteAsync(), getSqliteAsync()]);
    expect(first).toBe(second);
    expect(harness.open).toHaveBeenCalledTimes(1);
  });

  it("closes a connection whose pragma failed, so the retry does not meet its lock", async () => {
    vi.useFakeTimers();
    const refused = fakeDatabase();
    refused.execAsync.mockRejectedValueOnce(locked());
    const good = fakeDatabase();
    harness.open.mockResolvedValueOnce(refused).mockResolvedValueOnce(good);
    const { getSqliteAsync } = await load();

    const opening = getSqliteAsync();
    await vi.advanceTimersByTimeAsync(150);
    await expect(opening).resolves.toBe(good);
    expect(refused.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("backs off longer each time and gives up after six tries with the last error", async () => {
    vi.useFakeTimers();
    harness.open.mockRejectedValue(locked());
    const { getSqliteAsync } = await load();

    const opening = getSqliteAsync();
    const outcome = opening.then(() => "opened", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(149);
    expect(harness.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(harness.open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.open).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(450 + 600 + 750);
    expect(await outcome).toBe("Invalid VFS state");
    expect(harness.open).toHaveBeenCalledTimes(6);
    expect(harness.deleteDatabase).not.toHaveBeenCalled();
  });

  it("does not cache a failure: the boot screen's retry opens afresh", async () => {
    vi.useFakeTimers();
    harness.open.mockRejectedValue(locked());
    const { getSqliteAsync } = await load();
    const failed = getSqliteAsync().catch(() => "failed");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await failed).toBe("failed");

    const db = fakeDatabase();
    harness.open.mockReset().mockResolvedValue(db);
    await expect(getSqliteAsync()).resolves.toBe(db);
  });
});

describe("a corrupt copy", () => {
  it("is deleted, opened again at once, and told about once", async () => {
    const db = fakeDatabase();
    harness.open.mockRejectedValueOnce(corrupt()).mockResolvedValueOnce(db);
    const { getSqliteAsync, takeDatabaseRebuilt } = await load();

    await expect(getSqliteAsync()).resolves.toBe(db);
    expect(harness.deleteDatabase).toHaveBeenCalledWith("fiala.db");
    expect(harness.stored.get(REBUILT_KEY)).toBe("1");
    await expect(takeDatabaseRebuilt()).resolves.toBe(true);
    expect(harness.stored.has(REBUILT_KEY)).toBe(false);
    await expect(takeDatabaseRebuilt()).resolves.toBe(false);
  });

  it("is known by any of SQLite's three ways of saying it", async () => {
    for (const error of [
      Object.assign(new Error("boom"), { code: "SQLITE_CORRUPT" }),
      new Error("file is not a database"),
      "Error: database disk image is malformed",
    ]) {
      harness.open.mockReset().mockRejectedValueOnce(error).mockResolvedValueOnce(fakeDatabase());
      harness.deleteDatabase.mockClear();
      const { getSqliteAsync } = await load();
      await getSqliteAsync();
      expect(harness.deleteDatabase).toHaveBeenCalledTimes(1);
    }
  });

  it("is rebuilt once only; a second corruption waits like any failure", async () => {
    vi.useFakeTimers();
    const db = fakeDatabase();
    harness.open.mockRejectedValueOnce(corrupt()).mockRejectedValueOnce(corrupt()).mockResolvedValueOnce(db);
    const { getSqliteAsync } = await load();

    const opening = getSqliteAsync();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    await expect(opening).resolves.toBe(db);
    expect(harness.deleteDatabase).toHaveBeenCalledTimes(1);
  });

  it("still opens when the notice cannot be stored, and a locked keychain reads as no notice", async () => {
    harness.kvFails = true;
    harness.open.mockRejectedValueOnce(corrupt()).mockResolvedValueOnce(fakeDatabase());
    const { getSqliteAsync, takeDatabaseRebuilt } = await load();

    await expect(getSqliteAsync()).resolves.toBeDefined();
    await expect(takeDatabaseRebuilt()).resolves.toBe(false);
  });

  it("is told even when the notice cannot be cleared", async () => {
    harness.stored.set(REBUILT_KEY, "1");
    harness.removeFails = true;
    const { takeDatabaseRebuilt } = await load();
    await expect(takeDatabaseRebuilt()).resolves.toBe(true);
  });
});

describe("transactions", () => {
  it("run one at a time, in the order asked, and a failed one frees the queue", async () => {
    const db = fakeDatabase();
    harness.open.mockResolvedValue(db);
    const { withTransaction } = await load();
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = withTransaction(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first:end");
    });
    const second = withTransaction(async () => {
      order.push("second");
      throw new Error("constraint");
    });
    const third = withTransaction(async () => void order.push("third"));
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst();

    await first;
    await expect(second).rejects.toThrow("constraint");
    await third;
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(3);
  });
});

describe("the Drizzle driver", () => {
  it("runs a write without preparing it", async () => {
    const db = fakeDatabase();
    harness.open.mockResolvedValue(db);
    const { getDb } = await load();
    const { sql } = await import("drizzle-orm");

    await getDb().run(sql`DELETE FROM items WHERE id = ${"a"}`);
    expect(db.runAsync).toHaveBeenCalledWith("DELETE FROM items WHERE id = ?", ["a"]);
    expect(db.prepareAsync).not.toHaveBeenCalled();
  });

  it("hands back raw rows, the first alone for a single-row read, and finalizes every statement", async () => {
    const db = fakeDatabase([["a", "Süt"], ["b", "Ekmek"]]);
    harness.open.mockResolvedValue(db);
    const { getDb } = await load();
    const { sql } = await import("drizzle-orm");

    await expect(getDb().values(sql`SELECT id, name FROM items`)).resolves.toEqual([["a", "Süt"], ["b", "Ekmek"]]);
    await expect(getDb().all(sql`SELECT id, name FROM items`)).resolves.toEqual([["a", "Süt"], ["b", "Ekmek"]]);
    await expect(getDb().get(sql`SELECT id, name FROM items`)).resolves.toEqual(["a", "Süt"]);
    expect(db.finalized).toHaveBeenCalledTimes(3);
  });

  it("gives a single-row read with no row an empty one, and finalizes a statement that failed", async () => {
    const db = fakeDatabase([]);
    harness.open.mockResolvedValue(db);
    const { getDb } = await load();
    const { sql } = await import("drizzle-orm");
    await expect(getDb().get(sql`SELECT 1`)).resolves.toEqual([]);

    db.prepareAsync.mockResolvedValueOnce({
      executeForRawResultAsync: async () => {
        throw new Error("no such table");
      },
      finalizeAsync: db.finalized,
    });
    await expect(getDb().all(sql`SELECT * FROM missing`)).rejects.toThrow("Failed query");
    expect(db.finalized).toHaveBeenCalledTimes(2);
  });
});

describe("leaving the page", () => {
  it("releases the connection on the web, so a refresh opens again", async () => {
    harness.platform.OS = "web";
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", { addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) });
    const first = fakeDatabase();
    const second = fakeDatabase();
    harness.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { getSqliteAsync } = await load();

    expect([...listeners.keys()].sort()).toEqual(["beforeunload", "pagehide"]);
    await getSqliteAsync();
    listeners.get("pagehide")!();
    await vi.waitFor(() => expect(first.closeAsync).toHaveBeenCalledTimes(1));
    await expect(getSqliteAsync()).resolves.toBe(second);
    listeners.get("beforeunload")!();
    await vi.waitFor(() => expect(second.closeAsync).toHaveBeenCalledTimes(1));
  });

  it("listens for nothing on a phone", async () => {
    const listen = vi.fn();
    vi.stubGlobal("window", { addEventListener: listen });
    await load();
    expect(listen).not.toHaveBeenCalled();
  });
});
