// CHANGELOG.md is the single source; a GitHub Release copies its section.
// Exact heading: 1.4.1 must not match 1.4.10.
// Exits 1 when the version has no section: empty release notes are worse than a loud failure.
import { readFileSync } from "node:fs";

/** @param {string} changelog @param {string} version */
export function notesFor(changelog, version) {
  const lines = changelog.split("\n");
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \d/.test(line));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

if (import.meta.main) {
  const version = (process.argv[2] ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: node scripts/release-notes.mjs <version>");
    process.exit(1);
  }
  const notes = notesFor(readFileSync("CHANGELOG.md", "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version}.`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
