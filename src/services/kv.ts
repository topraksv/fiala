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

/** What a remembered list keeps of each item: enough to draw its row without asking. */
export interface Remembered {
  id: string;
  title: string;
  subtitle?: string;
}

/** SecureStore refuses a value past this, in UTF-8 bytes. */
const SECURE_STORE_BYTES = 2048;

const isRemembered = (item: unknown): item is Remembered =>
  typeof (item as Remembered | null)?.id === "string" && typeof (item as Remembered).title === "string";

/**
 * A device-local list, newest first and at most `cap` long, read and changed
 * as a switch is, and never past what SecureStore stores. What is added
 * before the stored list is read stays in front of it.
 */
export function kvList(key: string, cap: number) {
  let items: readonly Remembered[] = [];
  const listeners = new Set<() => void>();
  const show = (next: readonly Remembered[]) => {
    items = next;
    listeners.forEach((listener) => listener());
  };
  const save = (next: readonly Remembered[]) => {
    // Long Turkish names reach the store's limit before the cap does; the oldest go first. An empty list, "[]", always fits.
    let kept = next;
    while (new TextEncoder().encode(JSON.stringify(kept)).length > SECURE_STORE_BYTES) kept = kept.slice(0, -1);
    show(kept);
    void kv.set(key, JSON.stringify(kept)).catch(() => {});
  };
  void kv.get(key).then((stored) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(stored));
    } catch {
      // A list that cannot be read starts again empty.
    }
    const read = Array.isArray(parsed) ? parsed.filter(isRemembered) : [];
    if (read.length > 0) show([...items, ...read.filter((item) => !items.some((each) => each.id === item.id))].slice(0, cap));
  });
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (): readonly Remembered[] => items,
    add: (item: Remembered) => save([item, ...items.filter((each) => each.id !== item.id)].slice(0, cap)),
    remove: (id: string) => save(items.filter((each) => each.id !== id)),
    /** Emptied here and in the store: the device passes to another account. */
    forget(): Promise<void> {
      show([]);
      return kv.remove(key);
    },
  };
}
