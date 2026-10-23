import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appStoreMajor, appVersionOf, entryOf, greenRun, openRuns, otaRecord, titleOf } from "../../scripts/check-published.mjs";

const root = join(import.meta.dirname, "../..");

describe("check-published", () => {
  // GitHub's run search answered weeks stale, so every filter is here.
  it("finds the newest green push run on main, or a commit's, and the head's open runs", () => {
    const run = (head_sha: string, extra: Record<string, string> = {}) => ({
      head_sha, event: "push", head_branch: "main", conclusion: "success", status: "completed", html_url: `u/${head_sha}`, ...extra,
    });
    const runs = [
      run("h", { status: "in_progress", conclusion: "" }),
      run("d", { event: "workflow_dispatch" }),
      run("f", { conclusion: "failure" }),
      run("o", { head_branch: "other" }),
      run("g"),
      run("e"),
    ];
    expect(greenRun(runs)?.head_sha).toBe("g");
    expect(greenRun(runs, "e")?.html_url).toBe("u/e");
    expect(greenRun(runs, "d")).toBeNull();
    expect(openRuns(runs, "h")).toBe(1);
    expect(openRuns(runs, "g")).toBe(0);
  });

  it("reads the entry bundle a shell under the site's base references", () => {
    const html = '<script src="/fiala/_expo/static/js/web/entry-4daa5bb8e8ad49f6911813b0513df45f.js" defer></script>';
    expect(entryOf(html)).toBe("/_expo/static/js/web/entry-4daa5bb8e8ad49f6911813b0513df45f.js");
    expect(entryOf("<html></html>")).toBeNull();
  });

  // The browser shows the first <title>; Expo Router's head writes an empty
  // one before the shell's unless a screen gives it one.
  it("reads the title a browser shows, the first in the document", () => {
    expect(titleOf('<title data-rh="true">Fiala · Ne eksik?</title><title>Fiala</title>')).toBe("Fiala · Ne eksik?");
    expect(titleOf('<title data-rh="true"></title><title>Fiala</title>')).toBe("");
    expect(titleOf("<html></html>")).toBeNull();
  });

  // One `eas update --platform all`: both platforms, one group, and the
  // runtime Expo Go loads for this SDK, or the phone never sees it.
  it("accepts one update per platform in one group on Expo Go's runtime, and records it", () => {
    const update = (platform: string, runtimeVersion = "exposdk:57.0.0", group = "g1") => ({
      platform, runtimeVersion, group, id: `${platform}-id`, message: "1.0.0 abc", manifestPermalink: `https://u.expo.dev/${platform}`,
    });
    const { problems, summary } = otaRecord([update("ios"), update("android")], 57);
    expect(problems).toEqual([]);
    expect(summary.join("\n")).toContain("`g1`");
    expect(summary.join("\n")).toContain("| android | `android-id` |");
    expect(otaRecord([update("ios")], 57).problems).toEqual(["expected one update per platform, got [ios]"]);
    expect(otaRecord([update("ios"), update("android", "exposdk:57.0.0", "g2")], 57).problems).toEqual(["expected one update group, got 2"]);
    expect(otaRecord([update("ios", "1.0.0"), update("android")], 57).problems).toEqual(["the ios update targets 1.0.0, not exposdk:57.0.0"]);
    expect(otaRecord(null, 57).problems).toHaveLength(2);
  });

  it("reads the App Store's Expo Go major from Apple's lookup", () => {
    expect(appStoreMajor({ resultCount: 1, results: [{ version: "57.0.9" }] })).toBe(57);
    expect(appStoreMajor({ resultCount: 0, results: [] })).toBeNull();
    expect(appStoreMajor({ results: [{ version: "" }] })).toBeNull();
  });

  // `eas.json` names the CLI the project needs; the publish runs another only
  // by someone moving one and forgetting the other.
  it("publishes with the EAS CLI eas.json names", () => {
    const wanted = JSON.parse(readFileSync(join(root, "eas.json"), "utf8")).cli.version;
    const used = [...readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").matchAll(/eas-cli@([\d.]+)/g)].map(([, version]) => version);
    expect(used.length).toBeGreaterThan(1);
    expect(new Set(used)).toEqual(new Set([wanted]));
  });

  // `sdkVersion` is right for Expo Go only: it does not move when the native
  // project does, so an update sent to a store binary could land on one that
  // cannot run it. With no `updates.url` and no channel, expo-updates is off in
  // a store build and it runs the bundle it shipped with (Expo SDK 58 docs), so
  // the two share a repository safely. Giving a store build updates means
  // `fingerprint` first, and this test fails until then.
  it("builds a TestFlight binary that no Expo Go update can reach", () => {
    const eas = JSON.parse(readFileSync(join(root, "eas.json"), "utf8"));
    const app = JSON.parse(readFileSync(join(root, "app.json"), "utf8")).expo;
    expect(eas.build.production).toMatchObject({ autoIncrement: true });
    expect(eas.cli.appVersionSource).toBe("remote");
    expect(Object.values(eas.build).filter((profile) => "channel" in (profile as object))).toEqual([]);
    expect(app.updates).toBeUndefined();
    expect(app.runtimeVersion).toEqual({ policy: "sdkVersion" });
    expect(app.ios.config.usesNonExemptEncryption).toBe(false);
  });

  // Expo embeds the app config as an escaped JSON string, beside libraries
  // that declare versions of their own.
  it("reads the version of the object that carries the app's slug", () => {
    const bundle = String.raw`x={\"name\":\"lib\",\"version\":\"9.9.9\"};y="{\"name\":\"Fiala\",\"slug\":\"fiala\",\"version\":\"1.2.0\"}"`;
    expect(appVersionOf(bundle, "fiala")).toBe("1.2.0");
    expect(appVersionOf("{}", "fiala")).toBeNull();
    expect(() => appVersionOf(bundle, "gi.tal")).toThrow();
  });
});

const budgetRoots: string[] = [];
const budgetScript = join(root, "scripts/check-web-budget.mjs");

function fixture(bundle = "console.log('ok');") {
  const root = mkdtempSync(join(tmpdir(), "fiala-web-budget-"));
  budgetRoots.push(root);
  const js = join(root, "_expo", "static", "js", "web");
  mkdirSync(js, { recursive: true });
  writeFileSync(join(js, "entry-test.js"), bundle);
  writeFileSync(join(root, "index.html"), '<script src="/_expo/static/js/web/entry-test.js" defer></script>');
  return { root, js };
}

function check(root: string, args: string[] = [], options: { env?: Record<string, string>; cwd?: string } = {}) {
  return spawnSync(process.execPath, [budgetScript, root, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

afterEach(() => {
  for (const root of budgetRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("web release budget", () => {
  it("accepts a bounded export without public debugging data", () => {
    const { root } = fixture();
    const result = check(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("sourceMapFiles: 0");
    expect(result.stdout).toContain("sourceMapReferences: 0");
  });

  // Pictures are content, not code: a catalogue of product photos grows on
  // its own clock, so it carries a ceiling of its own instead of eating the
  // export's.
  it("weighs pictures apart from the rest of the export", () => {
    const { root } = fixture();
    writeFileSync(join(root, "photo.webp"), "x".repeat(1000));
    const result = check(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pictureBytes: 1000 bytes");
    expect(result.stdout).toContain("totalExport: 82 bytes");
  });

  it("rejects source-map files and bundle references", () => {
    const { root, js } = fixture("console.log('mapped');\n//# sourceMappingURL=entry-test.js.map");
    writeFileSync(join(js, "entry-test.js.map"), "{}");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Public source maps found");
    expect(result.stderr).toContain("Public source-map references found");
  });

  // Metro's transform cache is shared by `expo export` and `eas update` and its
  // key ignores EXPO_PUBLIC_* values, so a cache left by the local-only E2E
  // export yields a bundle with no Supabase configuration — sign-in and sync
  // silently gone, invisible to every other budget metric.
  it("rejects a production export that lost its Supabase configuration", () => {
    const { root } = fixture("console.log('no config here');");
    const result = check(root, ["--require-supabase-config"], {
      env: { EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("supabaseConfigInlined: false");
    expect(result.stderr).toContain("Re-export with --clear");
  });

  it("accepts a production export that carries it, and says so when there is none to carry", () => {
    const configured = fixture("var u='https://example.supabase.co';");
    expect(check(configured.root, ["--require-supabase-config"], {
      env: { EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co" },
    }).status).toBe(0);

    // A local-only build is legitimate; the skip is printed, never assumed. Run
    // from the fixture directory so the repository's own `.env` cannot answer
    // for an environment that genuinely has none.
    const local = fixture();
    const result = check(local.root, ["--require-supabase-config"], {
      cwd: local.root,
      env: { EXPO_PUBLIC_SUPABASE_URL: "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("supabaseConfigInlined: skipped");
  });

  // What push protection cannot see: a value that reaches the bundle from a
  // build environment rather than from a commit. The credentials are assembled
  // at runtime so this file does not itself carry the shapes it tests for.
  it("rejects a server credential anywhere in the export, naming the file and never the value", () => {
    const secret = ["sb", "secret", "x".repeat(24)].join("_");
    const { root } = fixture(`var key="${secret}";`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("serverCredentialReferences: 1");
    expect(result.stderr).toContain(`Supabase secret key in ${join("_expo", "static", "js", "web", "entry-test.js")}`);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it("tells a service-role JWT from the anon one that ships by design", () => {
    const token = (role: string) => [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "supabase", role })).toString("base64url"),
      Buffer.from("not-a-real-signature").toString("base64url"),
    ].join(".");
    expect(check(fixture(`var anon="${token("anon")}";`).root).status).toBe(0);
    const leaked = check(fixture(`var admin="${token("service_role")}";`).root);
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain("service-role JWT in");
  });
});
