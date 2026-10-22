import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { outbox, SYNCED_TABLES } from "../../src/db/schema";
import { migratedDatabase } from "../helpers";

/**
 * `schema.ts` is what the code writes; the migrations are what a phone has.
 * Editing the one without running `npm run db:generate` compiles, passes every
 * other test, and fails on the first write on a device.
 */
describe("the schema and the migrations", () => {
  it.each([...Object.values(SYNCED_TABLES), outbox].map((table) => [getTableName(table), table] as const))(
    "agree on every column of %s",
    (name, table) => {
      const db = migratedDatabase();
      const onDisk = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((column) => column.name);
      db.close();
      expect(onDisk.sort()).toEqual(Object.values(getTableColumns(table)).map((column) => column.name).sort());
    },
  );

  it("registers every synced table under its own name", () => {
    for (const [key, table] of Object.entries(SYNCED_TABLES)) expect(getTableName(table)).toBe(key);
  });
});
