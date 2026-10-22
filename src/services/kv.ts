/**
 * SecureStore on native, localStorage on web; values above SecureStore's size
 * limit are refused, not truncated. Never a credential: any script on the web
 * origin reads localStorage. A refused web write is dropped, so a resolved
 * `set` is no proof of a stored value.
 */

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export const kv = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // See the header: a dropped preference beats a failed action.
      }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === "web") {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // As `set`: a store the browser blocks holds nothing to remove.
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

/**
 * A device-local on/off choice, on unless turned off: read once at start,
 * changed at once for every screen holding it. The shape `useSyncExternalStore`
 * takes, so a hook is one line.
 */
export function kvSwitch(key: string) {
  let on = true;
  const listeners = new Set<() => void>();
  const tell = () => listeners.forEach((listener) => listener());
  void kv.get(key).then((stored) => {
    if (stored !== "false") return;
    on = false;
    tell();
  });
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (): boolean => on,
    set(next: boolean): void {
      on = next;
      tell();
      void kv.set(key, String(next));
    },
  };
}
