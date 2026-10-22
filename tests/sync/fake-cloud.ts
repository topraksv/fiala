/**
 * The server half of sync, as the engine meets it through supabase-js: the
 * PostgREST calls it makes, the cursor RPC and the session. It keeps what
 * `supabase/migrations/00000000000001_baseline.sql` decides — the server's clock
 * in microseconds, one `now()` per statement, the delete generation, a row
 * keyed and scoped by its person, and a statement that fails whole — so the
 * engine is tested against the rules it will meet, and
 * `supabase/tests/sync_rls.sql` proves the real server keeps the same ones.
 */

type Row = Record<string, unknown>;
type Failure = { message: string; code?: string };
type Reply = { data: unknown; error: Failure | null };

const TABLES = ["settings"];
/** The server takes a setting's JSON of 10,000 characters at most. */
const VALUE_MAX = 10_000;

/** Microseconds since the epoch, as Postgres keeps a timestamptz. */
function micros(value: string): number {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return Number.NaN;
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
  return Date.parse(`${match[1]}${match[3]}`) * 1000 + Number(fraction);
}

function timestamptz(us: number): string {
  const iso = new Date(Math.floor(us / 1000)).toISOString();
  return `${iso.slice(0, 19)}.${String(us % 1_000_000).padStart(6, "0")}+00:00`;
}

export class FakeCloud {
  readonly tables = new Map<string, Map<string, Row>>(TABLES.map((table) => [table, new Map()]));
  /** Who the client's session belongs to; `null` is signed out. */
  user: string | null = null;
  /** The next answers `auth.refreshSession` gives, then a fresh session. */
  refreshFailures: Failure[] = [];
  /** A failure the next PostgREST calls meet before doing anything. */
  failures: Failure[] = [];
  /** What `auth.getSession` answers with while set. */
  sessionFailure: Failure | null = null;
  /** One failure for the first request whose name starts so, as `failures` is for the next of any. */
  readonly failOn = new Map<string, Failure>();
  private readonly holds = new Map<string, Promise<void>>();
  readonly requests: string[] = [];
  /** Ahead of any device's clock, so a pulled row always looks newer than a local edit. */
  private clock = Date.parse("2030-01-01T00:00:00Z") * 1000;

  private now(): number {
    // 1.000123 ms a statement, so two statements never share a millisecond's
    // worth of microseconds and a cursor's truncation is always exercised.
    this.clock += 1123;
    return this.clock;
  }

  /**
   * Written again rather than imported from `src/sync/rows.ts`, so a key the
   * client gets wrong is one this server does not have.
   */
  private keyOf(row: Row): string {
    return `${String(row.user_id)}|${String(row.id)}`;
  }

  /** What `rows` holds on the server now, whoever it belongs to. */
  rows(table: string): Row[] {
    return [...this.tables.get(table)!.values()].map((row) => ({ ...row }));
  }

  /** A row a statement wrote this long before the latest one: a transaction that committed late. */
  insertLate(table: string, row: Row, microsBefore: number): void {
    const latest = Math.max(...this.rows(table).map((stored) => micros(String(stored.updated_at))));
    const stored = { created_at: timestamptz(latest - microsBefore), deleted_at: null, tombstone_version: 0, ...row, updated_at: timestamptz(latest - microsBefore) };
    this.tables.get(table)!.set(this.keyOf(stored), stored);
  }

  private upsert(table: string, rows: Row[]): Reply {
    const uid = this.user;
    if (!uid) return { data: null, error: { message: "permission denied for table " + table, code: "42501" } };
    const stored = this.tables.get(table)!;
    const staged = new Map(stored);
    const now = this.now();
    const answer: Row[] = [];
    // PostgREST's bulk insert names the union of the rows' keys, and a row
    // that lacks one writes null into it (supabase-js's `defaultToNull`).
    const named = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    for (const incoming of rows) {
      const row: Row = { ...Object.fromEntries(named.map((column) => [column, null])), ...incoming };
      const key = this.keyOf(row);
      const old = staged.get(key);
      // A row is the caller's own: the policy refuses any other owner's.
      if (row.user_id !== uid) return { data: null, error: { message: `new row violates row-level security policy for table "${table}"`, code: "42501" } };
      let next: Row = { ...old, ...row };
      if (typeof next.value === "string" && next.value.length > VALUE_MAX) {
        return { data: null, error: { message: `new row for relation "${table}" violates check constraint`, code: "23514" } };
      }
      const version = Number(next.tombstone_version ?? 0);
      let kept = false;
      if (!old) {
        if (next.deleted_at != null && version === 0) next.tombstone_version = 1;
      } else if (version < Number(old.tombstone_version)) {
        next = { ...old };
        kept = true;
      } else if (old.deleted_at == null && next.deleted_at != null) {
        if (version !== Number(old.tombstone_version) && version !== Number(old.tombstone_version) + 1) {
          return { data: null, error: { message: "invalid tombstone generation", code: "23514" } };
        }
        next.tombstone_version = Number(old.tombstone_version) + 1;
      } else if (version !== Number(old.tombstone_version)) {
        return { data: null, error: { message: "invalid tombstone generation", code: "23514" } };
      }
      if (!kept) {
        next.updated_at = timestamptz(now);
        for (const column of ["created_at", "deleted_at"]) {
          if (typeof next[column] === "string") next[column] = timestamptz(micros(String(next[column])));
        }
      }
      staged.set(key, next);
      answer.push({ ...next });
    }
    this.tables.set(table, staged);
    return { data: answer, error: null };
  }

