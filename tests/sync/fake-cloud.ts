/**
 * The server half of sync, as the engine meets it through supabase-js: the
 * PostgREST calls it makes, the cursor and photo RPCs, Storage's photos and
 * the session. It keeps what
 * `supabase/migrations/` decides — the server's clock in microseconds, one
 * `now()` per statement, the delete generation, a setting keyed and scoped by
 * its person and a medicine row by its cabinet, a cabinet read by its owner
 * and members and written by its owner and editors, a membership only the
 * server makes, invitations and offers (migration 6), and a statement that
 * fails whole — so the engine is tested against the rules it will meet, and
 * `supabase/tests/sync_rls.sql`, `sharing_rls.sql` and `cabinet_invites.sql`
 * prove the real server keeps the same ones.
 */

import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
type Failure = { message: string; code?: string; status?: number };
type Reply = { data: unknown; error: Failure | null };
type Filter = { after?: { us: number; id: string }; from?: number; limit: number; eq: Record<string, string> };

const TABLES = ["settings", "cabinets", "people", "locations", "products", "packages", "package_moves", "package_changes", "tags", "product_tags", "cabinet_members"];
/** Keyed by their id alone (migration 4). */
const ID_KEYED = new Set(["cabinets", "cabinet_members"]);
/** The column a table's rows are keyed by besides their id; none for a cabinet or a membership. */
const scopeOf = (table: string) => (ID_KEYED.has(table) ? null : table === "settings" ? "user_id" : "cabinet_id");
const PHOTO_TABLES = ["people", "products", "packages"];
const PHOTO_OBJECT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(full|thumb)\.jpg$/;
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

/** Migration 6's argument names, by function. */
const SHARING_ARGS: Record<string, string[]> = {
  create_cabinet_invite: ["cabinet", "invite_role", "owner_name"],
  cancel_cabinet_invites: ["cabinet"],
  peek_cabinet_invite: ["token"],
  accept_cabinet_invite: ["token", "member_name"],
  offer_cabinet: ["cabinet", "person", "role", "owner_name"],
  cabinet_offers: [],
  answer_cabinet_offer: ["cabinet", "accept", "member_name"],
};

export class FakeCloud {
  readonly tables = new Map<string, Map<string, Row>>(TABLES.map((table) => [table, new Map()]));
  readonly objects = new Map<string, { owner: string; bytes: Uint8Array; at: number }>();
  /** Links by their token, offers by `cabinet|person`; no client reads either table. */
  private readonly invites = new Map<string, { cabinet: string; role: string; by: string }>();
  private readonly offers = new Map<string, { cabinet: string; role: string; by: string; to: string }>();
  /** Who the client's session belongs to; `null` is signed out. */
  user: string | null = null;
  /** The next answers `auth.refreshSession` gives, then a fresh session. */
  refreshFailures: Failure[] = [];
  /** A failure the next PostgREST calls meet before doing anything. */
  failures: Failure[] = [];
  /** What `auth.getSession` answers with while set. */
  sessionFailure: Failure | null = null;
  /** What every Storage download meets while set. */
  downloadFailure: Failure | null = null;
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
  private keyOf(table: string, row: Row): string {
    const scope = scopeOf(table);
    return scope ? `${String(row[scope])}|${String(row.id)}` : String(row.id);
  }

  /** `private.is_cabinet_owner`; the personal cabinet is its account's whether or not its row is here. */
  private isOwner(cabinet: unknown, uid: string): boolean {
    return cabinet === uid || this.tables.get("cabinets")!.get(String(cabinet))?.owner_id === uid;
  }

  private membership(cabinet: unknown, uid: string): Row | undefined {
    return this.rows("cabinet_members").find((row) => row.cabinet_id === cabinet && row.user_id === uid && row.deleted_at == null);
  }

  /** `private.can_read_cabinet` and `private.can_write_cabinet`. */
  private canRead(cabinet: unknown, uid: string): boolean {
    return this.isOwner(cabinet, uid) || this.membership(cabinet, uid) != null;
  }

  private canWrite(cabinet: unknown, uid: string): boolean {
    return this.isOwner(cabinet, uid) || this.membership(cabinet, uid)?.role === "editor";
  }

