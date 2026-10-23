/**
 * An invitation's link, read and held for a sign-in. The server's half is
 * driven in `engine.test.ts`, over the fake cloud.
 */

import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => new Map<string, string>());

// The pure rules never reach the server; the client is mocked only to keep react-native out.
vi.mock("../../src/sync/supabase", () => ({ getSupabase: () => null }));
vi.mock("../../src/services/kv", () => ({
  kv: {
    get: async (key: string) => kv.get(key) ?? null,
    set: async (key: string, value: string) => void kv.set(key, value),
    remove: async (key: string) => void kv.delete(key),
  },
}));

const { heldInvite, holdInvite, inviteFromPage, inviteLink, inviteTokenFrom, useOffers } = await import("../../src/sync/sharing");

describe("an invitation's link", () => {
  it("reads a link, or its bare token, and nothing else", () => {
    const token = "a".repeat(64);
    expect(inviteLink(token)).toBe(`https://topraksv.github.io/fiala/invite#${token}`);
    expect(inviteTokenFrom(` ${inviteLink(token)} `)).toBe(token);
    expect(inviteTokenFrom("a".repeat(65))).toBeNull();
    expect(inviteTokenFrom(token)).toBe(token);
    expect(inviteTokenFrom("https://example.com/fiala/invite#" + token)).toBeNull();
    expect(inviteTokenFrom("a".repeat(63))).toBeNull();
  });

  it("keeps the token a web invitation opened with, and only on its page", () => {
    const token = "b".repeat(64);
    expect(inviteFromPage({ pathname: "/fiala/invite", hash: `#${token}` })).toBe(token);
    expect(inviteFromPage({ pathname: "/fiala/invite/", hash: `#${token}` })).toBe(token);
    expect(inviteFromPage({ pathname: "/fiala/", hash: `#${token}` })).toBeNull();
    expect(inviteFromPage({ pathname: "/fiala/invite/other", hash: `#${token}` })).toBeNull();
    expect(inviteFromPage({ pathname: "/fiala/invite", hash: "#nope" })).toBeNull();
    expect(inviteFromPage(undefined)).toBeNull();
  });
  it("holds a web invitation for the first sign-in, through a reload, for the link's own seven days", async () => {
    const token = "c".repeat(64);
    const stored = (at: number) => kv.set("fiala.invite", JSON.stringify({ token, at }));
    await holdInvite(token);
    expect(JSON.parse(kv.get("fiala.invite")!), "kept for a reload too").toMatchObject({ token });
    kv.set("fiala.invite", JSON.stringify({ token: "d".repeat(64), at: Date.now() }));
    expect(await heldInvite(), "the sign-in screen only looks, at the one held in memory").toBe(token);
    expect(await heldInvite({ take: true })).toBe(token);
    expect(await heldInvite(), "the next account on this browser is not sent into it").toBeNull();
    stored(Date.now());
    expect(await heldInvite(), "a reload, or the confirmation's tab, finds it").toBe(token);
    stored(Date.now() - 6 * 24 * 60 * 60 * 1000);
    expect(await heldInvite({ take: true }), "six days on").toBe(token);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    stored(1_000_000_000_000 - 7 * 24 * 60 * 60 * 1000);
    expect(await heldInvite(), "the seventh day is the link's last").toBeNull();
    now.mockRestore();
    for (const value of ["null", JSON.stringify({ token: 5, at: Date.now() }), JSON.stringify({ token }), "{"]) {
      kv.set("fiala.invite", value);
      expect(await heldInvite(), value).toBeNull();
    }
  });

  it("starts a session with no offer seen and none waiting", () => {
    expect(useOffers.getState()).toEqual({ seen: undefined, received: [] });
  });
});
