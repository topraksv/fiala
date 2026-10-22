import { describe, expect, it } from "vitest";

import { keyColumns, toLocalRow, toServerRow } from "../../src/sync/rows";

describe("a row crossing to the server and back", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const ID = "019f6bba-2c65-7ea8-a6c9-96d891155e83";
  const STAMP = "2026-09-27T10:00:00.123Z";
  const setting = { id: ID, created_at: STAMP, updated_at: STAMP, deleted_at: null, tombstone_version: 0, key: "greeting", value: '"merhaba"' };

  it("keys a row by its person and its id", () => {
    expect(keyColumns()).toEqual(["user_id", "id"]);
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
