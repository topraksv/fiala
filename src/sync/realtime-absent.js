/**
 * supabase-js's Realtime transport, replaced by a statement that it has none.
 *
 * supabase-js builds a `RealtimeClient` in its constructor whether or not
 * anything subscribes, and Metro does not tree-shake; `metro.config.js`
 * substitutes this file for supabase-js's import alone. A feature that needs
 * live channels opens its own client, loaded when first needed. `setAuth`,
 * which supabase-js calls by itself, does nothing, and the channel methods
 * throw: a channel that silently never delivers would surface as a tick that
 * never arrived.
 */

const UNAVAILABLE =
  "supabase.channel() is not bundled: metro.config.js substitutes " +
  "src/sync/realtime-absent.js for supabase-js's @supabase/realtime-js; " +
  "open a channel through a client of its own.";

export class RealtimeClient {
  setAuth() {}
  /** Honest and empty: there are no channels, and asking is not an error. */
  getChannels() {
    return [];
  }
  channel() {
    throw new Error(UNAVAILABLE);
  }
  removeChannel() {
    throw new Error(UNAVAILABLE);
  }
  removeAllChannels() {
    throw new Error(UNAVAILABLE);
  }
}
