/**
 * Mails a feedback report to the owner (SPEC 4.1). Server-side because the
 * mail password must never reach a client, and the Supabase origin is already
 * in the CSP `connect-src`. It re-checks every rule `src/domain/feedback.ts` states.
 */

import { feedbackSubject } from "./subject.ts";
// Exact versions: the frozen deno.lock checks bytes, the version picks which.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import nodemailer from "npm:nodemailer@9.1.1";

/** Port 465 because Edge Functions refuse 25 and 587. Gmail rewrites a foreign
 *  `from`, so the reporter goes in `replyTo`. */
const SMTP_PORT = 465;
const FROM_NAME = "Fiala Geri Bildirim";
/** The address `tr.legal.contactEmail` already publishes. */
const OWNER_EMAIL = "topraksavli@hotmail.com";

const FEEDBACK_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
const FEEDBACK_MESSAGE_MIN = 10;
const FEEDBACK_MESSAGE_MAX = 4000;
const MAX_FEEDBACK_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FEEDBACK_IMAGES = 4;
const MAX_FEEDBACK_TOTAL_IMAGE_BYTES = 7 * 1024 * 1024;

/** Base64 carries 3 bytes in every 4 characters, so the decoded bound is 4/3. */
const BASE64_LENGTH_RATIO = 4 / 3;
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_FEEDBACK_IMAGE_BYTES * BASE64_LENGTH_RATIO) + 4;
const MAX_TOTAL_BASE64_LENGTH = Math.ceil(MAX_FEEDBACK_TOTAL_IMAGE_BYTES * BASE64_LENGTH_RATIO) + 16;

