import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";

/** Every migration statement, in order, as the app's runner splits them. */
const migrationStatements: string[] = (() => {
  const dir = join(import.meta.dirname, "../src/db/migrations");
  return readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("--> statement-breakpoint"))
    .map((statement) => statement.trim())
    .filter(Boolean);
})();

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const statement of migrationStatements) db.exec(statement);
  return db;
}

type Bind = (string | number | null)[];

/**
 * The `src/db/client` surface over a real `node:sqlite` database, so the write
 * layer, its SQL and Drizzle's queries run as the app runs them; only the
 * driver underneath is Node's.
 *
 * `db` is a getter because the database is made in `beforeEach`, after the
 * hoisted `vi.mock` factory that calls this has already run.
 */
export function sqliteClientMock(db: () => DatabaseSync) {
  const database = drizzle(async (sql, params, method) => {
    const statement = db().prepare(sql);
    if (method === "run") {
      statement.run(...(params as Bind));
      return { rows: [] };
    }
    statement.setReturnArrays(true);
    const rows = statement.all(...(params as Bind)) as unknown[];
    return { rows: method === "get" ? ((rows[0] ?? []) as unknown[]) : rows };
  });
  // The client's queue, so two writes started together commit one after the
  // other here as they do in the app, instead of nesting a BEGIN.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    getDb: () => database,
    getSqliteAsync: async () => ({
      getFirstAsync: async (sql: string, args: Bind = []) => db().prepare(sql).get(...args) ?? null,
      getAllAsync: async (sql: string, args: Bind = []) => db().prepare(sql).all(...args),
      runAsync: async (sql: string, args: Bind = []) => ({ changes: Number(db().prepare(sql).run(...args).changes) }),
      execAsync: async (sql: string) => void db().exec(sql),
    }),
    withTransaction: (task: () => Promise<void>) => {
      const run = chain.then(async () => {
        db().exec("BEGIN");
        try {
          await task();
          db().exec("COMMIT");
        } catch (error) {
          db().exec("ROLLBACK");
          throw error;
        }
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

/** `expo-crypto` over Node's, for `vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock)`. */
export const expoCryptoMock = {
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_algorithm: string, value: string) => createHash("sha256").update(value).digest("hex"),
};
