/**
 * The migration runner over drizzle-kit's journal: asynchronous, with the same
 * bookkeeping as Drizzle's own migrator (the `__drizzle_migrations` table,
 * compared by the journal's `when`). Its `hash` column exists for that
 * compatibility and is left empty. */

import { getSqliteAsync, withTransaction } from "./client";
import migrations from "./migrations/migrations";
import { SYNCED_TABLES, UNPULLED } from "./schema";

export async function migrateDb(): Promise<void> {
  const db = await getSqliteAsync();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  const last = await db.getFirstAsync<{ created_at: number }>(
    `SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
  );
  const appliedUpTo = Number(last?.created_at ?? 0);
  const due = migrations.journal.entries.filter((entry) => entry.when > appliedUpTo);
  if (due.length === 0) return;
  const tables = Object.keys(SYNCED_TABLES);
  const columnsOf = async (table: string) =>
    new Set((await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name));
  // A table this launch creates has no row to pull again.
  const held = (await Promise.all(tables.map(async (table) => ((await columnsOf(table)).size > 0 ? [table] : [])))).flat();

  for (const entry of due) {
    const key = `m${String(entry.idx).padStart(4, "0")}` as keyof typeof migrations.migrations;
    const sqlBundle = migrations.migrations[key];
    if (!sqlBundle) throw new Error(`Missing migration: ${entry.tag}`);
    // Each migration, its bookkeeping row and what it leaves to pull land
    // together, so a failure part way leaves the database at the previous
    // migration rather than between two.
    await withTransaction(async () => {
      const before = await Promise.all(held.map(columnsOf));
      for (const statement of sqlBundle.split("--> statement-breakpoint")) {
        await db.execAsync(statement);
      }
      await db.runAsync(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`, ["", entry.when]);
      // A row pulled before its column existed here kept the migration's
      // empty value with the cursor past it, and its next edit would send that
      // over the server's. So a table given a column is pulled again from the
      // start, and until that pull has finished the column is named
      // `unpulled`: an edit made first — an offline launch — leaves its empty
      // value unsent. The columns are read, not listed, so none is missed.
      for (const [at, table] of held.entries()) {
        const added = [...(await columnsOf(table))].filter((column) => !before[at]!.has(column));
        if (added.length === 0) continue;
        const marked = await db.getFirstAsync<{ last_pulled_at: string }>("SELECT last_pulled_at FROM sync_state WHERE table_name = ?", [UNPULLED + table]);
        const columns = [...new Set([...(marked ? (JSON.parse(marked.last_pulled_at) as string[]) : []), ...added])];
        await db.runAsync("DELETE FROM sync_state WHERE table_name = ?", [table]);
        await db.runAsync("INSERT OR REPLACE INTO sync_state (table_name, last_pulled_at) VALUES (?, ?)", [UNPULLED + table, JSON.stringify(columns)]);
      }
    });
  }
}
