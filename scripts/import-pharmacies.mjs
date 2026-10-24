#!/usr/bin/env node
/**
 * Loads Türkiye's pharmacies from OpenStreetMap into `pharmacies`
 * (docs/TASKS.md F5.6a, migration 17). `catalogue.yml` runs it weekly with the
 * service-role key; nothing else writes there.
 *
 * Two Overpass questions, each one request: the pharmacies inside each of the
 * 81 provinces, then inside each district. A pharmacy's province and district
 * are the areas it lies in, not its address tags, which three in four lack
 * (measured 24.10.2026: 25,365 pharmacies, each in exactly one of each).
 * The data is ODbL: the screen names OpenStreetMap's contributors as its
 * source, and the table is the derived database that licence describes.
 * Rows a newer load no longer carries are dropped after the new ones land,
 * and a load far smaller than the last stops before anything is dropped.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-pharmacies.mjs
 */

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const AGENT = "fiala-pharmacies (+https://github.com/topraksv/fiala)";
const BATCH = 1000;
/** 25,365 on 24.10.2026: fewer than this is a failed answer, not a week's change. */
export const MIN_ROWS = 20_000;

const AREAS = (level, inside) => `[out:json][timeout:900];
area["ISO3166-1"="TR"]["admin_level"="2"]->.tr;
rel(area.tr)["boundary"="administrative"]["admin_level"="${level}"]${level === 4 ? '["ISO3166-2"~"^TR-"]' : ""}->.areas;
foreach.areas->.each(
  .each out tags;
  .each map_to_area->.inside;
  nwr(area.inside)["amenity"="pharmacy"];
  out ${inside} qt;
);`;
/** Provinces with their pharmacies' ids; districts with the pharmacies themselves. */
export const PROVINCES = AREAS(4, "ids");
export const DISTRICTS = AREAS(6, "center tags");

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max) || null;
const areaName = (tags) => text(tags["name:tr"] ?? tags.name, 80);

/**
 * Each pharmacy in a province, as a row: the district pass names its district
 * and carries its tags, the province pass its province. An area's tags come
 * before what lies in it, so each element belongs to the last area read. A
 * pharmacy in no province is across the border, in a district relation that
 * only touches Türkiye.
 */
export function pharmacyRows(provinces, districts, seenOn) {
  const provinceOf = new Map();
  let area = null;
  for (const element of provinces.elements) {
    if (element.type === "relation" && element.tags?.boundary === "administrative") area = areaName(element.tags);
    else if (area) provinceOf.set(`${element.type}/${element.id}`, area);
  }
  const rows = new Map();
  for (const element of districts.elements) {
    if (element.type === "relation" && element.tags?.boundary === "administrative") {
      area = areaName(element.tags);
      continue;
    }
    const id = `${element.type}/${element.id}`;
    const province = provinceOf.get(id);
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!province || typeof lat !== "number" || typeof lon !== "number") continue;
    const tags = element.tags ?? {};
    const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
    rows.set(id, {
      id,
      name: text(tags.name ?? tags["name:tr"], 200),
      province,
      district: area,
      neighbourhood: text(tags["addr:neighbourhood"] ?? tags["addr:suburb"], 120),
      address: text(tags["addr:full"] ?? street, 300),
      phone: text(tags.phone ?? tags["contact:phone"], 60),
      opening_hours: text(tags.opening_hours, 300),
      lat,
      lon,
      seen_on: seenOn,
    });
  }
  return [...rows.values()];
}

async function fetchOk(url, init) {
  const response = await fetch(url, { ...init, headers: { "User-Agent": AGENT, ...init?.headers } });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname} answered ${response.status}`);
  return response;
}

/** One Overpass answer: a busy server says 429 or 504, so each endpoint is asked twice, a minute apart. */
async function overpass(query) {
  let last;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await (await fetchOk(endpoint, { method: "POST", body: new URLSearchParams({ data: query }) })).json();
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
    }
  }
  throw last;
}

async function main() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const seenOn = new Date().toISOString().slice(0, 10);
  const rows = pharmacyRows(await overpass(PROVINCES), await overpass(DISTRICTS), seenOn);
  if (rows.length < MIN_ROWS) throw new Error(`OpenStreetMap gave ${rows.length} pharmacies; nothing was changed`);

  const table = `${base}/rest/v1/pharmacies`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  for (let at = 0; at < rows.length; at += BATCH) {
    await fetchOk(`${table}?on_conflict=id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(at, at + BATCH)),
    });
  }
  await fetchOk(`${table}?seen_on=lt.${seenOn}`, { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } });
  console.log(`pharmacies: ${rows.length} rows seen on ${seenOn}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
