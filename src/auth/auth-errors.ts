/** Supabase auth errors arrive in English; map them to the Turkish UI. */

import { tr } from "../i18n/tr";

export function friendlyAuthError(raw: string): string {
  if (/invalid login credentials|invalid_credentials/i.test(raw)) return tr.auth.errInvalidCredentials;
  if (/already registered|already exists/i.test(raw)) return tr.auth.errUserExists;
  if (/rate limit|too many|only request this after/i.test(raw)) return tr.auth.errRateLimit;
  if (/refresh token|jwt|session[_ ](expired|missing|not found)/i.test(raw)) return tr.auth.errSessionExpired;
  if (/network|fetch|timeout|connection/i.test(raw)) return tr.auth.errNetwork;
  // Before the weak-password rule: Auth says "New password should be different
  // from the old password", which that rule matched — so reusing the old
  // password was reported as a password that was too short.
  if (/different from the old password|same_password/i.test(raw)) return tr.auth.errSamePassword;
  if (/password should be|weak password/i.test(raw)) return tr.auth.errWeakPassword;
  if (/email not confirmed/i.test(raw)) return tr.auth.errEmailNotConfirmed;
  if (/email address not authorized|error sending [a-z ]*email|smtp.*(not configured|failed)/i.test(raw)) {
    return tr.auth.errEmailDelivery;
  }
  if (/invalid.*email|email.*invalid|validate email/i.test(raw)) return tr.auth.errInvalidEmail;
  if (/\b5\d\d\b|internal server|service unavailable/i.test(raw)) return tr.auth.errService;
  return tr.auth.errGeneric;
}
