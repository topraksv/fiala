import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlite = vi.hoisted(() => ({
  listeners: new Set<(event: { tableName?: string }) => void>(),
}));

vi.mock("expo-sqlite", () => ({
  addDatabaseChangeListener: (listener: (event: { tableName?: string }) => void) => {
    sqlite.listeners.add(listener);
    return { remove: () => sqlite.listeners.delete(listener) };
  },
}));

const { liveStore, retryDelayMs } = await import("../../src/data/live-query");

function change(tableName?: string) {
  for (const listener of sqlite.listeners) listener({ tableName });
}

/** Let settled promises deliver, without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  sqlite.listeners.clear();
});

describe("liveStore", () => {
  it("has not answered until the query has, and then holds its rows", async () => {
    const store = liveStore(async () => ["Market"], ["settings"]);
    store.subscribe(() => {});
    expect(store.getSnapshot()).toMatchObject({ status: "loading", data: [], updatedAt: undefined });
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", data: ["Market"], error: null });
    expect(store.getSnapshot().updatedAt).toBeInstanceOf(Date);
  });

  it("runs one query for every screen that watches it", async () => {
    const query = vi.fn(async () => []);
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    store.subscribe(() => {});
    await flush();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("tells every subscriber when the answer moves", async () => {
    const store = liveStore(async () => [], ["settings"]);
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);
    await flush();
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("re-runs once for a burst of changes to a table it reads, keeping its rows meanwhile", async () => {
    let answer = ["Market"];
    const query = vi.fn(async () => answer);
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    await flush();
    answer = ["Market", "Pazar"];
    change("settings");
    change("settings");
    await vi.advanceTimersByTimeAsync(59);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()).toMatchObject({ data: ["Market", "Pazar"], status: "ready" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("tells nobody when a re-run answers what it answered before", async () => {
    const store = liveStore(async () => [{ name: "Market" }], ["settings"]);
    let told = 0;
    store.subscribe(() => (told += 1));
    await flush();
    const before = told;
    change("settings");
    await vi.advanceTimersByTimeAsync(60);
    await flush();
    expect(told - before).toBe(0);
  });

  it("keeps saying ready, not loading, while an answered query re-runs", async () => {
    let resolve!: (rows: string[]) => void;
    const store = liveStore(() => new Promise<string[]>((done) => (resolve = done)), ["settings"]);
    store.subscribe(() => {});
    resolve(["Market"]);
    await flush();
    change("settings");
    await vi.advanceTimersByTimeAsync(60);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", data: ["Market"] });
  });

  it("ignores a change to a table it does not read, and re-runs on one that is not named", async () => {
    const query = vi.fn(async () => []);
    liveStore(query, ["settings"]).subscribe(() => {});
    await flush();
    change("outbox");
    await vi.advanceTimersByTimeAsync(100);
    expect(query).toHaveBeenCalledTimes(1);
    change(undefined);
    await vi.advanceTimersByTimeAsync(60);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reports an error when it never answered, and keeps trying until it does", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(["Market"]);
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "error", data: [], error: { attempt: 1 } });
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(store.getSnapshot()).toMatchObject({ status: "ready", data: ["Market"], error: null });
  });

  it("goes stale rather than empty when a re-run fails", async () => {
    const query = vi.fn().mockResolvedValueOnce(["Market"]).mockRejectedValue(new Error("busy"));
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    await flush();
    change("settings");
    await vi.advanceTimersByTimeAsync(60);
    expect(store.getSnapshot()).toMatchObject({ status: "stale", data: ["Market"], error: { attempt: 1 } });
  });

  it("retries at once when asked, instead of waiting out the backoff", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue([]);
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    await flush();
    store.getSnapshot().retry();
    await flush();
    expect(store.getSnapshot().status).toBe("ready");
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("re-runs when asked with nothing pending, for a manual refresh", async () => {
    const query = vi.fn(async () => []);
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    await flush();
    store.getSnapshot().retry();
    await flush();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reads once at a time, and once more for a change that arrived meanwhile", async () => {
    const answers: ((rows: string[]) => void)[] = [];
    const query = vi.fn(() => new Promise<string[]>((done) => answers.push(done)));
    const store = liveStore(query, ["settings"]);
    store.subscribe(() => {});
    change("settings");
    await vi.advanceTimersByTimeAsync(60);
    expect(query).toHaveBeenCalledTimes(1);
    answers[0]!(["Market"]);
    await flush();
    expect(query).toHaveBeenCalledTimes(2);
    answers[1]!(["Market", "Pazar"]);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", data: ["Market", "Pazar"] });
  });

  it("leaves no retry running once stopped, however the failures overlapped", async () => {
    const failures: ((error: Error) => void)[] = [];
    const query = vi.fn(() => new Promise<string[]>((_, fail) => failures.push(fail)));
    const unsubscribe = liveStore(query, ["settings"]).subscribe(() => {});
    change("settings");
    await vi.advanceTimersByTimeAsync(60);
    failures[0]!(new Error("busy"));
    await flush();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("drops a pending retry with its last subscriber", async () => {
    const query = vi.fn().mockRejectedValue(new Error("busy"));
    const unsubscribe = liveStore(query, ["settings"]).subscribe(() => {});
    await flush();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("stops with its last subscriber and starts afresh with the next", async () => {
    const query = vi.fn(async () => ["Market"]);
    const store = liveStore(query, ["settings"]);
    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});
    await flush();
    first();
    expect(sqlite.listeners.size).toBe(1);
    second();
    expect(sqlite.listeners.size).toBe(0);
    // What a screen mounting next reads in its first render, before it subscribes.
    expect(store.getSnapshot()).toMatchObject({ status: "loading", data: [], updatedAt: undefined });
    change("settings");
    await vi.advanceTimersByTimeAsync(100);
    expect(query).toHaveBeenCalledTimes(1);
    store.subscribe(() => {});
    expect(store.getSnapshot()).toMatchObject({ status: "loading", updatedAt: undefined });
  });

  it("drops an answer that arrives after it stopped", async () => {
    let resolve!: (rows: string[]) => void;
    let reject!: (error: Error) => void;
    const query = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string[]>((done) => (resolve = done)))
      .mockImplementationOnce(() => new Promise<string[]>((_, fail) => (reject = fail)));
    const store = liveStore(query, ["settings"]);
    const notify = vi.fn();
    store.subscribe(notify)();
    resolve(["Market"]);
    await flush();
    expect(store.getSnapshot().updatedAt).toBeUndefined();
    store.subscribe(notify)();
    reject(new Error("late"));
    await flush();
    expect(store.getSnapshot().error).toBeNull();
  });
});

describe("retryDelayMs", () => {
  it("doubles from a quarter second and levels off at five", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelayMs)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});
