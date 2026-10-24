import { beforeEach, describe, expect, it, vi } from "vitest";

const cloud = {
  configured: true,
  rows: [] as unknown[] | null,
  error: null as null | { message: string },
  thrown: false,
  asked: [] as unknown[],
};
const stored = new Map<string, string>();

vi.mock("../../src/services/kv", async () => {
  const kv = { get: async (key: string) => stored.get(key) ?? null, set: async (key: string, value: string) => void stored.set(key, value), remove: async (key: string) => void stored.delete(key) };
  // `kvList` is kv.ts's own, tested there; here only what forgetting reaches.
  const forgotten: string[] = [];
  return { kv, kvList: (key: string) => ({ forget: async () => void (forgotten.push(key), stored.delete(key)) }), forgotten };
});

vi.mock("../../src/sync/supabase", () => ({
  getSupabase: () =>
    cloud.configured
      ? {
          rpc: async (name: string, args: unknown) => {
            cloud.asked.push([name, args]);
            if (cloud.thrown) throw new Error("offline");
            return { data: cloud.rows, error: cloud.error };
          },
        }
      : null,
}));

const { boxAround, boxOfRegion, catalogueByGtin, hoursInTurkish, catalogueEntry, catalogueRelated, distanceKm, forgetGuide, forgetPlace, pharmaciesById, pharmaciesIn, pharmaciesOf, pharmaciesShown, pharmacyPlaces, readLocationOn, readPlace, saveLocationOn, savePlace, searchCatalogue } = await import("../../src/services/guide");

const row = (id: string, gtin: string | null, suspended = false) => ({ id, gtin, name: `N${id}`, active_substance: "s", atc: "A", holder: "h", suspended, listed_on: "2026-10-23" });

beforeEach(() => {
  Object.assign(cloud, { configured: true, rows: [], error: null, thrown: false, asked: [] });
  stored.clear();
});

describe("asking the catalogue", () => {
  it("posts what was typed and reads each row as an entry", async () => {
    cloud.rows = [row("a", "08699508010752", true)];
    expect(await searchCatalogue("onadron")).toEqual([
      { id: "a", gtin: "08699508010752", name: "Na", activeSubstance: "s", atc: "A", holder: "h", suspended: true, listedOn: "2026-10-23" },
    ]);
    expect(cloud.asked).toEqual([["search_catalogue", { query: "onadron", max_rows: 20 }]]);
  });

  it("asks nothing for fewer than two letters", async () => {
    expect(await searchCatalogue(" p ")).toEqual([]);
    expect(cloud.asked).toEqual([]);
    await searchCatalogue(" pa ");
    expect(cloud.asked, "two are enough").toHaveLength(1);
  });

  it("says it could not ask: no cloud, a refusal, no list, or no connection", async () => {
    cloud.configured = false;
    expect(await searchCatalogue("parol")).toBeNull();
    cloud.configured = true;
    cloud.error = { message: "no" };
    expect(await searchCatalogue("parol")).toBeNull();
    cloud.error = null;
    cloud.rows = null;
    expect(await searchCatalogue("parol")).toBeNull();
    cloud.thrown = true;
    expect(await searchCatalogue("parol")).toBeNull();
  });

  it("finds a GTIN by its printed barcode and keeps only the whole code's products", async () => {
    cloud.rows = [row("a", "08680150350112"), row("b", "18680150350112"), row("c", null)];
    expect((await catalogueByGtin("08680150350112"))?.map((entry) => entry.id)).toEqual(["a"]);
    expect(cloud.asked).toEqual([["search_catalogue", { query: "8680150350112", max_rows: 20 }]]);
    await catalogueByGtin("18680150350112");
    expect(cloud.asked[1], "only a leading zero is dropped").toEqual(["search_catalogue", { query: "18680150350112", max_rows: 20 }]);
    cloud.thrown = true;
    expect(await catalogueByGtin("08680150350112")).toBeNull();
  });
});

