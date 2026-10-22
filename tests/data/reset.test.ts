/**
 * Resetting the data over the real write layer. The shell stores nothing but
 * settings, and a reset never takes those, so there are no parts to choose
 * yet: what must hold is that nothing is counted or taken, and the account's
 * settings stay.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);

const { isFrozen, readSettings, setAccountFrozen, writeSetting } = await import("../../src/data/settings");
const { RESET_SCOPES, countDataReset, resetData } = await import("../../src/data/reset");
const { migratedDatabase } = await import("../helpers");

beforeEach(() => {
  harness.db = migratedDatabase();
});

describe("resetting the data", () => {
  it("offers no part while the shell stores nothing of the person's", () => {
    expect(RESET_SCOPES).toEqual([]);
  });

  it("counts and takes nothing, and never the settings", async () => {
    await setAccountFrozen(true);
    expect(await countDataReset([])).toBe(0);
    expect(await resetData([])).toBe(0);
    expect(isFrozen(await readSettings())).toBe(true);
    expect(await countDataReset(["unknown"])).toBe(0);
  });

  // The registry is a parameter: a feature's parts are proven here before there is one.
  describe("over parts a feature registers", () => {
    const parts = { prefs: [["settings", "key LIKE 'pref.%'"]], all: [["settings", "1"], ["settings", "key LIKE 'pref.%'"]] } as const;

    beforeEach(async () => {
      await writeSetting("pref.a", 1);
      await writeSetting("pref.b", 2);
      await writeSetting("kept", 3);
    });

    it("counts a row two parts both take once, before anything goes", async () => {
      expect(await countDataReset(["prefs"], parts)).toBe(2);
      expect(await countDataReset(["prefs", "all"], parts)).toBe(3);
    });

    it("sends what it took as tombstones, for the account's other devices, and leaves the rest", async () => {
      harness.db!.exec("DELETE FROM outbox");
      expect(await resetData(["prefs"], parts)).toBe(2);
      expect((await readSettings()).map((setting) => setting.key)).toEqual(["kept"]);
      const queued = harness.db!.prepare("SELECT payload FROM outbox").all() as { payload: string }[];
      expect(queued).toHaveLength(2);
      expect(queued.every(({ payload }) => (JSON.parse(payload) as { deleted_at: unknown }).deleted_at != null)).toBe(true);
      expect(await countDataReset(["prefs"], parts), "nothing left to take").toBe(0);
    });
  });
});
