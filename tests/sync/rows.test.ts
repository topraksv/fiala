import { describe, expect, it } from "vitest";

import { keyColumns, toLocalRow, toServerRow } from "../../src/sync/rows";

describe("a row crossing to the server and back", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const ID = "019f6bba-2c65-7ea8-a6c9-96d891155e83";
  const STAMP = "2026-09-27T10:00:00.123Z";
  const setting = { id: ID, created_at: STAMP, updated_at: STAMP, deleted_at: null, tombstone_version: 0, key: "greeting", value: '"merhaba"' };

  it("keys a setting by its person and a medicine row by its cabinet", () => {
    expect(keyColumns("settings")).toEqual(["user_id", "id"]);
    expect(keyColumns("packages")).toEqual(["cabinet_id", "id"]);
  });

  it("sends a cabinet's row as the device wrote it, with no person stamped on it", () => {
    const location = { id: ID, created_at: STAMP, updated_at: STAMP, deleted_at: null, tombstone_version: 0, cabinet_id: USER, name: "Banyo" };
    expect(toServerRow("locations", location, USER)).toEqual(location);
    const { cabinet_id: _, ...homeless } = location;
    expect(toServerRow("locations", homeless, USER), "a row with no cabinet has nowhere to go").toBeNull();
  });

  it("takes a cabinet's row whoever wrote it, since the server decided who may read it", () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const move = { id: ID, created_at: STAMP, updated_at: STAMP, deleted_at: null, tombstone_version: 0, cabinet_id: OTHER, package_id: ID, quantity_milli: -1000, reason: "use" };
    expect(toLocalRow("package_moves", { ...move, user_id: OTHER }, USER)).toEqual(move);
  });

  it("sends a boolean as a boolean, and stores it as SQLite's number", () => {
    const product = { id: ID, created_at: STAMP, updated_at: STAMP, deleted_at: null, tombstone_version: 0, cabinet_id: USER, name: "Parol", starred: 1 };
    expect(toServerRow("products", product, USER)).toMatchObject({ starred: true });
    expect(toServerRow("products", { ...product, starred: 0 }, USER)).toMatchObject({ starred: false });
    expect(toServerRow("products", { ...product, starred: 2 }, USER), "SQLite holds a boolean as 0 or 1").toBeNull();
    expect(toLocalRow("products", { ...product, starred: false }, USER)).toMatchObject({ starred: 0 });
    expect(toLocalRow("products", { ...product, starred: true }, USER)).toMatchObject({ starred: 1 });
    expect(() => toLocalRow("products", { ...product, starred: 1 }, USER), "the server sends a boolean, never a number").toThrow();
  });

  it("puts the person into the row", () => {
    expect(toServerRow("settings", setting, USER)).toEqual({ ...setting, user_id: USER });
  });

  it("leaves out a column an event from before it existed does not carry, so the server keeps what it holds", () => {
    const { deleted_at: _, ...old } = setting;
    expect(toServerRow("settings", old, USER)).toEqual({ ...old, user_id: USER });
    const { key: __, ...keyless } = old;
    expect(toServerRow("settings", keyless, USER), "but not one the server has no value for").toBeNull();
  });

  it("leaves out a column a migration added until the pull after it has finished, while it holds the empty value", () => {
    const unpulled = new Set(["deleted_at"]);
    expect(toServerRow("settings", setting, USER, unpulled)).not.toHaveProperty("deleted_at");
    const deleted = { ...setting, deleted_at: STAMP };
    expect(toServerRow("settings", deleted, USER, unpulled), "a value it was given is the person's").toMatchObject({ deleted_at: STAMP });
  });

  it("refuses what the schema could not have written", () => {
    expect(toServerRow("settings", { ...setting, owner: "x" }, USER)).toBeNull();
    expect(toServerRow("settings", { ...setting, id: "greeting" }, USER)).toBeNull();
    expect(toServerRow("settings", { ...setting, key: null }, USER)).toBeNull();
    expect(toServerRow("settings", { ...setting, value: 7 }, USER)).toBeNull();
    expect(toServerRow("settings", { ...setting, tombstone_version: 1.5 }, USER)).toBeNull();
    expect(toServerRow("settings", { ...setting, tombstone_version: -1 }, USER)).toBeNull();
  });

  it("stores a server row in the device's shape, and drops what the device has no column for", () => {
    const remote = { ...setting, user_id: USER, extra: 1, updated_at: "2026-09-27T10:00:00.123456+00:00", deleted_at: "2026-09-27T09:00:00+00:00" };
    expect(toLocalRow("settings", remote, USER)).toEqual({ ...setting, updated_at: STAMP, deleted_at: "2026-09-27T09:00:00.000Z" });
  });

  it("refuses a server row that is not this person's, or not well formed", () => {
    const remote = { ...setting, user_id: USER };
    expect(toLocalRow("settings", remote, USER)).toMatchObject({ key: "greeting" });
    expect(() => toLocalRow("settings", { ...remote, user_id: "22222222-2222-4222-8222-222222222222" }, USER)).toThrow();
    expect(() => toLocalRow("settings", { ...remote, id: "x),user_id.eq.y" }, USER)).toThrow();
    expect(() => toLocalRow("settings", { ...remote, updated_at: "not a date" }, USER)).toThrow();
    expect(() => toLocalRow("settings", { ...remote, deleted_at: "not a date" }, USER)).toThrow();
    expect(() => toLocalRow("settings", { ...remote, tombstone_version: "1" }, USER)).toThrow();
    expect(() => toLocalRow("settings", { ...remote, key: null }, USER)).toThrow();
  });
});
