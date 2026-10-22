/**
 * The local SQLite schema: ids are uuidv7 strings minted on the device, timestamps are ISO-8601 UTC
 * strings, and a row is only ever deleted by stamping `deleted_at`, because
 * sync needs the tombstone and undo restores from it.
 *
 * `docs/ARCHITECTURE.md` "Tables" is the model this grows towards. A column
 * lands with the slice that first writes it, so a table here can be narrower
 * than its row there.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The sync columns, without a `user_id`: the device holds one account's
 * rows, and the push stamps the person on each.
 */
const syncColumns = {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  /** Monotonic delete generation: a device that last saw generation N cannot
   *  revive a row deleted at N+1, whatever its clock says. */
  tombstoneVersion: integer("tombstone_version").notNull().default(0),
};

/**
 * What follows the person to every device, as a key and a JSON value: today
 * whether the account is frozen and each device's last sign-in. The id comes from the key
 * (`src/db/ids.ts`), so two devices writing one setting meet one row.
 */
export const settings = sqliteTable("settings", {
  ...syncColumns,
  key: text("key").notNull(),
  value: text("value").notNull(),
});

/** Local only: every write waiting to be pushed. Never synced itself. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    op: text("op", { enum: ["upsert"] }).notNull().default("upsert"),
    payload: text("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_outbox_table_id").on(t.tableName, t.id),
    index("idx_outbox_table_row_id_id").on(t.tableName, t.rowId, t.id),
  ],
);

/**
 * Local only: an outbox event the push would not send, or the server would not
 * take . The row itself stays as it is on the device; this is the
 * clue, kept until a retry sends it or the person dismisses it.
 */
export const syncDeadLetters = sqliteTable("sync_dead_letters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  outboxId: integer("outbox_id").notNull().unique(),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  payload: text("payload").notNull(),
  reason: text("reason", { enum: ["malformed_payload", "invalid_row", "refused"] }).notNull(),
  quarantinedAt: text("quarantined_at").notNull(),
});

/** Local only: how far each table has been pulled, as `"<updated_at>|<id>"`. */
export const syncState = sqliteTable("sync_state", {
  tableName: text("table_name").primaryKey(),
  lastPulledAt: text("last_pulled_at").notNull(),
});

/**
 * The `sync_state` key under which `migrateDb` names the columns an update
 * added, as a JSON list, until the pull after it has finished: the push leaves
 * such a column out while it holds the migration's empty value.
 */
export const UNPULLED = "unpulled:";

/** Parents before children, the order a push sends them in. */
export const SYNCED_TABLES = { settings } as const;

export type SyncedTableName = keyof typeof SYNCED_TABLES;
