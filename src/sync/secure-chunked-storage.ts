/** SecureStore under Supabase's session: a keychain value past 2 KB warns and may fail, so the session is kept in chunks, bounded both ways. */

export interface SecureStorageBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

interface AsyncStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const SECURE_STORAGE_CHUNK_SIZE = 1900;
export const MAX_AUTH_CHUNKS = 64;

function validChunkCount(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_AUTH_CHUNKS ? count : null;
}

async function deleteChunks(backend: SecureStorageBackend, key: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await backend.deleteItemAsync(`${key}.${index}`);
  }
}

export function createSecureChunkedStorage(backend: SecureStorageBackend): AsyncStorageAdapter {
  return {
    async getItem(key) {
      const countRaw = await backend.getItemAsync(`${key}.n`);
      if (countRaw == null) return backend.getItemAsync(key);
      const count = validChunkCount(countRaw);
      if (count == null) return null;
      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const part = await backend.getItemAsync(`${key}.${index}`);
        if (part == null) return null;
        parts.push(part);
      }
      return parts.join("");
    },

    async setItem(key, value) {
      const countRaw = await backend.getItemAsync(`${key}.n`);
      const previousCount = validChunkCount(countRaw);
      const cleanupCount = countRaw == null ? 0 : (previousCount ?? MAX_AUTH_CHUNKS);
      if (value.length <= SECURE_STORAGE_CHUNK_SIZE) {
        await backend.setItemAsync(key, value);
        await deleteChunks(backend, key, cleanupCount);
        await backend.deleteItemAsync(`${key}.n`);
        return;
      }

      const count = Math.ceil(value.length / SECURE_STORAGE_CHUNK_SIZE);
      if (count > MAX_AUTH_CHUNKS) throw new Error("Auth session exceeds secure storage capacity");
      for (let index = 0; index < count; index += 1) {
        await backend.setItemAsync(
          `${key}.${index}`,
          value.slice(index * SECURE_STORAGE_CHUNK_SIZE, (index + 1) * SECURE_STORAGE_CHUNK_SIZE),
        );
      }
      await backend.setItemAsync(`${key}.n`, String(count));
      await backend.deleteItemAsync(key);
      for (let index = count; index < cleanupCount; index += 1) {
        await backend.deleteItemAsync(`${key}.${index}`);
      }
    },

    async removeItem(key) {
      await deleteChunks(backend, key, MAX_AUTH_CHUNKS);
      await backend.deleteItemAsync(`${key}.n`);
      await backend.deleteItemAsync(key);
    },
  };
}
