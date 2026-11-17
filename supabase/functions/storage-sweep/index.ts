/**
 * Removes the Storage objects the database names as swept:
 * `public.swept_objects()` decides which, this function frees them through
 * the Storage API, the only path that removes the bytes (the migration that schedules it).
 *
 * Called by pg_cron with a shared secret, never by a client. The same file
 * runs in every member of the family; each member's SQL holds its own rule.
 */

// Exact version: the frozen deno.lock checks bytes, the version picks which.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";

/** The SQL returns at most this many a call; a run stops after this many calls. */
const ROUNDS = 20;

Deno.serve(async (request) => {
  const secret = Deno.env.get("SWEEP_SECRET");
  if (!secret || request.headers.get("x-sweep-secret") !== secret) return new Response("Forbidden", { status: 403 });
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let removed = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const { data, error } = await client.rpc("swept_objects");
    if (error) throw error;
    const rows = (data ?? []) as { bucket_id: string; name: string }[];
    const buckets = Map.groupBy(rows, (row) => row.bucket_id);
    let freed = 0;
    for (const [bucket, objects] of buckets) {
      // A hundred a call, as the apps remove theirs.
      for (let at = 0; at < objects.length; at += 100) {
        const names = objects.slice(at, at + 100).map((o) => o.name);
        const { data: gone, error: refused } = await client.storage.from(bucket).remove(names);
        if (refused) throw refused;
        freed += gone?.length ?? 0;
      }
    }
    removed += freed;
    // Nothing left, or nothing the API would free: another round would repeat this one.
    if (freed === 0) break;
  }
  return new Response(JSON.stringify({ removed }), { headers: { "Content-Type": "application/json" } });
});