// Colours let the owner scan an inbox by category. Inline styles and tables
// only in the mail: clients drop <style> blocks and flexbox.
const CATEGORIES: Record<string, { label: string; bg: string; fg: string; mark: string }> = {
  visual: { label: "Görsel hata", bg: "#EED8CC", fg: "#7B3A28", mark: "🎨" },
  functional: { label: "Çalışmayan özellik", bg: "#F6D5D1", fg: "#8A2A22", mark: "🛠️" },
  performance: { label: "Yavaşlık", bg: "#EDDFC5", fg: "#775624", mark: "⏱️" },
  data: { label: "Yanlış veri", bg: "#F6D5D1", fg: "#8A2A22", mark: "📊" },
  suggestion: { label: "Öneri", bg: "#E2E1C9", fg: "#555937", mark: "💡" },
  other: { label: "Diğer", bg: "#E7DFD7", fg: "#3A3028", mark: "💬" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** HTML-escape, because the message is a person's prose going into an email. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const smtpUser = Deno.env.get("SMTP_USER");
  const smtpPass = Deno.env.get("SMTP_PASS");
  if (!smtpUser || !smtpPass) return json({ error: "not_configured" }, 503);

  // The caller's own token, not the service role. Signed out, there is no bearer
  // (an empty one would reach PostgREST as a broken token).
  const authorization = request.headers.get("Authorization");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    authorization ? { global: { headers: { Authorization: authorization } } } : {},
  );
  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user ?? null;

  // Claimed before the body is read, so a caller over the limit never reaches the
  // decode; in the database because isolates share no memory.
  const { data: allowed, error: limitError } = await supabase.rpc(user ? "record_feedback_send" : "record_signed_out_feedback_send");
  if (limitError) {
    console.error("feedback rate check failed", limitError.code ?? limitError.message);
    return json({ error: "send_failed" }, 502);
  }
  if (allowed !== true) return json({ error: "rate_limited" }, 429);

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) ?? {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const category = String(payload.category ?? "");
  if (!Object.hasOwn(CATEGORIES, category)) {
    return json({ error: "invalid_category" }, 400);
  }

  const message = String(payload.message ?? "").trim();
  if (message.length < FEEDBACK_MESSAGE_MIN || message.length > FEEDBACK_MESSAGE_MAX) {
    return json({ error: "invalid_message" }, 400);
  }

  // The address someone signed out gives; an account's is its own.
  const given = String(payload.replyTo ?? "").trim();
  if (!user && (given.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(given))) {
    return json({ error: "invalid_reply_to" }, 400);
  }
  const replyTo = user ? user.email ?? null : given;

  const platform = String(payload.platform ?? "bilinmiyor").slice(0, 40);
  const appVersion = String(payload.appVersion ?? "bilinmiyor").slice(0, 40);

  // Nothing here trusts the count, the size or the encoding the client claims.
  const rawImages: unknown[] = Array.isArray(payload.images) ? payload.images : [];
  if (rawImages.length > (user ? MAX_FEEDBACK_IMAGES : 0)) return json({ error: "too_many_images" }, 400);

  const attachments: { filename: string; content: string; encoding: "base64"; contentType: string }[] = [];
  let totalBase64 = 0;
  for (const entry of rawImages) {
    const image = entry as { mimeType?: unknown; base64?: unknown; filename?: unknown };
    const mimeType = String(image?.mimeType ?? "");
    const base64 = String(image?.base64 ?? "");
    if (!(FEEDBACK_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      return json({ error: "invalid_image_type" }, 400);
    }
    // Bound the STRING before decoding it: the point of the limit is to refuse
    // an oversized body without first allocating it.
    if (base64.length === 0 || base64.length > MAX_IMAGE_BASE64_LENGTH || !isBase64(base64)) {
      return json({ error: "invalid_image" }, 400);
    }
    totalBase64 += base64.length;
    if (totalBase64 > MAX_TOTAL_BASE64_LENGTH) return json({ error: "images_too_large" }, 400);
    const extension = mimeType.slice(6);
    const rawName = String(image?.filename ?? "").replace(/[^\w.-]/g, "").slice(0, 60);
    const name = rawName || `ekran-goruntusu-${attachments.length + 1}.${extension}`;
    // Two screenshots a phone named the same thing still arrive as two files a
    // mail client can tell apart.
    attachments.push({
      filename: attachments.some((existing) => existing.filename === name) ? `${attachments.length + 1}-${name}` : name,
      content: base64,
      encoding: "base64",
      contentType: mimeType,
    });
  }

  const tone = CATEGORIES[category];
  const sentAt = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "long", timeStyle: "short", timeZone: "Europe/Istanbul",
  }).format(new Date());
  const font = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const serif = "'IBM Plex Serif', Georgia, 'Times New Roman', serif";
  const metaRow = (label: string, value: string) => `
    <tr>
      <td style="padding:7px 0; font-family:${font}; font-size:13px; color:#6D6157; width:96px; vertical-align:top;">${label}</td>
      <td style="padding:7px 0; font-family:${font}; font-size:14px; color:#2A211B; vertical-align:top;">${value}</td>
    </tr>`;
  const reporter = escapeHtml(replyTo ?? user!.id);

  const html = `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0; padding:0; background-color:#F1EDE8;">
  <div style="display:none; max-height:0; overflow:hidden; font-size:1px; color:#F1EDE8;">${escapeHtml(message.slice(0, 120))}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F1EDE8;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;">
        <tr><td align="center" style="padding:0 0 18px 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="36" height="36" valign="middle" style="width:36px; height:36px;"><img src="https://topraksv.github.io/fiala/icons/email-mark.png" width="36" height="36" alt="" style="display:block; width:36px; height:36px; border:0; border-radius:10px;"></td>
            <td style="padding-left:10px; font-family:${serif}; font-size:20px; font-weight:600; color:#2A211B;">Fiala <span style="font-family:${font}; font-size:13px; font-weight:500; color:#6D6157;">· Geri bildirim</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="background-color:#FFFDFB; border:1px solid #E7DFD7; border-radius:18px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="height:6px; line-height:6px; font-size:0; background-color:#A55335; border-radius:18px 18px 0 0;">&nbsp;</td></tr>
            <tr><td style="padding:28px 32px 0 32px;">
              <span style="display:inline-block; padding:6px 12px; border-radius:999px; background-color:${tone.bg}; color:${tone.fg}; font-family:${font}; font-size:13px; font-weight:600;">${tone.mark}&nbsp; ${escapeHtml(tone.label)}</span>
              <h1 style="margin:16px 0 0 0; font-family:${serif}; font-size:24px; line-height:30px; font-weight:600; color:#2A211B;">Yeni bir geri bildirim geldi</h1>
            </td></tr>
            <tr><td style="padding:20px 32px 0 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F7F3EF; border-left:4px solid #A55335; border-radius:10px;">
                <tr><td style="padding:18px 20px; font-family:${font}; font-size:16px; line-height:26px; color:#2A211B; white-space:pre-wrap;">${escapeHtml(message)}</td></tr>
              </table>
            </td></tr>
            <tr><td style="padding:22px 32px 0 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #E7DFD7;">
                ${metaRow("Gönderen", `<a href="mailto:${reporter}" style="color:#A55335; text-decoration:none;">${reporter}</a>${user ? "" : " · giriş yapmadan"}`)}
                ${metaRow("Tarih", escapeHtml(sentAt))}
                ${metaRow("Cihaz", `${escapeHtml(platform)} · sürüm ${escapeHtml(appVersion)}`)}
                ${metaRow("Ekler", attachments.length === 0 ? "Ekran görüntüsü yok" : `📎 ${attachments.length} ekran görüntüsü`)}
              </table>
            </td></tr>
            <tr><td style="padding:22px 32px 30px 32px; font-family:${font}; font-size:13px; line-height:20px; color:#62564C;">
              ↩️ Bu maili yanıtladığında cevabın doğrudan <strong style="color:#3A3028;">${reporter}</strong> adresine gider.
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:18px 16px 4px 16px; font-family:${font}; font-size:12px; color:#6D6157;">Fiala uygulamasındaki Geri Bildirim ekranından gönderildi.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const transport = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com",
    port: SMTP_PORT,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
    // Inside the function's wall clock, with room to answer the client.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    await transport.sendMail({
      from: { name: FROM_NAME, address: smtpUser },
      to: OWNER_EMAIL,
      replyTo: replyTo ?? undefined,
      subject: feedbackSubject(category, message),
      html,
      attachments,
    });
  } catch (error) {
    // The server's reply can quote the reporter's own text back; log the codes
    // only, and tell the client nothing it could not already infer.
    const failure = error as { code?: string; responseCode?: number };
    console.error("smtp rejected the report", failure.code ?? "unknown", failure.responseCode ?? "");
    return json({ error: "send_failed" }, 502);
  }

  return json({ ok: true }, 200);
});