  private select(table: string, filter: { after?: { us: number; id: string }; from?: number; limit: number }): Reply {
    const uid = this.user;
    if (!uid) return { data: null, error: { message: "permission denied for table " + table, code: "42501" } };
    const sorted = this.rows(table)
      .filter((row) => row.user_id === uid)
      .map((row) => ({ row, us: micros(String(row.updated_at)) }))
      .filter(({ row, us }) =>
        filter.after
          ? us > filter.after.us || (us === filter.after.us && String(row.id) > filter.after.id)
          : us >= (filter.from ?? 0))
      .sort((a, b) => a.us - b.us || String(a.row.id).localeCompare(String(b.row.id)));
    return { data: sorted.slice(0, filter.limit).map(({ row }) => row), error: null };
  }

  private rpc(name: string): Reply {
    if (!this.user) return { data: null, error: { message: "permission denied for function " + name, code: "42501" } };
    if (name !== "sync_cursors") return { data: null, error: { message: "no such function", code: "PGRST202" } };
    return {
      data: TABLES.map((table) => {
        const head = (this.select(table, { limit: Number.MAX_SAFE_INTEGER }).data as Row[]).at(-1);
        return { table_name: table, max_updated_at: head?.updated_at ?? null, max_id: head?.id ?? null };
      }),
      error: null,
    };
  }

  /** Keep the next `request` (`"upsert settings"`) unanswered until the returned release, so a test can act while it is in flight. */
  hold(request: string): () => void {
    let release!: () => void;
    this.holds.set(request, new Promise((resolve) => (release = resolve)));
    return release;
  }

  private async answer<T>(request: string, signal: AbortSignal | undefined, reply: () => T): Promise<T> {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    this.requests.push(request);
    const aimed = [...this.failOn.keys()].find((prefix) => request.startsWith(prefix));
    const failure = aimed ? this.failOn.get(aimed) : this.failures.shift();
    if (aimed) this.failOn.delete(aimed);
    const held = this.holds.get(request);
    this.holds.delete(request);
    // Once sent, a request is the server's: an abort meanwhile does not undo it.
    if (held) await held;
    if (failure) return { data: null, error: failure } as T;
    return reply();
  }

  /** The slice of a `SupabaseClient` the engine touches. */
  client() {
    const cloud = this;
    const from = (table: string) => {
      let upserting: Row[] | null = null;
      let conflict: string | undefined;
      const filter: { after?: { us: number; id: string }; from?: number; limit: number } = { limit: 1000 };
      const builder = {
        upsert(rows: Row[], options: { onConflict?: string }) {
          upserting = rows;
          conflict = options.onConflict;
          return builder;
        },
        select: () => builder,
        order: () => builder,
        eq(column: string, value: string) {
          // The engine asks for a row by its key only to learn its generation.
          if (column !== "user_id" && column !== "id") throw new Error(`unexpected filter on ${column}`);
          void value;
          return builder;
        },
        limit(count: number) {
          filter.limit = count;
          return builder;
        },
        gte(_column: string, value: string) {
          filter.from = micros(value);
          return builder;
        },
        or(expression: string) {
          const match = /^updated_at\.gt\.(.+),and\(updated_at\.eq\.(.+),id\.gt\.(.+)\)$/.exec(expression);
          if (!match || match[1] !== match[2]) throw new Error(`unexpected filter ${expression}`);
          filter.after = { us: micros(match[1]!), id: match[3]! };
          return builder;
        },
        abortSignal(signal: AbortSignal) {
          return cloud.answer(`${upserting ? "upsert" : "select"} ${table}`, signal, () => {
            if (!upserting) return cloud.select(table, filter);
            if (conflict !== "user_id,id") throw new Error(`upsert ${table} on ${conflict}, not user_id,id`);
            return cloud.upsert(table, upserting);
          });
        },
      };
      return builder;
    };
    return {
      from,
      rpc(name: string) {
        // Lazy, as PostgREST's builder is: nothing is asked until it is awaited.
        const call = (signal?: AbortSignal) => cloud.answer(`rpc ${name}`, signal, () => cloud.rpc(name));
        return { abortSignal: call, then: (resolve: (reply: Reply) => unknown, reject: (error: unknown) => unknown) => call().then(resolve, reject) };
      },
      auth: {
        getSession: async () =>
          cloud.sessionFailure
            ? { data: { session: null }, error: Object.assign(new Error(cloud.sessionFailure.message), { name: "AuthRetryableFetchError" }) }
            : { data: { session: cloud.user ? { user: { id: cloud.user } } : null }, error: null },
        refreshSession: async () => {
          const failure = cloud.refreshFailures.shift();
          if (failure) return { data: { session: null }, error: Object.assign(new Error(failure.message), { name: failure.code ?? "AuthApiError" }) };
          return { data: { session: cloud.user ? { user: { id: cloud.user } } : null }, error: null };
        },
      },
    };
  }
}
