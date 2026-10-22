// Serves a production web export the way GitHub Pages does: usage `node scripts/serve-web-export.mjs <export-dir> <port>`.
// Under app.json's experiments.baseUrl a directory falls back to its index.html, an extensionless path tries <path>.html first,
// and anything unresolved (a dynamic route's real path included) is 404.html with status 404, never the shell with a 200.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node scripts/serve-web-export.mjs <export-dir> <port>");
  process.exit(1);
}
const { name, experiments } = JSON.parse(await readFile(new URL("../app.json", import.meta.url), "utf8")).expo;
const baseUrl = experiments.baseUrl;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const exists = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Refuse anything that climbs out of the export directory. */
function withinRoot(candidate) {
  const full = resolve(root, `.${normalize(candidate)}`);
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function resolveFile(pathname) {
  let requested = pathname;
  if (requested.startsWith(baseUrl)) requested = requested.slice(baseUrl.length) || "/";
  const safe = withinRoot(requested);
  if (!safe) return null;
  if (await exists(safe)) return safe;
  if (await exists(`${safe}.html`)) return `${safe}.html`;
  const asIndex = join(safe, "index.html");
  if (await exists(asIndex)) return asIndex;
  const missing = join(root, "404.html");
  return (await exists(missing)) ? missing : null;
}

if (!(await exists(join(root, "index.html")))) {
  console.error(
    `No export at ${root}. Build one first:\n  npx expo export -p web --clear\nthen: npm run web:preview`,
  );
  process.exit(1);
}

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = await resolveFile(pathname);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(file === join(root, "404.html") ? 404 : 200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(await readFile(file));
  } catch (error) {
    // The detail goes to the console, not down the socket: a stack trace in a body names paths and internals to anyone who can reach the port.
    console.error("serve-web-export: request failed", error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal error");
  }
}).listen(port, () => {
  console.log(`${name} web export on http://localhost:${port}${baseUrl}/`);
});
