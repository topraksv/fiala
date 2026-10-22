/**
 * The account's pure rules (SPEC 2.1): Auth's English errors in Turkish, the
 * previous sign-in, the e-mailed codes, and the e-mail change link, which
 * reaches the app with its token unspent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { friendlyAuthError } from "../../src/auth/auth-errors";
import { loadPreviousLogin, recordSuccessfulLogin, startLoginHistory, type LoginHistoryStorage } from "../../src/auth/login-history";
import { tr } from "../../src/i18n/tr";

function memoryStorage(): LoginHistoryStorage {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  };
}

describe("the previous sign-in", () => {
  it("is the one before this session, across two sign-ins", async () => {
    const storage = memoryStorage();
    expect(await recordSuccessfulLogin(storage, "u1", "2026-09-26T08:00:00.000Z")).toBeNull();
    expect(await recordSuccessfulLogin(storage, "u1", "2026-09-26T10:30:00.000Z")).toBe("2026-09-26T08:00:00.000Z");
    expect(await loadPreviousLogin(storage, "u1")).toBe("2026-09-26T08:00:00.000Z");
  });

  it("starts empty for a new account and is seeded only once for a session already open", async () => {
    const fresh = memoryStorage();
    await startLoginHistory(fresh, "u1", "2026-09-26T08:00:00.000Z");
    expect(await loadPreviousLogin(fresh, "u1")).toBeNull();
    expect(await recordSuccessfulLogin(fresh, "u1", "2026-09-27T09:00:00.000Z")).toBe("2026-09-26T08:00:00.000Z");
  });
});

describe("Auth's errors, in Turkish", () => {
  it("gives each family its own sentence", () => {
    expect(friendlyAuthError("Invalid login credentials")).toBe(tr.auth.errInvalidCredentials);
    expect(friendlyAuthError("User already registered")).toBe(tr.auth.errUserExists);
    expect(friendlyAuthError("Request rate limit reached")).toBe(tr.auth.errRateLimit);
    // GoTrue's per-address throttle, measured: no "rate limit" in the words.
    expect(friendlyAuthError("For security purposes, you can only request this after 41 seconds.")).toBe(tr.auth.errRateLimit);
    expect(friendlyAuthError("TypeError: Network request failed")).toBe(tr.auth.errNetwork);
    expect(friendlyAuthError("Failed to fetch")).toBe(tr.auth.errNetwork);
    expect(friendlyAuthError("Password should be at least 8 characters")).toBe(tr.auth.errWeakPassword);
    expect(friendlyAuthError("Email not confirmed")).toBe(tr.auth.errEmailNotConfirmed);
    expect(friendlyAuthError("Email address not authorized")).toBe(tr.auth.errEmailDelivery);
    expect(friendlyAuthError("Error sending recovery email")).toBe(tr.auth.errEmailDelivery);
    // Auth's answer when SMTP refuses a sign-up.
    expect(friendlyAuthError("Error sending confirmation email")).toBe(tr.auth.errEmailDelivery);
    expect(friendlyAuthError("Error sending email change email")).toBe(tr.auth.errEmailDelivery);
    expect(friendlyAuthError("Unable to validate email address: invalid format")).toBe(tr.auth.errInvalidEmail);
  });

  it("names an ended session and a server failure rather than falling back", () => {
    expect(friendlyAuthError("Invalid Refresh Token: Refresh Token Not Found")).toBe(tr.auth.errSessionExpired);
    expect(friendlyAuthError("JWT expired")).toBe(tr.auth.errSessionExpired);
    // Auth's same-password refusal says "password should be", which the
    // weak-password rule would otherwise claim.
    expect(friendlyAuthError("New password should be different from the old password.")).toBe(tr.auth.errSamePassword);
    expect(friendlyAuthError("same_password")).toBe(tr.auth.errSamePassword);
    expect(friendlyAuthError("Internal Server Error")).toBe(tr.auth.errService);
    expect(friendlyAuthError("Error 503: Service Unavailable")).toBe(tr.auth.errService);
    expect(friendlyAuthError("something unexpected")).toBe(tr.auth.errGeneric);
  });
});

describe("the server's account settings", () => {
  const config = readFileSync(join(import.meta.dirname, "../../supabase/config.toml"), "utf8");

  it("asks for a strong password, the current one to change it, and a confirmed address", () => {
    expect(config).toMatch(/^minimum_password_length = 8$/m);
    expect(config).toMatch(/^secure_password_change = true$/m);
    expect(config).toMatch(/\[auth\.email\][\s\S]*?^enable_confirmations = true$/m);
  });

  // A code, not a link: nothing a mail scanner fetches can spend it, and it
  // works on whichever device reads the mail.
  it.each([
    ["confirmation", "Fiala hesabını onayla"],
    ["recovery", "Fiala şifre yenileme kodun"],
    ["email_change", "Fiala e-posta adresi değişikliği"],
  ])("mails the %s as a five-minute code with no link, subject or body built to pass spam filters", (kind, subject) => {
    expect(config).toMatch(/^otp_expiry = 300$/m);
    expect(config).toMatch(new RegExp(`\\[auth\\.email\\.template\\.${kind}\\]\\nsubject = "${subject}"\\ncontent_path = "\\./supabase/templates/${kind}\\.html"$`, "m"));
    const template = readFileSync(join(import.meta.dirname, `../../supabase/templates/${kind}.html`), "utf8");
    expect(template).toContain("{{ .Token }}");
    expect(template).not.toMatch(/href=|<img|TokenHash|ConfirmationURL|&#(8199|65279|847);|Helix/);
  });

  it("asks both addresses of an e-mail change for a code of their own, and leaves no address to come back to", () => {
    expect(config).toMatch(/^double_confirm_changes = true$/m);
    expect(config).toMatch(/^additional_redirect_urls = \[\]$/m);
    const template = readFileSync(join(import.meta.dirname, "../../supabase/templates/email_change.html"), "utf8");
    expect(template).toContain("{{ .NewEmail }}");
    expect(template).not.toMatch(/Fiala'(e|i|in|de|den|le)\b/);
  });

  it("lets a signed-in account delete itself and nothing else", () => {
    const sql = readFileSync(join(import.meta.dirname, "../../supabase/migrations/00000000000001_baseline.sql"), "utf8");
    expect(sql).toMatch(/function definers\.delete_own_account\(\)\s+returns void/);
    expect(sql).toMatch(/security definer\s+set search_path = ''/);
    expect(sql).toMatch(/delete from auth\.users where id = auth\.uid\(\);/);
    expect(sql).toMatch(/revoke all on function public\.delete_own_account\(\) from public, anon, authenticated, service_role;/);
    expect(sql.match(/^grant .*delete_own_account.*$/gm)).toEqual([
      "grant execute on function definers.delete_own_account() to authenticated;",
      "grant execute on function public.delete_own_account() to authenticated;",
    ]);
  });

});
