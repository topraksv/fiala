/**
 * The device-local store: the keychain on a phone, the browser's store on the
 * web, best effort there by contract — a resolved write is no proof of a
 * stored value — and the on/off switch screens read through it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const secure = {
  getItemAsync: vi.fn(async (_key: string): Promise<string | null> => null),
  setItemAsync: vi.fn(async (_key: string, _value: string): Promise<void> => {}),
  deleteItemAsync: vi.fn(async (_key: string): Promise<void> => {}),
};

/** `Platform.OS` is read at call time, but the mock must be in place before the import. */
async function load(os: "web" | "ios") {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: os } }));
  vi.doMock("expo-secure-store", () => secure);
  return import("../../src/services/kv");
}

/** A blocked browser throws on reading `localStorage` itself, which `?.` does not guard. */
function installLocalStorage(mode: "working" | "blocked" | "absent"): Map<string, string> {
  const backing = new Map<string, string>();
  if (mode === "absent") {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
  } else if (mode === "blocked") {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
  } else {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => void backing.set(key, value),
        removeItem: (key: string) => void backing.delete(key),
      },
    });
  }
  return backing;
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  secure.getItemAsync.mockReset().mockResolvedValue(null);
  secure.setItemAsync.mockClear();
  secure.deleteItemAsync.mockClear();
});