  private visible(table: string, row: Row, uid: string): boolean {
    if (table === "settings") return row.user_id === uid;
    if (table === "cabinets") return this.canRead(row.id, uid);
    if (table === "cabinet_members") return row.user_id === uid || this.canRead(row.cabinet_id, uid);
    return this.canRead(row.cabinet_id, uid);
  }

  /** The policies; an account's id is never a household's (`private.is_account`): here, any id a member row names. */
  private writable(table: string, row: Row, uid: string, old: Row | undefined): boolean {
    if (table === "settings") return row.user_id === uid;
    if (table === "cabinets") return old ? old.owner_id === uid : row.owner_id === uid && !this.rows("cabinet_members").some((member) => member.user_id === row.id) && row.id !== uid;
    if (table === "cabinet_members") return old != null && (old.user_id === uid || this.isOwner(old.cabinet_id, uid));
    return this.canWrite(row.cabinet_id, uid);
  }

  /** The triggers `keep_cabinet_owner` and `guard_cabinet_member`: what a write may not change. */
  private guard(table: string, next: Row, old: Row, uid: string): void {
    const keepDelete = () => Object.assign(next, { deleted_at: old.deleted_at, tombstone_version: old.tombstone_version });
    if (table === "cabinets") {
      next.owner_id = old.owner_id;
      if (old.id === old.owner_id) keepDelete();
    }
    if (table !== "cabinet_members") return;
    Object.assign(next, { cabinet_id: old.cabinet_id, user_id: old.user_id });
    if (old.role === "owner") {
      next.role = "owner";
      keepDelete();
    } else if (!this.isOwner(old.cabinet_id, uid)) next.role = old.role;
    if (old.deleted_at != null) keepDelete();
    if (old.user_id !== uid) Object.assign(next, { name: old.name, seen_at: old.seen_at });
  }

  /** A row only the server writes — a household, a membership — as postgres would, past every policy. */
  insertAsServer(table: string, row: Row): void {
    const at = timestamptz(this.now());
    const stored = { created_at: at, deleted_at: null, tombstone_version: 0, ...row, updated_at: at };
    this.tables.get(table)!.set(this.keyOf(table, stored), stored);
  }

  /** `delete_own_account`: hard deletes by cascade, which no pull sees. */
  deleteAccount(uid: string): void {
    const owned = new Set([uid, ...this.rows("cabinets").filter((row) => row.owner_id === uid).map((row) => String(row.id))]);
    for (const [token, invite] of this.invites) if (invite.by === uid || owned.has(invite.cabinet)) this.invites.delete(token);
    for (const [key, offer] of this.offers) if (offer.by === uid || offer.to === uid || owned.has(offer.cabinet)) this.offers.delete(key);
    for (const [table, stored] of this.tables) {
      for (const [key, row] of stored) {
        const cabinet = table === "cabinets" ? row.id : row.cabinet_id;
        if (row.user_id === uid || owned.has(String(cabinet))) stored.delete(key);
      }
    }
  }

  /** What `rows` holds on the server now, whoever it belongs to. */
  rows(table: string): Row[] {
    return [...this.tables.get(table)!.values()].map((row) => ({ ...row }));
  }

