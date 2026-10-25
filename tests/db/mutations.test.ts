/**
 * The write layer over a real database: a write lands with its outbox event
 * in one transaction, a delete moves the generation by one and an undo keeps
 * it, and an undo refuses to overwrite what changed since.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

const { deleteRows, editRow, findRow, fromDbShape, nowIso, onLocalWrite, pendingOutboxCount, resetLocalWorkspace, scrubTombstone, undoRows, writeRows } = await import("../../src/db/mutations");
const { migratedDatabase } = await import("../helpers");

const ID = "019f6bba-2c65-7ea8-a6c9-96d891155e01";
const OTHER = "019f6bba-2c65-7ea8-a6c9-96d891155e02";
const put = (id: string, value: string, over: Record<string, unknown> = {}) => writeRows([{ table: "settings", row: { id, key: `k${id.slice(-2)}`, value, ...over } }]);
const stored = (id: string) => harness.db!.prepare("SELECT * FROM settings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const queued = () => harness.db!.prepare("SELECT row_id, payload FROM outbox ORDER BY id").all() as { row_id: string; payload: string }[];

beforeEach(() => {
  harness.db = migratedDatabase();
  onLocalWrite(() => {});
});

describe("writeRows", () => {
  it("stores the row and queues its event together, stamping what only this layer stamps", async () => {
    await put(ID, "1");
    expect(stored(ID)).toMatchObject({ key: "k01", value: "1", deleted_at: null, tombstone_version: 0 });
    expect(stored(ID)?.created_at).toBe(stored(ID)?.updated_at);
    expect(queued()).toHaveLength(1);
    expect(JSON.parse(queued()[0]!.payload)).toMatchObject({ id: ID, key: "k01", value: "1" });
  });

  it("keeps a row's age through an edit", async () => {
    await put(ID, "1", { createdAt: "2026-01-01T00:00:00.000Z" });
    await put(ID, "2");
    expect(stored(ID)).toMatchObject({ value: "2", created_at: "2026-01-01T00:00:00.000Z" });
  });

  it("refuses a row with no usable id, and stores none of the batch", async () => {
    await expect(writeRows([{ table: "settings", row: { id: ID, key: "a", value: "1" } }, { table: "settings", row: { id: "", key: "b", value: "2" } }])).rejects.toThrow(/id is invalid/);
    expect(stored(ID)).toBeUndefined();
    expect(await pendingOutboxCount()).toBe(0);
  });

  it("takes a write that reads what is stored inside the transaction", async () => {
    await put(ID, "1");
    await writeRows(async () => {
      const there = await findRow("settings", ID);
      return editRow("settings", there!, { value: "2" });
    });
    expect(stored(ID)?.value).toBe("2");
  });

  it("tells the listener once per write that queued something, and not for an empty one", async () => {
    const told = vi.fn();
    onLocalWrite(told);
    await writeRows([]);
    expect(told).not.toHaveBeenCalled();
    await put(ID, "1");
    expect(told).toHaveBeenCalledTimes(1);
  });

  it("replaces the event of a row written twice in one millisecond", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-27T10:00:00.000Z"), toFake: ["Date"] });
    try {
      await put(ID, "1");
      await put(ID, "2");
    } finally {
      vi.useRealTimers();
    }
    expect(queued().map((event) => JSON.parse(event.payload).value)).toEqual(["2"]);
  });
});

describe("the delete generation", () => {
  it("moves on by one at a delete and holds at an undo", async () => {
    await put(ID, "1");
    await put(ID, "1", { deletedAt: nowIso() });
    expect(stored(ID)).toMatchObject({ tombstone_version: 1 });
    await put(ID, "1", { deletedAt: null });
    expect(stored(ID)).toMatchObject({ deleted_at: null, tombstone_version: 1 });
    await put(ID, "1", { deletedAt: nowIso() });
    expect(stored(ID)?.tombstone_version).toBe(2);
  });

  it("starts a row written deleted at one, and takes the highest generation a write saw", async () => {
    await put(ID, "1", { deletedAt: nowIso() });
    expect(stored(ID)?.tombstone_version).toBe(1);
    await put(OTHER, "1", { tombstoneVersion: 4 });
    expect(stored(OTHER)?.tombstone_version).toBe(4);
    await put(OTHER, "2", { tombstoneVersion: 2 });
    expect(stored(OTHER)?.tombstone_version, "never down").toBe(4);
    await put(OTHER, "2", { tombstoneVersion: -1 });
    expect(stored(OTHER)?.tombstone_version, "a generation that is not one is none").toBe(4);
  });
});

describe("editRow, findRow and the shapes", () => {
  it("writes nothing when every patched column already holds its value", async () => {
    await put(ID, "1");
    const there = (await findRow("settings", ID))!;
    expect(editRow("settings", there, { value: "1" })).toEqual([]);
    expect(editRow("settings", there, { value: "2" })).toMatchObject([{ table: "settings", row: { id: ID, key: "k01", value: "2" } }]);
  });

  it("finds a row live or a tombstone, and none that is not there", async () => {
    await put(ID, "1", { deletedAt: nowIso() });
    expect(await findRow("settings", ID)).toMatchObject({ id: ID });
    expect(await findRow("settings", OTHER)).toBeNull();
  });

  it("names columns in the camelCase a write takes, only those the row holds", () => {
    expect(fromDbShape("settings", { id: ID, key: "a", value: "1", updated_at: "x", other: 1 })).toEqual({ id: ID, key: "a", value: "1", updatedAt: "x" });
    expect(fromDbShape("settings", { id: ID, deleted_at: null })).toEqual({ id: ID, deletedAt: null });
  });
});

describe("deleting and undoing", () => {
  it("tombstones the live rows named once each, skips what is gone, and undoes whole", async () => {
    await put(ID, "1");
    await put(OTHER, "2");
    await put("019f6bba-2c65-7ea8-a6c9-96d891155e03", "3", { deletedAt: nowIso() });
    const written = (await deleteRows("settings", [ID, ID, OTHER, "019f6bba-2c65-7ea8-a6c9-96d891155e03", "019f6bba-2c65-7ea8-a6c9-96d891155e04"]))!;
    expect(written.writes.map((write) => write.row.id)).toEqual([ID, OTHER]);
    expect(stored(ID)?.deleted_at).not.toBeNull();
    await undoRows(written);
    expect(stored(ID)).toMatchObject({ deleted_at: null, value: "1" });
    expect(stored(OTHER)).toMatchObject({ deleted_at: null, value: "2" });
  });

  it("says there was nothing to delete when every row was already gone", async () => {
    expect(await deleteRows("settings", [ID])).toBeNull();
  });

  it("refuses an undo, whole, once a row it would restore has changed since", async () => {
    await put(ID, "1");
    await put(OTHER, "2");
    const written = (await deleteRows("settings", [ID, OTHER]))!;
    await put(OTHER, "changed", { deletedAt: null });
    await expect(undoRows(written)).rejects.toThrow(/has changed since/);
    expect(stored(ID)?.deleted_at, "not even the row that had not changed").not.toBeNull();
  });

  it("refuses an undo of a row that was removed from the device", async () => {
    await put(ID, "1");
    const written = (await deleteRows("settings", [ID]))!;
    harness.db!.exec("DELETE FROM settings");
    await expect(undoRows(written)).rejects.toThrow(/has changed since/);
  });
});

describe("a tombstone", () => {
  it("keeps no words and no choice, but its ids, parents and file", () => {
    const gone = { id: ID, deletedAt: "2026-10-25T00:00:00.000Z" };
    expect(scrubTombstone("tags", { ...gone, cabinetId: "me", name: "Ağrı" })).toEqual({ ...gone, cabinetId: "me", name: "" });
    expect(scrubTombstone("products", { ...gone, photoId: "p", starred: true, wanted: true })).toMatchObject({ photoId: "p", name: "", starred: false, wanted: false });
    expect(scrubTombstone("packages", { ...gone, productId: "x", photoId: "p", unit: "tablet", note: "Mutfak" })).toMatchObject({ productId: "x", photoId: "p", unit: "tablet", note: null, personId: null, checkAskedAt: null });
    expect(scrubTombstone("package_changes", { ...gone, packageId: "b", changes: '{"note":"x"}' })).toEqual({ ...gone, packageId: "b", changes: "{}" });
    expect(scrubTombstone("documents", { ...gone, fileId: "f", title: "Reçete" })).toMatchObject({ fileId: "f", title: "", reference: null });
    expect(scrubTombstone("dose_plans", { ...gone, productId: "x", instructions: "Tok" })).toEqual({ ...gone, productId: "x", instructions: null });
    expect(scrubTombstone("settings", { ...gone, value: "1" }), "a row with no words is left whole").toEqual({ ...gone, value: "1" });
    expect(scrubTombstone("tags", { id: ID, deletedAt: null, name: "Ağrı" }), "a live row is left whole").toEqual({ id: ID, deletedAt: null, name: "Ağrı" });
  });
});

describe("the workspace", () => {
  it("counts what waits to be sent, and empties every table at once", async () => {
    await put(ID, "1");
    expect(await pendingOutboxCount()).toBe(1);
    harness.db!.exec("INSERT INTO sync_state (table_name, last_pulled_at) VALUES ('settings', 'x')");
    await resetLocalWorkspace();
    for (const table of ["settings", "outbox", "sync_dead_letters", "sync_state"]) {
      expect(harness.db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
  });
});
