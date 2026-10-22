import { describe, expect, it } from "vitest";
import {
  createSecureChunkedStorage,
  MAX_AUTH_CHUNKS,
  SECURE_STORAGE_CHUNK_SIZE,
  type SecureStorageBackend,
} from "../../src/sync/secure-chunked-storage";

function memoryBackend(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let reads = 0;
  const backend: SecureStorageBackend = {
    async getItemAsync(key) {
      reads += 1;
      return values.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      values.set(key, value);
    },
    async deleteItemAsync(key) {
      values.delete(key);
    },
  };
  return { backend, values, reads: () => reads };
}

describe("bounded secure auth storage", () => {
  it("round-trips short and chunked sessions and removes stale chunks", async () => {
    const memory = memoryBackend();
    const storage = createSecureChunkedStorage(memory.backend);
    const long = "x".repeat(SECURE_STORAGE_CHUNK_SIZE * 2 + 7);
    await storage.setItem("session", long);
    expect(memory.values.get("session.n")).toBe("3");
    expect(await storage.getItem("session")).toBe(long);

    await storage.setItem("session", "short");
    expect(await storage.getItem("session")).toBe("short");
    expect(memory.values.has("session.n")).toBe(false);
    expect(memory.values.has("session.0")).toBe(false);
  });

  it("fails closed without an unbounded read when the marker is corrupt", async () => {
    for (const marker of ["-1", "0", "NaN", "1.5", "999999999"]) {
      const memory = memoryBackend({ "session.n": marker });
      const storage = createSecureChunkedStorage(memory.backend);
      expect(await storage.getItem("session")).toBeNull();
      expect(memory.reads()).toBe(1);
    }
  });

  it("rejects oversized sessions before writing any chunks", async () => {
    const memory = memoryBackend();
    const storage = createSecureChunkedStorage(memory.backend);
    await expect(storage.setItem("session", "x".repeat(SECURE_STORAGE_CHUNK_SIZE * MAX_AUTH_CHUNKS + 1)))
      .rejects.toThrow(/exceeds secure storage capacity/);
    expect(memory.values.size).toBe(0);
  });

  it("cleans the bounded legacy range even when the marker is corrupt", async () => {
    const memory = memoryBackend({ "session.n": "Infinity", "session.63": "orphan", session: "legacy" });
    await createSecureChunkedStorage(memory.backend).removeItem("session");
    expect(memory.values.size).toBe(0);
  });
});
