/**
 * The web app installs and opens offline under its base (SPEC 6.1, 3.1).
 * The manifest, the worker and the shell each name the base as a literal,
 * since none of them runs through the bundler; a move to another origin
 * (`docs/BACKLOG.md`) that changed `baseUrl` alone would break installing
 * and the offline start without a single failing screen.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const base = `${JSON.parse(read("app.json")).expo.experiments.baseUrl}/`;
const manifest = JSON.parse(read("public/manifest.webmanifest"));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): string {
  const bytes = readFileSync(join(root, path));
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("the installed web app", () => {
  it("starts and stays under the export's base", () => {
    expect(manifest.start_url).toBe(base);
    expect(manifest.scope).toBe(base);
  });

  it("has the icons it declares, at the sizes it declares", () => {
    // The maskable one is its own drawing, with the mark inside the safe zone
    // a launcher's mask never cuts; the plain ones would lose the leaf to it.
    expect(manifest.icons.map((icon: { sizes: string; purpose: string }) => `${icon.sizes} ${icon.purpose}`)).toEqual([
      "192x192 any",
      "512x512 any",
      "512x512 maskable",
    ]);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith(base), icon.src).toBe(true);
      expect(pngSize(`public/${icon.src.slice(base.length)}`)).toBe(icon.sizes);
    }
    expect(pngSize("public/icons/apple-touch-icon.png")).toBe("180x180");
  });

  it("registers a worker scoped to the base, whose offline shell is the base's page", () => {
    const shell = read("src/app/+html.tsx");
    expect(shell).toContain(`register("${base}sw.js",{scope:"${base}"})`);
    expect(shell).toContain(`href="${base}manifest.webmanifest"`);
    expect(read("public/sw.js")).toContain(`const SHELL = "${base}index.html";`);
  });

  it("names the page a pasted link opens, served under the base by the name it is published as", () => {
    expect(read("src/app/+html.tsx")).toContain(`const SITE_URL = "https://topraksv.github.io${base}";`);
  });
});

/** The worker's own functions, run outside a browser: nothing else in it runs on load. */
function worker(): Record<string, unknown> {
  const context: Record<string, unknown> = { self: { addEventListener: () => {} } };
  runInNewContext(read("public/sw.js"), context);
  return context;
}
const workerPrunable = () => worker().prunable as (paths: string[]) => string[];

describe("the web database", () => {
  // Helix shares this origin, and expo-sqlite's pool locks every file in its
  // folder: in one folder, whichever app opened first locks the other out.
  it("lives in a folder of Fiala's own, not the one Helix's pool locks", () => {
    expect(JSON.parse(read("package.json")).scripts.postinstall).toBe("node scripts/patch-dependencies.mjs");
    const worker = read("node_modules/expo-sqlite/web/worker.ts");
    expect(worker).toContain("const VFS_NAME_PERSISTENT = 'fiala-sqlite';");
  });
});

describe("the offline worker's cache-first rule", () => {
  // A file whose name never changes, served cache-first, is the first copy
  // forever.
  it("serves from the cache first only what a build names by its content", () => {
    const hashed = worker().hashed as (path: string) => boolean;
    expect(hashed(`${base}_expo/static/js/web/entry-0f1e2d3c4b5a69788796a5b4c3d2e1f0.js`)).toBe(true);
    expect(hashed(`${base}assets/assets/fonts/Inter_600SemiBold.01a8a409ba37ab3934865fbb212fb2c9.ttf`)).toBe(true);
    for (const path of ["favicon.ico", "icons/icon-192.png", "icons/email-mark.png", "manifest.webmanifest", "og-cover.jpg"]) {
      expect(hashed(`${base}${path}`), path).toBe(false);
    }
  });
});

describe("the offline worker's prune", () => {
  const code = (n: number) => Array.from({ length: n }, (_, i) => `${base}_expo/static/js/web/entry-${i}.js`);
  const pictures = (n: number) => Array.from({ length: n }, (_, i) => `${base}assets/assets/noto/p${i}.webp`);

  it("keeps the catalogue's pictures however much code piles up", () => {
    const prunable = workerPrunable();
    const stale = prunable([`${base}index.html`, ...code(121), ...pictures(133)]);
    expect(stale).toEqual(code(121));
  });

  it("keeps everything while each kind is under its own cap", () => {
    expect(workerPrunable()([`${base}index.html`, ...code(120), ...pictures(133)])).toEqual([]);
  });
});
