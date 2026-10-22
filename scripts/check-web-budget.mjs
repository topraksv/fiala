/**
 * Fail when the web export outgrows its ceilings or carries what a public site
 * must not: a source map, a server credential, or (with
 * `--require-supabase-config`) a production bundle without its Supabase
 * configuration.
 */
// Metro does not tree-shake: a ceiling is what names the commit that pulled a library into the entry bundle.
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.argv[2] ?? "dist";

const limits = {
  entryJavaScript: 1_935_500,
  totalJavaScript: 2_095_500,
  totalExport: 3_619_500,
  // A picture set can grow for a product reason and would otherwise hide a code regression in the total.
  pictureBytes: 58_900,
  // Exact, so adding a weight has to be a decision.
  fontFiles: 4,
  fontBytes: 615_500,
  // Pages is public: no source maps, no references to them.
  sourceMapFiles: 0,
  sourceMapReferences: 0,
  serverCredentialReferences: 0,
};

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile()) return [];
    return [{ path, size: (await stat(path)).size }];
  }));
  return nested.flat();
}

const files = await walk(root);
const javaScript = files.filter((file) => extname(file.path) === ".js");
const entry = javaScript.find((file) => /[/\\]entry-[^/\\]+\.js$/.test(file.path));
const fonts = files.filter((file) => [".ttf", ".otf", ".woff", ".woff2"].includes(extname(file.path)));
const PICTURE_EXTENSIONS = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif"]);
// Weighed apart: a picture set can grow for a product reason and would hide a code regression in the total.
const pictures = files.filter((file) => PICTURE_EXTENSIONS.has(extname(file.path)));
const isPicture = (file) => PICTURE_EXTENSIONS.has(extname(file.path));
const sourceMaps = files.filter((file) => extname(file.path) === ".map");
const SCANNED = new Set([".js", ".css", ".html", ".json", ".txt", ".xml", ".svg", ".webmanifest"]);
const texts = await Promise.all(files
  .filter((file) => SCANNED.has(extname(file.path)))
  .map(async (file) => ({ file, body: await readFile(file.path, "utf8") })));
const sourceMapReferences = texts
  .filter(({ file, body }) => [".js", ".css"].includes(extname(file.path)) && body.includes("sourceMappingURL="))
  .map(({ file }) => file);
// An EXPO_PUBLIC_* value fed from CI never passes a commit, so push protection cannot see it; findings name the shape and file, never the value.
const CREDENTIAL_SHAPES = [
  ["Supabase secret key", /\bsb_secret_[\w-]{16,}/],
  ["Supabase access token", /\bsbp_[A-Za-z0-9]{40}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{40,})\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{64,}/],
];
// The anon key is a JWT too and ships by design; only the server role is a leak.
const carriesServiceRole = (payload) => {
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role === "service_role";
  } catch {
    return false;
  }
};
const credentialFindings = texts.flatMap(({ file, body }) => {
  const found = CREDENTIAL_SHAPES.filter(([, shape]) => shape.test(body)).map(([name]) => name);
  const jwts = [...body.matchAll(/\beyJ[\w-]{8,}\.(eyJ[\w-]{8,})\.[\w-]{8,}/g)];
  if (jwts.some((match) => carriesServiceRole(match[1]))) found.push("service-role JWT");
  return found.map((name) => `${name} in ${relative(root, file.path)}`);
});
if (credentialFindings.length > 0) console.error(`Server credentials found: ${credentialFindings.join(", ")}`);
const sum = (items) => items.reduce((total, item) => total + item.size, 0);
const metrics = {
  entryJavaScript: entry?.size ?? 0,
  totalJavaScript: sum(javaScript),
  totalExport: sum(files.filter((file) => !isPicture(file))),
  pictureBytes: sum(pictures),
  fontFiles: fonts.length,
  fontBytes: sum(fonts),
  sourceMapFiles: sourceMaps.length,
  sourceMapReferences: sourceMapReferences.length,
  serverCredentialReferences: credentialFindings.length,
};

for (const [name, value] of Object.entries(metrics)) {
  const limit = limits[name];
  const unit = name.endsWith("Files") || name.endsWith("References") ? "" : " bytes";
  console.log(`${name}: ${value}${unit} (budget ${limit}${unit})`);
  if (value > limit) process.exitCode = 1;
}
if (!entry) {
  console.error(`No Expo entry bundle found under ${relative(process.cwd(), root) || root}`);
  process.exitCode = 1;
}
// Metro's cache key ignores EXPO_PUBLIC_*, so a cache left by the E2E export silently drops sign-in and sync; --clear prevents it, this proves it.
// Opt-in because only a production export makes this claim; the skip is printed, never assumed.
if (entry && process.argv.includes("--require-supabase-config")) {
  if (!process.env.EXPO_PUBLIC_SUPABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // No environment and no .env: a local-only build, with nothing to inline.
    }
  }
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.log("supabaseConfigInlined: skipped (no EXPO_PUBLIC_SUPABASE_URL configured)");
  } else {
    const trusted = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl);
    console.log(`supabaseOriginTrusted: ${trusted} (expected true)`);
    if (!trusted) {
      console.error("EXPO_PUBLIC_SUPABASE_URL must be a bare HTTPS Supabase project origin.");
      process.exitCode = 1;
    }
    const inlined = (await readFile(entry.path, "utf8")).includes(supabaseUrl);
    console.log(`supabaseConfigInlined: ${inlined} (expected true)`);
    if (!inlined) {
      console.error("Entry bundle carries no Supabase configuration. Re-export with --clear.");
      process.exitCode = 1;
    }
  }
}
if (sourceMaps.length > 0) {
  console.error(`Public source maps found: ${sourceMaps.map((file) => relative(root, file.path)).join(", ")}`);
}
if (sourceMapReferences.length > 0) {
  console.error(`Public source-map references found: ${sourceMapReferences.map((file) => relative(root, file.path)).join(", ")}`);
}
if (process.exitCode) {
  console.error("Web export exceeds its measured release budget.");
} else {
  console.log("Web export is within its release budget.");
}
