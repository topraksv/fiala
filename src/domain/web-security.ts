/**
 * The web build's Content Security Policy (`src/app/+html.tsx`).
 * GitHub Pages sends no headers, so it is a meta tag, and `connect-src` pins
 * the one project the build was made for: a script injected into the page can
 * still run, since the export's inline bootstrap needs `'unsafe-inline'`, but
 * it can send what it read nowhere else.
 *
 * Every picture reaches the page as data, so `img-src` names no host.
 */

/**
 * The one Supabase origin a build may reach, or null: a hosted project by
 * HTTPS, or the local stack `supabase start` serves on this machine, for
 * trying a build before its migrations reach the project. A release never
 * carries the local one: CI's `bundle:check` refuses any URL but a hosted
 * project's.
 */
export function trustedSupabaseOrigin(raw: string | undefined): string | null {
  try {
    // None is "undefined", which is no URL.
    const url = new URL(String(raw));
    const plain = !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    const hosted = url.protocol === "https:" && !url.port && /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname);
    const local = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
    return plain && (hosted || local) ? url.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(supabaseUrl: string | undefined): string {
  const origin = trustedSupabaseOrigin(supabaseUrl);
  // The live households' socket (`src/sync/live.ts`): the same project over `wss:`, or `ws:` on the local stack.
  const project = origin ? ` ${origin} ${origin.replace("http", "ws")}` : "";
  return [
    "default-src 'self'",
    // For the sqlite worker's WebAssembly: Chromium gives a worker loaded by URL
    // the policy of its own response, not this one, and boots without it.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${project}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
