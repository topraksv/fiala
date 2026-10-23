/**
 * Resetting the data over the real write layer: a part takes what it names
 * and nothing else, and the account's settings always stay.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);

const { HEALTH_CONSENT, chooseProfile, giveHealthConsent, hasHealthConsent, isFrozen, profileChoice, readSettings, setAccountFrozen, writeSetting } = await import("../../src/data/settings");
const { RESET_SCOPES, countDataReset, resetData } = await import("../../src/data/reset");
const { addPackage, takeFrom } = await import("../../src/data/cabinet");
const { migratedDatabase } = await import("../helpers");

beforeEach(() => {
  harness.db = migratedDatabase();
});

describe("resetting the data", () => {
  it("takes the whole cabinet, and never the settings", async () => {
    expect(RESET_SCOPES).toEqual(["cabinet"]);
    const box = await addPackage("me", { name: "Parol", gtin: "8699546090112" }, { unit: "tablet" }, 20_000);
    await takeFrom(box, 1000);
    harness.db!.exec("INSERT INTO people (id, created_at, updated_at, cabinet_id, name) VALUES ('p', 'x', 'x', 'me', 'Ece')");
    harness.db!.exec("INSERT INTO locations (id, created_at, updated_at, cabinet_id, name) VALUES ('l', 'x', 'x', 'me', 'Mutfak')");
    harness.db!.exec("INSERT INTO tags (id, created_at, updated_at, cabinet_id, name) VALUES ('t', 'x', 'x', 'me', 'Ağrı kesici')");
    harness.db!.exec(`INSERT INTO package_changes (id, created_at, updated_at, cabinet_id, package_id, changes) VALUES ('c', 'x', 'x', 'me', '${box}', '{}')`);
    harness.db!.exec("INSERT INTO product_tags (id, created_at, updated_at, cabinet_id, product_id, tag_id) VALUES ('pt', 'x', 'x', 'me', 'p', 't')");
    await setAccountFrozen(true);
    await giveHealthConsent();
    expect(hasHealthConsent(await readSettings())).toBe(true);
    expect(await countDataReset(["cabinet"], "me")).toBe(10);
    expect(await resetData(["cabinet"], "me")).toBe(10);
    expect(hasHealthConsent(await readSettings()), "clearing the cabinet withdraws the consent to it").toBe(false);
    for (const table of ["package_moves", "package_changes", "packages", "products", "people", "locations", "tags", "product_tags"]) {
      expect(harness.db!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get(), table).toEqual({ n: 0 });
    }
    expect(isFrozen(await readSettings())).toBe(true);
  });

  it("leaves a household someone else owns as it is, and empties one the person owns", async () => {
    harness.db!.exec(`INSERT INTO cabinet_members (id, created_at, updated_at, cabinet_id, user_id, role) VALUES
      ('m1', 'x', 'x', 'theirs', 'me', 'editor'), ('m2', 'x', 'x', 'mine', 'me', 'owner'), ('m3', 'x', 'x', 'other', 'someone', 'editor')`);
    for (const cabinet of ["me", "theirs", "mine", "other"]) {
      harness.db!.exec(`INSERT INTO locations (id, created_at, updated_at, cabinet_id, name) VALUES ('l-${cabinet}', 'x', 'x', '${cabinet}', 'Mutfak')`);
    }
    expect(await resetData(["cabinet"], "me")).toBe(3);
    expect(harness.db!.prepare("SELECT cabinet_id FROM locations WHERE deleted_at IS NULL").all(), "a member's reset is no household's").toEqual([{ cabinet_id: "theirs" }]);
  });

  it("holds the consent only at its version, and never from a value it cannot read", async () => {
    expect(hasHealthConsent([])).toBe(false);
    expect(hasHealthConsent([{ key: HEALTH_CONSENT, value: '{"version":1,"at":"x"}' }])).toBe(true);
    for (const value of ['{"version":2}', "{", "null", "1"]) expect(hasHealthConsent([{ key: HEALTH_CONSENT, value }]), value).toBe(false);
    expect(hasHealthConsent([{ key: "other", value: '{"version":1}' }])).toBe(false);
    expect(hasHealthConsent([{ key: "account_frozen", value: "true" }, { key: HEALTH_CONSENT, value: '{"version":1}' }]), "found among the others").toBe(true);
    // The stored key: renamed, every consent already given is forgotten.
    expect(HEALTH_CONSENT).toBe("health_consent");
    expect([isFrozen([{ key: HEALTH_CONSENT, value: "true" }]), isFrozen([{ key: "account_frozen", value: "false" }])], "no other setting freezes").toEqual([false, false]);
  });

  it("keeps who the account is and a new box's owner and place apart, each only while it exists", async () => {
    const named = [{ id: "me" }, { id: "child" }, { id: "shelf" }];
    expect(profileChoice(await readSettings(), "me", named), "none chosen").toBeNull();
    await chooseProfile("me", "me");
    await chooseProfile("owner", "child");
    await chooseProfile("place", "shelf");
    const all = await readSettings();
    expect([profileChoice(all, "me", named), profileChoice(all, "owner", named), profileChoice(all, "place", named)]).toEqual(["me", "child", "shelf"]);
    expect(profileChoice(all, "owner", [{ id: "me" }]), "deleted since").toBeNull();
    await chooseProfile("owner", null);
    expect(profileChoice(await readSettings(), "owner", named), "chosen back to no one").toBeNull();
    // The stored keys: renamed, every account's choice is forgotten.
    expect((await readSettings()).map(({ key }) => key).sort()).toEqual(["default_location", "default_person", "profile_person"]);
    expect(profileChoice([{ key: "profile_person", value: "{" }], "me", named), "unreadable").toBeNull();
  });

  it("counts and takes nothing when nothing is chosen, and never the settings", async () => {
    await setAccountFrozen(true);
    expect(await countDataReset([], "me")).toBe(0);
    expect(await resetData([], "me")).toBe(0);
    expect(isFrozen(await readSettings())).toBe(true);
    expect(await countDataReset(["unknown"], "me")).toBe(0);
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
      expect(await countDataReset(["prefs"], "me", parts)).toBe(2);
      expect(await countDataReset(["prefs", "all"], "me", parts)).toBe(3);
    });

    it("sends what it took as tombstones, for the account's other devices, and leaves the rest", async () => {
      harness.db!.exec("DELETE FROM outbox");
      expect(await resetData(["prefs"], "me", parts)).toBe(2);
      expect((await readSettings()).map((setting) => setting.key)).toEqual(["kept"]);
      const queued = harness.db!.prepare("SELECT payload FROM outbox").all() as { payload: string }[];
      expect(queued).toHaveLength(2);
      expect(queued.every(({ payload }) => (JSON.parse(payload) as { deleted_at: unknown }).deleted_at != null)).toBe(true);
      expect(await countDataReset(["prefs"], "me", parts), "nothing left to take").toBe(0);
    });
  });
});
