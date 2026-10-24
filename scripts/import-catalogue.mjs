#!/usr/bin/env node
/**
 * Loads TİTCK's weekly list of licensed human medicines into
 * `catalogue_products` (docs/TASKS.md F1.9, migration 16). `catalogue.yml`
 * runs it on a schedule with the service-role key; nothing else writes there.
 *
 * The file's name carries its date and a fresh GUID every week, so the page
 * is read for the newest one rather than a fixed address. Only the facts are
 * kept (barcode, name, substance, ATC, holder, suspension); the file itself is
 * never republished. Rows a newer list no longer carries are dropped after
 * the new ones land, and a list far shorter than a week's stops the import
 * before anything is dropped.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-catalogue.mjs
 */

import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

const PAGE = "https://www.titck.gov.tr/dinamikmodul/85";
const AGENT = "fiala-catalogue (+https://github.com/topraksv/fiala)";
const BATCH = 1000;
/** 23,120 rows on 23.10.2026: a list under this is a broken file, not a week's change. */
export const MIN_ROWS = 15_000;

/** The newest list the page links to, with its date as a local day. */
export function newestList(html) {
  let newest = null;
  for (const [url, day, month, year] of html.matchAll(/https?:\/\/[^"'\s<>]*?(\d{2})\.(\d{2})\.(\d{4})_[^"'\s<>]*?\.xlsx/g)) {
    const listedOn = `${year}-${month}-${day}`;
    if (!newest || listedOn > newest.listedOn) newest = { url, listedOn };
  }
  return newest;
}

/** A GTIN of 8, 12, 13 or 14 digits as the 14 `products.gtin` keeps; `null` where the check digit fails (`normalGtin`'s rule). */
export function gtinOf(cell) {
  const digits = String(cell ?? "").trim();
  if (!/^(?:\d{8}|\d{12,14})$/.test(digits)) return null;
  let sum = 0;
  for (let back = 1; back < digits.length; back++) sum += Number(digits.at(-1 - back)) * (back % 2 === 1 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1)) ? digits.padStart(14, "0") : null;
}

const text = (cell, max) => String(cell ?? "").replace(/\s+/g, " ").trim().slice(0, max) || null;

/**
 * The rows of the list's sheet, found by their headers so a moved column
 * still lands. A row's id is its barcode and name: one barcode names two
 * products in the list, and a row repeated whole is kept once.
 */
export function catalogueRows(matrix, listedOn) {
  const header = matrix.findIndex((row) => row.includes("BARKOD") && row.includes("ÜRÜN ADI"));
  if (header < 0) throw new Error("The list has no header row");
  const heads = matrix[header].map((cell) => String(cell ?? "").trim());
  const column = {
    gtin: heads.indexOf("BARKOD"),
    name: heads.indexOf("ÜRÜN ADI"),
    substance: heads.indexOf("ETKİN MADDE"),
    atc: heads.indexOf("ATC KODU"),
    holder: heads.indexOf("RUHSAT SAHİBİ"),
    suspended: heads.findIndex((cell) => cell.startsWith("RUHSATI ASKIDA")),
  };
  const missing = Object.entries(column).filter(([, at]) => at < 0);
  if (missing.length > 0) throw new Error(`The list has no ${missing.map(([key]) => key).join(", ")} column`);
  const rows = new Map();
  for (const row of matrix.slice(header + 1)) {
    const name = text(row[column.name], 300);
    if (!name) continue;
    const gtin = gtinOf(row[column.gtin]);
    const id = createHash("sha1").update(`${gtin ?? ""}|${name}`).digest("hex");
    rows.set(id, {
      id,
      gtin,
      name,
      active_substance: text(row[column.substance], 600),
      atc: text(row[column.atc], 20),
      holder: text(row[column.holder], 300),
      suspended: Number(row[column.suspended] ?? 0) !== 0,
      listed_on: listedOn,
    });
  }
  return [...rows.values()];
}

async function fetchOk(url, init) {
  const response = await fetch(url, { ...init, headers: { "User-Agent": AGENT, ...init?.headers } });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname} answered ${response.status}`);
  return response;
}

async function main() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const list = newestList(await (await fetchOk(PAGE)).text());
  if (!list) throw new Error("The page links no list");
  const book = XLSX.read(new Uint8Array(await (await fetchOk(list.url)).arrayBuffer()), { type: "array" });
  const sheet = book.Sheets[book.SheetNames.find((name) => name.startsWith("RUHSATLI")) ?? book.SheetNames[0]];
  const rows = catalogueRows(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }), list.listedOn);
  if (rows.length < MIN_ROWS) throw new Error(`The ${list.listedOn} list has ${rows.length} rows; nothing was changed`);

  const table = `${base}/rest/v1/catalogue_products`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  for (let at = 0; at < rows.length; at += BATCH) {
    await fetchOk(`${table}?on_conflict=id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(at, at + BATCH)),
    });
  }
  await fetchOk(`${table}?listed_on=lt.${list.listedOn}`, { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } });
  console.log(`catalogue: ${rows.length} rows from the ${list.listedOn} list`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
