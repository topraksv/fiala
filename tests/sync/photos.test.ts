import { describe, expect, it, vi } from "vitest";

// The pure rule never reaches the database or the server; both clients are mocked only to keep react-native out.
vi.mock("../../src/db/client", () => ({ getSqliteAsync: async () => null }));
vi.mock("../../src/sync/supabase", () => ({ getSupabase: () => null }));

const { refusedForGood } = await import("../../src/sync/photos");

describe("refusedForGood", () => {
  it("tells a photo refused for good from a token Storage would take once renewed", () => {
    expect(refusedForGood({ status: 403, message: "new row violates row-level security policy" })).toBe(true);
    expect(refusedForGood({ status: 409, message: "The resource already exists" })).toBe(true);
    expect(refusedForGood({ status: 400, message: "jwt expired" })).toBe(false);
    expect(refusedForGood({ status: 403, message: "invalid signature" })).toBe(false);
    for (const status of [401, 408, 429, 500]) expect(refusedForGood({ status, message: "x" })).toBe(false);
    expect(refusedForGood({ message: "Failed to fetch" })).toBe(false);
    expect(refusedForGood({ status: 400, message: "Invalid key" }), "the lowest status Storage refuses with").toBe(true);
    expect(refusedForGood({ status: 399, message: "x" })).toBe(false);
    expect(refusedForGood({ status: 499, message: "x" })).toBe(true);
    for (const message of ["Unauthorized", "unauthorised", "Token invalid", "signature mismatch", "JWT expired"]) {
      expect(refusedForGood({ status: 403, message }), message).toBe(false);
    }
  });
});