describe("an entry and its relatives", () => {
  it("opens one by id, says when the list no longer has it, and when it could not ask", async () => {
    cloud.rows = [row("a", null)];
    expect((await catalogueEntry("a"))?.name).toBe("Na");
    cloud.rows = [];
    expect(await catalogueEntry("a"), "gone from the list").toBeUndefined();
    cloud.thrown = true;
    expect(await catalogueEntry("a")).toBeNull();
    expect(cloud.asked.slice(0, 1)).toEqual([["catalogue_entry", { entry_id: "a" }]]);
  });

  it("asks for its relatives", async () => {
    cloud.rows = [row("b", null), row("c", null)];
    expect((await catalogueRelated("a"))?.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(cloud.asked).toEqual([["catalogue_related", { entry_id: "a" }]]);
    cloud.error = { message: "no" };
    expect(await catalogueRelated("a")).toBeNull();
  });
});

const pharmacy = (id: string, name: string | null, lat: number, lon: number, more: Record<string, unknown> = {}) => ({
  id, name, province: "İstanbul", district: "Kadıköy", neighbourhood: null, address: null, phone: null, opening_hours: null, lat, lon, seen_on: "2026-10-24", ...more,
});

describe("asking for pharmacies", () => {
  it("by place, by box and by id, each read as the screen's, and none without the server", async () => {
    cloud.rows = [pharmacy("node/1", "Zeren", 41, 29, { opening_hours: "Mo-Fr 09:00-19:00" })];
    const read = { id: "node/1", name: "Zeren", province: "İstanbul", district: "Kadıköy", neighbourhood: null, address: null, phone: null, openingHours: "Mo-Fr 09:00-19:00", lat: 41, lon: 29, seenOn: "2026-10-24" };
    expect(await pharmaciesOf("İstanbul", "Kadıköy")).toEqual([read]);
    expect(await pharmaciesIn({ south: 40, west: 28, north: 41, east: 29 })).toEqual([read]);
    expect(await pharmaciesById(["node/1"])).toEqual([read]);
    cloud.rows = [{ province: "İzmir", district: "Çeşme", pharmacies: 3 }];
    expect(await pharmacyPlaces()).toEqual([{ province: "İzmir", district: "Çeşme", pharmacies: 3 }]);
    expect(cloud.asked).toEqual([
      ["pharmacies_of", { province: "İstanbul", district: "Kadıköy" }],
      ["pharmacies_in", { south: 40, west: 28, north: 41, east: 29 }],
      ["pharmacies_by_id", { ids: ["node/1"] }],
      ["pharmacy_places", {}],
    ]);
    cloud.configured = false;
    expect([await pharmaciesOf("İzmir", null), await pharmaciesIn({ south: 0, west: 0, north: 0, east: 0 }), await pharmaciesById([]), await pharmacyPlaces()]).toEqual([null, null, null, null]);
  });

  it("sends a box on a kilometre's grid that holds the person and the distance asked, never their position", () => {
    const at = { lat: 40.98765, lon: 29.02345 };
    const box = boxAround(at, 5);
    for (const edge of Object.values(box)) expect(Math.round(edge * 100) / 100).toBeCloseTo(edge, 10);
    expect(box.south).toBeLessThanOrEqual(at.lat - 5 / 111.32);
    expect(box.north).toBeGreaterThanOrEqual(at.lat + 5 / 111.32);
    expect(box.east - box.west, "wider in degrees than tall, at this latitude").toBeGreaterThan(box.north - box.south);
    expect(box).toEqual({ south: 40.94, west: 28.96, north: 41.04, east: 29.09 });
    expect(boxAround({ lat: 36, lon: 30 }, 5), "a degree of longitude shrinks southward too").toEqual({ south: 35.95, west: 29.94, north: 36.05, east: 30.06 });
    const far = boxAround(at, 500);
    expect([far.north - far.south, far.east - far.west].every((side) => side <= 1), "never past what the server takes").toBe(true);
    expect(boxOfRegion({ lat: 41, lon: 29 }, 3, 0.4)).toEqual({ south: 40.505, west: 28.8, north: 41.495, east: 29.2 });
    const wide = boxOfRegion({ lat: 39, lon: 31.5001 }, 2, 2);
    expect(wide.east - wide.west, "near 32° east, where a whole degree subtracts to more than 1").toBeLessThanOrEqual(1);
  });

  it("measures the distance, and shows those matching every word, nearest first or by name", () => {
    expect(distanceKm({ lat: 41, lon: 29 }, { lat: 41, lon: 29 })).toBe(0);
    expect(distanceKm({ lat: 41.0082, lon: 28.9784 }, { lat: 39.9334, lon: 32.8597 })).toBeCloseTo(350, -1);
    const list = [pharmacy("a", "Zeren Eczanesi", 41.1, 29), pharmacy("b", "Çınar Eczanesi", 41.01, 29, { neighbourhood: "Moda" }), pharmacy("c", null, 41.05, 29, { address: "Moda Caddesi 1" })].map(
      ({ opening_hours, seen_on, ...each }) => ({ ...each, openingHours: opening_hours, seenOn: seen_on }),
    );
    expect(pharmaciesShown(list, "", { lat: 41, lon: 29 }).map((each) => each.id)).toEqual(["b", "c", "a"]);
    expect(pharmaciesShown(list, "", null).map((each) => each.id), "by name, Turkish order, a nameless one first").toEqual(["c", "b", "a"]);
    expect(pharmaciesShown(list, "MODA", null).map((each) => each.id)).toEqual(["c", "b"]);
    expect(pharmaciesShown(list, "moda çınar", null).map((each) => each.id)).toEqual(["b"]);
    expect(pharmaciesShown(list, "moda  çınar ", null).map((each) => each.id), "spaces around the words").toEqual(["b"]);
    expect(pharmaciesShown(list, "eczanesimoda", null), "a word does not run across two fields").toEqual([]);
    expect(pharmaciesShown(list, "kadıköy zeren", null).map((each) => each.id), "the district too").toEqual(["a"]);
    const same = [list[0]!, { ...list[0]!, id: "d", name: "Ada" }];
    expect(pharmaciesShown(same, "", { lat: 41, lon: 29 }).map((each) => each.id), "as far, by name").toEqual(["d", "a"]);
  });
});

describe("a pharmacy's hours", () => {
  it("reads OpenStreetMap's usual forms into Turkish and shows any other as written", () => {
    expect(hoursInTurkish("Mo-Sa 09:00-19:00; Su off")).toBe("Pzt–Cmt 09:00–19:00 · Paz kapalı");
    expect(hoursInTurkish("Mo-Fr 08:30-12:30,13:30-19:00; Sa 09:00-14:00; Su,PH closed")).toBe("Pzt–Cum 08:30–12:30, 13:30–19:00 · Cmt 09:00–14:00 · Paz, Resmî tatil kapalı");
    expect(hoursInTurkish(" 24/7 ")).toBe("Her gün 24 saat");
    expect(hoursInTurkish("Mo-Su 00:00-24:00")).toBe("Pzt–Paz 24 saat");
    expect(hoursInTurkish("09:00-21:00"), "no days is every day").toBe("Her gün 09:00–21:00");
    expect(hoursInTurkish("Mo-Fr 09:00-19:00, Sa 09:00-14:00"), "a half-read rule would state wrong hours").toBe("Mo-Fr 09:00-19:00, Sa 09:00-14:00");
    expect(hoursInTurkish("mo-fr 9:00-17:00; ph OFF"), "as people write it").toBe("Pzt–Cum 09:00–17:00 · Resmî tatil kapalı");
    expect(hoursInTurkish("Mo-Sa 09:00 - 19:00")).toBe("Pzt–Cmt 09:00–19:00");
    expect(hoursInTurkish("Mo-Sa 08:30-18:00+"), "an open end is not read").toBe("Mo-Sa 08:30-18:00+");
    expect(hoursInTurkish("sunrise-sunset")).toBe("sunrise-sunset");
    expect(hoursInTurkish("Mo 09:00-19:00 x")).toBe("Mo 09:00-19:00 x");
    expect(hoursInTurkish("Mo-Fr 09:00-19:00; Sa by appointment"), "one unread rule keeps them all as written").toBe("Mo-Fr 09:00-19:00; Sa by appointment");
    expect(hoursInTurkish("x Mo 09:00-19:00")).toBe("x Mo 09:00-19:00");
  });
});

describe("using the location", () => {
  it("is on until it is turned off, and on again when turned back", async () => {
    expect(await readLocationOn()).toBe(true);
    await saveLocationOn(false);
    expect(await readLocationOn()).toBe(false);
    expect(stored.get("fiala.guide.location"), "kept under its own key across versions").toBe("off");
    await saveLocationOn(true);
    expect(await readLocationOn()).toBe(true);
    expect(stored.has("fiala.guide.location"), "on is the absence of the key").toBe(false);
    await saveLocationOn(false);
    const { kv } = await import("../../src/services/kv");
    vi.spyOn(kv, "get").mockRejectedValueOnce(new Error("locked"));
    expect(await readLocationOn(), "a store that cannot be read").toBe(true);
  });
});

describe("the place chosen by hand", () => {
  it("is kept, read back, and nothing for what cannot be read", async () => {
    expect(await readPlace()).toBeNull();
    await savePlace({ province: "İzmir", district: "Çeşme" });
    expect(await readPlace()).toEqual({ province: "İzmir", district: "Çeşme" });
    await savePlace({ province: "İzmir", district: null });
    expect(await readPlace()).toEqual({ province: "İzmir", district: null });
    stored.set("fiala.guide.place", '{"province":"İzmir","district":3}');
    expect(await readPlace(), "a district that is not one").toEqual({ province: "İzmir", district: null });
    for (const broken of ["{", '{"district":"Çeşme"}', "null"]) {
      stored.set("fiala.guide.place", broken);
      expect(await readPlace()).toBeNull();
    }
  });

  it("is forgotten from Ayarlar", async () => {
    await savePlace({ province: "İzmir", district: null });
    await forgetPlace();
    expect(await readPlace()).toBeNull();
  });

  it("goes with every list when the device passes to another account", async () => {
    await savePlace({ province: "İzmir", district: null });
    await saveLocationOn(false);
    await forgetGuide();
    expect(stored.has("fiala.guide.place")).toBe(false);
    expect(await readLocationOn(), "the location is on again").toBe(true);
    const { forgotten } = (await import("../../src/services/kv")) as unknown as { forgotten: string[] };
    expect(forgotten).toEqual(["fiala.guide.recentMedicines", "fiala.guide.starredMedicines", "fiala.guide.recentPharmacies", "fiala.guide.starredPharmacies"]);
  });
});

