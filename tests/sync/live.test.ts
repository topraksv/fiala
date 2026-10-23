/**
 * The live households over a stand-in transport (Gital's
 * `tests/sync/live.test.ts`): which channels are joined and left, and which
 * nudges pull.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: { payload?: Record<string, unknown> }) => void;

class FakeChannel {
  handlers = new Map<string, Handler>();
  constructor(
    readonly topic: string,
    readonly options: unknown,
    readonly token: string | null,
  ) {}
  on(type: string, filter: { event: string }, handler: Handler) {
    this.handlers.set(`${type}:${filter.event}`, handler);
    return this;
  }
  subscribe() {
    return this;
  }
  emit(key: string, payload?: Record<string, unknown>) {
    this.handlers.get(key)!({ payload });
  }
}

const clients: FakeClient[] = [];
class FakeClient {
  channels: FakeChannel[] = [];
  removed: FakeChannel[] = [];
  disconnected = false;
  token: string | null = null;
  constructor(
    readonly endpoint: string,
    readonly options: { params: { apikey: string }; accessToken: () => Promise<string | null> },
  ) {
    clients.push(this);
  }
  // The real client sends the token it holds when a channel joins.
  async setAuth() {
    this.token = await this.options.accessToken();
  }
  channel(topic: string, options: unknown) {
    const made = new FakeChannel(topic, options, this.token);
    this.channels.push(made);
    return made;
  }
  removeChannel = vi.fn(async (channel: FakeChannel) => {
    this.removed.push(channel);
    return "ok";
  });
  disconnect = vi.fn(async () => {
    this.disconnected = true;
    return "ok";
  });
}

vi.mock("@supabase/realtime-js", () => ({ RealtimeClient: FakeClient }));

const { followCabinets, startLive, stopLive } = await import("../../src/sync/live");

const ME = "10000000-0000-4000-8000-000000000001";
const HER = "20000000-0000-4000-8000-000000000002";
const accessToken = async () => "jwt";
const onMoved = vi.fn();
const start = () => startLive({ url: "https://x.supabase.co", apiKey: "anon", accessToken, userId: ME, onMoved });
const client = () => clients.at(-1)!;
const channelOf = (cabinetId: string) => client().channels.find((c) => c.topic === `cabinet:${cabinetId}`)!;

beforeEach(() => {
  clients.length = 0;
  onMoved.mockReset();
});
afterEach(() => stopLive());

describe("live households", () => {
  it("joins each shared household's private channel with the project's key and their token", async () => {
    followCabinets(["a", "b"]);
    await start();
    expect(client().endpoint).toBe("https://x.supabase.co/realtime/v1");
    expect(client().options.params.apikey).toBe("anon");
    expect(await client().options.accessToken()).toBe("jwt");
    expect(client().channels.map((c) => c.topic)).toEqual([`user:${ME}`, "cabinet:a", "cabinet:b"]);
    expect(channelOf("a").options).toEqual({ config: { private: true } });
    expect(client().channels.map((c) => c.token)).toEqual(["jwt", "jwt", "jwt"]);
  });

  it("follows the households as they change: a new one joined, one left dropped, one kept not joined twice", async () => {
    await start();
    followCabinets(["a", "b"]);
    followCabinets(["b", "c"]);
    expect(client().channels.map((c) => c.topic)).toEqual([`user:${ME}`, "cabinet:a", "cabinet:b", "cabinet:c"]);
    expect(client().removed.map((c) => c.topic)).toEqual(["cabinet:a"]);
    followCabinets(["a"]);
    expect(client().channels.map((c) => c.topic), "one left is joined afresh when it comes back").toEqual([`user:${ME}`, "cabinet:a", "cabinet:b", "cabinet:c", "cabinet:a"]);
  });

  it("pulls when someone else moved a household, and not for the person's own push", async () => {
    followCabinets(["a"]);
    await start();
    channelOf("a").emit("broadcast:moved", { by: HER });
    channelOf("a").emit("broadcast:moved", { by: ME });
    channelOf("a").emit("broadcast:moved");
    expect(onMoved).toHaveBeenCalledTimes(2);
  });

  it("pulls when the person's place in a household changed, told on their own channel, by whichever of their devices", async () => {
    await start();
    const own = client().channels.find((c) => c.topic === `user:${ME}`)!;
    expect(own.options).toEqual({ config: { private: true } });
    own.emit("broadcast:moved", { by: HER, cabinet: "a" });
    own.emit("broadcast:moved", { by: ME, cabinet: "a" });
    expect(onMoved).toHaveBeenCalledTimes(2);
  });

  it("ends everything on sign-out, and a start overtaken by it opens nothing", async () => {
    followCabinets(["a"]);
    await start();
    const first = client();
    const late = start();
    stopLive();
    await late;
    await Promise.resolve();
    expect(first.disconnected).toBe(true);
    expect(clients).toHaveLength(1);
    followCabinets(["b"]);
    expect(first.channels).toHaveLength(2);
  });

  it("closes a client whose start was overtaken while its token was asked for", async () => {
    followCabinets(["a"]);
    let answer!: (token: string) => void;
    const late = startLive({ url: "https://x.supabase.co", apiKey: "anon", accessToken: () => new Promise((resolve) => (answer = resolve)), userId: ME, onMoved });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    stopLive();
    answer("jwt");
    await late;
    expect(client().disconnected).toBe(true);
    expect(client().channels).toHaveLength(0);
  });

  it("starts again cleanly, following what it was told before", async () => {
    await start();
    followCabinets(["a"]);
    await start();
    expect(clients[0]!.disconnected).toBe(true);
    expect(client().channels.map((c) => c.topic)).toEqual([`user:${ME}`, "cabinet:a"]);
  });

  it("lets a refusal on the way pass quietly: the half-minute pull still comes", async () => {
    followCabinets(["a", "b"]);
    await start();
    const live = client();
    live.removeChannel.mockRejectedValueOnce(new Error("offline"));
    live.disconnect.mockRejectedValueOnce(new Error("offline"));
    followCabinets(["b"]);
    stopLive();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(live.removeChannel).toHaveBeenCalledTimes(1);
    expect(live.disconnect).toHaveBeenCalledTimes(1);
  });
});