  /** A row a statement wrote this long before the latest one: a transaction that committed late. */
  insertLate(table: string, row: Row, microsBefore: number): void {
    const latest = Math.max(...this.rows(table).map((stored) => micros(String(stored.updated_at))));
    const stored = { created_at: timestamptz(latest - microsBefore), deleted_at: null, tombstone_version: 0, ...row, updated_at: timestamptz(latest - microsBefore) };
    this.tables.get(table)!.set(this.keyOf(table, stored), stored);
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
      const key = this.keyOf(table, row);
      const old = staged.get(key);
      if (!this.writable(table, row, uid, old) || (old && !this.visible(table, old, uid))) {
        return { data: null, error: { message: `new row violates row-level security policy for table "${table}"`, code: "42501" } };
      }
      let next: Row = { ...old, ...row };
      if (old) this.guard(table, next, old, uid);
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

  private select(table: string, filter: Filter): Reply {
    const uid = this.user;
    if (!uid) return { data: null, error: { message: "permission denied for table " + table, code: "42501" } };
    const sorted = this.rows(table)
      .filter((row) => this.visible(table, row, uid) && Object.entries(filter.eq).every(([column, value]) => String(row[column]) === value))
      .map((row) => ({ row, us: micros(String(row.updated_at)) }))
      .filter(({ row, us }) =>
        filter.after
          ? us > filter.after.us || (us === filter.after.us && String(row.id) > filter.after.id)
          : us >= (filter.from ?? 0))
      .sort((a, b) => a.us - b.us || String(a.row.id).localeCompare(String(b.row.id)));
    return { data: sorted.slice(0, filter.limit).map(({ row }) => row), error: null };
  }

  private isLive(cabinet: string): boolean {
    const row = this.tables.get("cabinets")!.get(cabinet);
    return row != null && row.deleted_at == null;
  }

  /** `private.open_to_share`: a live household the caller owns, its owner among its members. */
  private openToShare(cabinet: string, uid: string, ownerName: unknown): Failure | null {
    // The server always holds the personal cabinet, whether or not this one has its row.
    if (cabinet === uid) return { message: "the personal cabinet is not shared", code: "FA001" };
    if (this.tables.get("cabinets")!.get(cabinet)?.owner_id !== uid || !this.isLive(cabinet)) return { message: "not the owner of this cabinet", code: "42501" };
    if (!this.rows("cabinet_members").some((row) => row.cabinet_id === cabinet && row.user_id === uid)) {
      this.insertAsServer("cabinet_members", { id: crypto.randomUUID(), cabinet_id: cabinet, user_id: uid, role: "owner", name: ownerName ?? "", seen_at: null });
    }
    return null;
  }

  /** `private.admit`: the person joins as `role`, a removed member comes back, and the offer to them goes. */
  private admit(cabinet: string, role: string, uid: string, name: unknown): void {
    this.offers.delete(`${cabinet}|${uid}`);
    if (this.isOwner(cabinet, uid)) return;
    const held = this.rows("cabinet_members").find((row) => row.cabinet_id === cabinet && row.user_id === uid);
    const at = timestamptz(this.now());
    const id = String(held?.id ?? crypto.randomUUID());
    this.tables.get("cabinet_members")!.set(id, { created_at: at, tombstone_version: 0, seen_at: null, ...held, id, cabinet_id: cabinet, user_id: uid, role, name: name ?? "", deleted_at: null, updated_at: at });
  }

  /** `private.my_offers()`: a hash of the offers to `uid` on live households, null when none waits. */
  private offersHash(uid: string): string | null {
    const mine = [...this.offers.values()].filter((offer) => offer.to === uid && this.isLive(offer.cabinet));
    if (mine.length === 0) return null;
    const hex = createHash("md5").update(mine.map((offer) => `${offer.cabinet}:${offer.role}`).sort().join(",")).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Migration 6's definers, as the client calls them through their invokers. */
  private sharing(name: string, args: Record<string, unknown>, uid: string): Reply | null {
    const ok = (data: unknown): Reply => ({ data, error: null });
    const refused = (error: Failure): Reply => ({ data: null, error });
    // PostgREST finds a function by its argument names; any other set is no function at all.
    const signature = SHARING_ARGS[name];
    if (!signature) return null;
    if (Object.keys(args).sort().join() !== [...signature].sort().join()) return refused({ message: `Could not find the function public.${name}`, code: "PGRST202" });
    const invalid = (message: string) => refused({ message, code: "22023" });
    const cabinet = String(args.cabinet);
    const roleOk = (role: unknown) => role === "editor" || role === "viewer";
    if (name === "create_cabinet_invite") {
      if (!roleOk(args.invite_role)) return invalid("invalid role");
      const closed = this.openToShare(cabinet, uid, args.owner_name);
      if (closed) return refused(closed);
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      this.invites.set(token, { cabinet, role: String(args.invite_role), by: uid });
      return ok(token);
    }
    if (name === "cancel_cabinet_invites") {
      const mine = [...this.invites].filter(([, invite]) => invite.cabinet === cabinet && this.tables.get("cabinets")!.get(cabinet)?.owner_id === uid);
      for (const [token] of mine) this.invites.delete(token);
      return ok(mine.length);
    }
    if (name === "peek_cabinet_invite") {
      const invite = this.invites.get(String(args.token));
      const row = invite && this.isLive(invite.cabinet) ? this.tables.get("cabinets")!.get(invite.cabinet)! : null;
      const owner = row && this.rows("cabinet_members").find((member) => member.cabinet_id === row.id && member.user_id === row.owner_id);
      return ok(row ? [{ name: row.name, inviter: owner?.name ?? "", role: invite!.role }] : []);
    }
    if (name === "accept_cabinet_invite") {
      const invite = this.invites.get(String(args.token));
      this.invites.delete(String(args.token));
      if (!invite || !this.isLive(invite.cabinet)) return invalid("invite not found");
      this.admit(invite.cabinet, invite.role, uid, args.member_name);
      return ok(invite.cabinet);
    }
    if (name === "offer_cabinet") {
      const person = typeof args.person === "string" ? args.person : null;
      if (args.role == null) {
        if (person && this.tables.get("cabinets")!.get(cabinet)?.owner_id === uid) this.offers.delete(`${cabinet}|${person}`);
        return ok(null);
      }
      if (!roleOk(args.role)) return invalid("invalid role");
      const closed = this.openToShare(cabinet, uid, args.owner_name);
      if (closed) return refused(closed);
      if (!person || person === uid) return invalid("an offer is to someone else");
      if (this.membership(cabinet, person)) return refused({ message: "already in this cabinet", code: "FA002" });
      const shared = this.rows("cabinet_members").some(
        (theirs) => theirs.user_id === person && theirs.deleted_at == null && this.isLive(String(theirs.cabinet_id)) && this.membership(theirs.cabinet_id, uid),
      );
      if (!shared) return refused({ message: "shares no household with you", code: "FA003" });
      this.offers.set(`${cabinet}|${person}`, { cabinet, role: String(args.role), by: uid, to: person });
      return ok(null);
    }
    if (name === "cabinet_offers") {
      const offers = [...this.offers.values()].filter((offer) => (offer.to === uid || offer.by === uid) && this.isLive(offer.cabinet));
      return ok(offers.map((offer) => {
        const row = this.tables.get("cabinets")!.get(offer.cabinet)!;
        const owner = this.rows("cabinet_members").find((member) => member.cabinet_id === offer.cabinet && member.user_id === row.owner_id);
        return { cabinet_id: offer.cabinet, cabinet_name: row.name, role: offer.role, from_name: owner?.name ?? "", to_user: offer.to };
      }));
    }
    if (name === "answer_cabinet_offer") {
      if (typeof args.accept !== "boolean") return invalid("accept or decline");
      const offer = this.offers.get(`${cabinet}|${uid}`);
      if (!offer) return invalid("offer not found");
      this.offers.delete(`${cabinet}|${uid}`);
      if (!args.accept) return ok(null);
      if (!this.isLive(cabinet)) {
        // The refusal rolls the whole call back, the offer with it.
        this.offers.set(`${cabinet}|${uid}`, offer);
        return invalid("offer not found");
      }
      this.admit(cabinet, offer.role, uid, args.member_name);
      return ok(cabinet);
    }
    throw new Error(`sharing RPC ${name} has a signature and no answer`);
  }

  private rpc(name: string, args: Record<string, unknown> = {}): Reply {
    const uid = this.user;
    if (!uid) return { data: null, error: { message: "permission denied for function " + name, code: "42501" } };
    const shared = this.sharing(name, args, uid);
    if (shared) return shared;
    if (name === "unnamed_photos") {
      const named = (photo: string) => PHOTO_TABLES.some((table) => this.rows(table).some((row) => row.photo_id === photo && row.deleted_at == null));
      const month = Date.now() - 30 * 86_400_000;
      return { data: [...this.objects].filter(([path, object]) => object.owner === uid && object.at < month && !named(PHOTO_OBJECT.exec(path)![1]!)).map(([path]) => path), error: null };
    }
    if (name === "own_photo_objects") {
      return { data: [...this.objects].filter(([, object]) => object.owner === uid).map(([path]) => path), error: null };
    }
    if (name !== "sync_cursors") return { data: null, error: { message: "no such function", code: "PGRST202" } };
    return {
      data: [
        ...TABLES.map((table) => {
          const head = (this.select(table, { limit: Number.MAX_SAFE_INTEGER, eq: {} }).data as Row[]).at(-1);
          return { table_name: table, max_updated_at: head?.updated_at ?? null, max_id: head?.id ?? null };
        }),
        { table_name: "offers", max_updated_at: null, max_id: this.offersHash(uid) },
      ],
      error: null,
    };
  }

  /** `private.can_see_photo`: a row the caller may read names it. */
  private canSeePhoto(photo: string, uid: string): boolean {
    return PHOTO_TABLES.some((table) => this.rows(table).some((row) => row.photo_id === photo && this.canRead(row.cabinet_id, uid)));
  }

  /** `private.can_place_photo`: the uploader may write every cabinet a row naming it is in. */
  private canPlacePhoto(photo: string, uid: string): boolean {
    return PHOTO_TABLES.every((table) => this.rows(table).every((row) => row.photo_id !== photo || this.canWrite(row.cabinet_id, uid)));
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
      const filter: Filter = { limit: 1000, eq: {} };
      const builder = {
        upsert(rows: Row[], options: { onConflict?: string }) {
          upserting = rows;
          conflict = options.onConflict;
          return builder;
        },
        select: () => builder,
        order: () => builder,
        eq(column: string, value: string) {
          // A row by its key, to learn its generation; or a cabinet's rows, for a member who has just joined.
          if (column !== scopeOf(table) && column !== "id" && column !== "cabinet_id") throw new Error(`unexpected filter on ${column}`);
          filter.eq[column] = value;
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
            const scope = scopeOf(table);
            const key = scope ? `${scope},id` : "id";
            if (conflict !== key) throw new Error(`upsert ${table} on ${conflict}, not ${key}`);
            return cloud.upsert(table, upserting);
          });
        },
      };
      return builder;
    };
    return {
      from,
      rpc(name: string, args?: Record<string, unknown>) {
        // Lazy, as PostgREST's builder is: nothing is asked until it is awaited.
        const call = (signal?: AbortSignal) => cloud.answer(`rpc ${name}`, signal, () => cloud.rpc(name, args));
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
      storage: {
        from: (bucket: string) => {
          if (bucket !== "photos") throw new Error(`unexpected bucket ${bucket}`);
          return {
            upload: (path: string, body: Uint8Array, options: { contentType?: string; upsert?: boolean }) =>
              cloud.answer(`upload ${path}`, undefined, () => {
                const uid = cloud.user;
                const existing = cloud.objects.get(path);
                const photo = PHOTO_OBJECT.exec(path)?.[1];
                const refused = { data: null, error: { message: "new row violates row-level security policy", status: 403 } };
                if (!uid || !photo || options.contentType !== "image/jpeg") return refused;
                if (existing && (!options.upsert || existing.owner !== uid)) return { data: null, error: { message: "The resource already exists", status: 409 } };
                if (!existing && !cloud.canPlacePhoto(photo, uid)) return refused;
                cloud.objects.set(path, { owner: uid, bytes: new Uint8Array(body), at: Date.now() });
                return { data: { path }, error: null };
              }),
            download: (path: string) =>
              cloud.answer(`download ${path}`, undefined, () => {
                if (cloud.downloadFailure) return { data: null, error: cloud.downloadFailure };
                const uid = cloud.user;
                const object = cloud.objects.get(path);
                const photo = PHOTO_OBJECT.exec(path)?.[1];
                if (!uid || !object || !photo || (object.owner !== uid && !cloud.canSeePhoto(photo, uid))) {
                  return { data: null, error: { message: "Object not found", status: 404 } };
                }
                return { data: new Blob([object.bytes as BlobPart], { type: "image/jpeg" }), error: null };
              }),
            remove: (paths: string[]) =>
              cloud.answer(`remove ${paths.length}`, undefined, () => {
                for (const path of paths) if (cloud.objects.get(path)?.owner === cloud.user) cloud.objects.delete(path);
                return { data: [], error: null };
              }),
          };
        },
      },
    };
  }
}
