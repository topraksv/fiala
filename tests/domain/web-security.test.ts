import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, trustedSupabaseOrigin } from "../../src/domain/web-security";

const directive = (policy: string, name: string) => policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";

describe("the web build's network boundary", () => {
  it("trusts one HTTPS Supabase project origin, or this machine's local stack, and nothing shaped like either", () => {
    expect(trustedSupabaseOrigin("https://project-ref.supabase.co")).toBe("https://project-ref.supabase.co");
    expect(trustedSupabaseOrigin("https://project-ref.supabase.co/")).toBe("https://project-ref.supabase.co");
    expect(trustedSupabaseOrigin("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
    for (const raw of [
      undefined,
      "",
      "not a url",
      "http://project-ref.supabase.co",
      "https://other.supabase.co/rest/v1",
      "https://supabase.co.attacker.example",
      "https://user@project-ref.supabase.co",
      "https://project-ref.supabase.co:8443",
      "https://project-ref.supabase.co/?next=x",
      "https://project-ref.supabase.co/#x",
      "https://sub.project-ref.supabase.co",
      "https://project-ref.supabase.co.attacker.example",
      "http://127.0.0.1",
      "http://127.0.0.1:54321/rest/v1",
      "http://user@127.0.0.1:54321",
      "http://127.0.0.2:54321",
      "http://localhost:54321",
      "https://127.0.0.1:54321",
    ])
      expect(trustedSupabaseOrigin(raw)).toBeNull();
  });

  it("lets the page reach its project by HTTPS", () => {
    const policy = contentSecurityPolicy("https://project-ref.supabase.co");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' https://project-ref.supabase.co");
  });

  it("says every other source the page may use, in this order", () => {
    expect(contentSecurityPolicy(undefined).split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]);
  });

  it("reaches nothing but itself when the build has no project", () => {
    expect(directive(contentSecurityPolicy(undefined), "connect-src")).toBe("connect-src 'self'");
    expect(directive(contentSecurityPolicy("https://evil.example"), "connect-src")).toBe("connect-src 'self'");
  });

  it("draws pictures only from itself and the data a row carries, and frames nothing", () => {
    const policy = contentSecurityPolicy(undefined);
    expect(directive(policy, "img-src")).toBe("img-src 'self' data: blob:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("base-uri 'self'");
  });
});