describe("on the web", () => {
  it("round-trips through the browser store and never reaches for the keychain", async () => {
    const backing = installLocalStorage("working");
    const { kv } = await load("web");

    await kv.set("fiala.theme", "dark");
    expect(backing.get("fiala.theme")).toBe("dark");
    expect(await kv.get("fiala.theme")).toBe("dark");
    await kv.remove("fiala.theme");
    expect(backing.has("fiala.theme")).toBe(false);
    expect(await kv.get("fiala.theme")).toBeNull();
    expect(secure.getItemAsync).not.toHaveBeenCalled();
    expect(secure.setItemAsync).not.toHaveBeenCalled();
    expect(secure.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("treats a store the runtime does not provide as empty", async () => {
    installLocalStorage("absent");
    const { kv } = await load("web");

    expect(await kv.get("fiala.theme")).toBeNull();
    await expect(kv.set("fiala.theme", "dark")).resolves.toBeUndefined();
    await expect(kv.remove("fiala.theme")).resolves.toBeUndefined();
  });

  it("reads as absent and drops writes when site data is blocked", async () => {
    installLocalStorage("blocked");
    const { kv } = await load("web");

    await expect(kv.get("fiala.theme")).resolves.toBeNull();
    await expect(kv.set("fiala.theme", "dark")).resolves.toBeUndefined();
    await expect(kv.remove("fiala.theme")).resolves.toBeUndefined();
    expect(secure.getItemAsync).not.toHaveBeenCalled();
    expect(secure.setItemAsync).not.toHaveBeenCalled();
    expect(secure.deleteItemAsync).not.toHaveBeenCalled();
  });
});

describe("on a phone", () => {
  it("uses the keychain and leaves the browser store alone", async () => {
    const backing = installLocalStorage("working");
    const { kv } = await load("ios");

    await kv.set("fiala.theme", "dark");
    expect(secure.setItemAsync).toHaveBeenCalledWith("fiala.theme", "dark");
    secure.getItemAsync.mockResolvedValue("dark");
    expect(await kv.get("fiala.theme")).toBe("dark");
    expect(secure.getItemAsync).toHaveBeenCalledWith("fiala.theme");
    await kv.remove("fiala.theme");
    expect(secure.deleteItemAsync).toHaveBeenCalledWith("fiala.theme");
    expect(backing.size).toBe(0);
  });

  it("lets a refused keychain write fail the caller", async () => {
    const { kv } = await load("ios");
    secure.setItemAsync.mockRejectedValueOnce(new Error("refused"));
    await expect(kv.set("fiala.theme", "dark")).rejects.toThrow("refused");
  });
});

describe("a switch", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("is on until a stored false turns it off, and tells its listeners", async () => {
    secure.getItemAsync.mockResolvedValue("false");
    const { kvSwitch } = await load("ios");
    const toggle = kvSwitch("fiala.sounds");
    const heard = vi.fn();
    toggle.subscribe(heard);

    expect(toggle.get()).toBe(true);
    await settle();
    expect(secure.getItemAsync).toHaveBeenCalledWith("fiala.sounds");
    expect(toggle.get()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays on for anything stored but false, without a word to its listeners", async () => {
    secure.getItemAsync.mockResolvedValue("true");
    const { kvSwitch } = await load("ios");
    const toggle = kvSwitch("fiala.sounds");
    const heard = vi.fn();
    toggle.subscribe(heard);

    await settle();
    expect(toggle.get()).toBe(true);
    expect(heard).not.toHaveBeenCalled();
  });

  it("changes at once, stores the choice, and stops telling a listener that left", async () => {
    const { kvSwitch } = await load("ios");
    const toggle = kvSwitch("fiala.sounds");
    const stays = vi.fn();
    const leaves = vi.fn();
    toggle.subscribe(stays);
    const unsubscribe = toggle.subscribe(leaves);
    unsubscribe();

    toggle.set(false);
    expect(toggle.get()).toBe(false);
    expect(stays).toHaveBeenCalledTimes(1);
    expect(leaves).not.toHaveBeenCalled();
    expect(secure.setItemAsync).toHaveBeenCalledWith("fiala.sounds", "false");
    toggle.set(true);
    expect(toggle.get()).toBe(true);
    expect(secure.setItemAsync).toHaveBeenLastCalledWith("fiala.sounds", "true");
  });
});

describe("a remembered list", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const item = (id: string) => ({ id, title: id.toUpperCase() });

  it("reads what was stored, drops what is not an item, and tells its listeners", async () => {
    secure.getItemAsync.mockResolvedValue(JSON.stringify([item("a"), { id: 1, title: "x" }, { id: "b" }, null, item("c")]));
    const { kvList } = await load("ios");
    const list = kvList("fiala.guide.recentMedicines", 10);
    const heard = vi.fn();
    list.subscribe(heard);
    expect(list.get()).toEqual([]);
    await settle();
    expect(secure.getItemAsync).toHaveBeenCalledWith("fiala.guide.recentMedicines");
    expect(list.get()).toEqual([item("a"), item("c")]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("starts empty, without a word, from nothing stored, an empty list, or one that cannot be read", async () => {
    for (const stored of [null, "[]", "{", '{"id":"a","title":"A"}']) {
      secure.getItemAsync.mockResolvedValue(stored);
      const { kvList } = await load("ios");
      const list = kvList("fiala.guide.recentMedicines", 10);
      const heard = vi.fn();
      list.subscribe(heard);
      await settle();
      expect(list.get()).toEqual([]);
      expect(heard).not.toHaveBeenCalled();
    }
  });

  it("puts what is added first and once, keeps at most its cap, stores each change, and stops telling a listener that left", async () => {
    const { kvList } = await load("ios");
    const list = kvList("fiala.guide.starredPharmacies", 2);
    const stays = vi.fn();
    const unsubscribe = list.subscribe(vi.fn());
    list.subscribe(stays);
    const left = vi.fn();
    list.subscribe(left)();
    unsubscribe();
    list.add(item("a"));
    list.add(item("b"));
    list.add(item("a"));
    expect(list.get()).toEqual([item("a"), item("b")]);
    list.add(item("c"));
    expect(list.get()).toEqual([item("c"), item("a")]);
    list.remove("c");
    expect(list.get()).toEqual([item("a")]);
    expect(stays).toHaveBeenCalledTimes(5);
    expect(left).not.toHaveBeenCalled();
    expect(secure.setItemAsync).toHaveBeenLastCalledWith("fiala.guide.starredPharmacies", JSON.stringify([item("a")]));
    secure.setItemAsync.mockRejectedValueOnce(new Error("too large"));
    list.add(item("d"));
    await settle();
    expect(list.get(), "a refused write is the store's, not the screen's").toEqual([item("d"), item("a")]);
  });

  it("moves an item added again to the front instead of keeping it twice", async () => {
    const { kvList } = await load("ios");
    const list = kvList("fiala.guide.recentPharmacies", 10);
    for (const id of "aba") list.add(item(id));
    expect(list.get()).toEqual([item("a"), item("b")]);
  });

  it("keeps what was added before the stored list arrived in front of it, once, within its cap", async () => {
    let arrive: (value: string) => void = () => {};
    secure.getItemAsync.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const { kvList } = await load("ios");
    const list = kvList("fiala.guide.recentMedicines", 3);
    list.add(item("b"));
    arrive(JSON.stringify([item("a"), item("b"), item("c"), item("d")]));
    await settle();
    expect(list.get()).toEqual([item("b"), item("a"), item("c")]);
  });

  it("drops the oldest while the stored list would pass SecureStore's 2,048 bytes", async () => {
    const { kvList } = await load("ios");
    const list = kvList("fiala.guide.starredMedicines", 15);
    // Two bytes a letter: 150 of them and the rest are about 345 bytes an item, so five fit.
    const long = (id: string) => ({ id: id.repeat(40), title: "Ğ".repeat(100), subtitle: "ş".repeat(50) });
    for (const id of "abcdefg") list.add(long(id));
    expect(list.get().map((each) => each.id[0])).toEqual(["g", "f", "e", "d", "c"]);
    const stored = secure.setItemAsync.mock.lastCall![1] as string;
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(JSON.stringify([...list.get(), long("b")])).length, "one more would not fit").toBeGreaterThan(2048);
    const exact = { id: "x", title: "a".repeat(2025) };
    expect(JSON.stringify([exact]).length).toBe(2048);
    await list.forget();
    list.add(exact);
    expect(list.get(), "exactly the limit fits").toEqual([exact]);
  });

  it("forgets here and in the store", async () => {
    secure.getItemAsync.mockResolvedValue(JSON.stringify([item("a")]));
    const { kvList } = await load("ios");
    const list = kvList("fiala.guide.recentMedicines", 10);
    await settle();
    const heard = vi.fn();
    list.subscribe(heard);
    await list.forget();
    expect(list.get()).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(secure.deleteItemAsync).toHaveBeenCalledWith("fiala.guide.recentMedicines");
  });
});
