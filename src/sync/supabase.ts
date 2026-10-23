/**
 * The Supabase client. The session is kept
 * on the device — SecureStore on a phone, chunked past its 2 KB value limit;
 * localStorage on the web — so the app opens offline, and a refresh that fails
 * never stands between the person and their data.
 */

import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import { createSecureChunkedStorage } from "./secure-chunked-storage";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** False in a build without `.env`, which then runs on the device alone (`src/auth/session.ts`). */
export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;
const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: {
        storage: Platform.OS === "web" ? undefined : createSecureChunkedStorage(SecureStore),
        autoRefreshToken: true,
        persistSession: true,
        // Every auth mail carries a code and no link, so no address the page
        // opens on holds a session to take.
        detectSessionInUrl: false,
        flowType: "pkce",
      },
    });
    client.auth.onAuthStateChange((event, session) => {
      for (const listener of listeners) listener(event, session);
    });
  }
  return client;
}

/** What `src/sync/live.ts` opens its own Realtime client with: the project, its publishable key, and the session's token on each heartbeat. */
export function realtimeAccess(): { url: string; apiKey: string; accessToken: () => Promise<string | null> } | null {
  const supabase = getSupabase();
  if (!supabase) return null;
  return {
    url: url!,
    apiKey: anonKey!,
    accessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  };
}

/** One Supabase listener for the app; a callback must not await auth work (Supabase's rule). */
export function subscribeSupabaseAuthEvents(listener: (event: AuthChangeEvent, session: Session | null) => void): () => void {
  getSupabase();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The reset code's client, sharing nothing with the app's own. Unpersisted: the web mirrors a persisted
 * session to every tab, so a reset beside a signed-in tab would hand that tab another account.
 * Implicit, so it needs no PKCE verifier; a reset code is redeemed here with `verifyOtp`.
 */
export function createRecoveryClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  return createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit", storageKey: "fiala-password-recovery" },
  });
}
