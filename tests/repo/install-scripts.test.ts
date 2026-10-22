/**
 * Which dependencies are allowed to run code at install time.
 *
 * `npm ci` executes `preinstall`, `install` and `postinstall` from every
 * package in the tree, with the developer's own credentials and no sandbox.
 * That is the vector both Shai-Hulud waves used, and the one the April 2026
 * axios compromise used after valid SLSA provenance had already been produced —
 * a signature proves who built a tarball, not what its install hook does.
 *
 * `--ignore-scripts` is the obvious answer and it is the wrong one here:
 * esbuild's postinstall is what validates the platform binary its
 * optionalDependency installed, and turning it off trades a supply-chain risk
 * for a build that fails in a way nobody can read. What is actionable is the
 * SET: it is small, it is stable, and it should never grow without somebody
 * looking. A dependency that quietly gains an install hook in a patch release
 * is exactly the event worth a red build.
 *
 * The allowlist is deliberately by name only. Pinning versions here would fail
 * on every routine bump and get deleted within a month, which is worse than not
 * having it — what matters is that no NEW package started running code.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;

/**
 * Every package in the installed tree that runs a script at install time.
 *
 * The lockfile is not the source: it records `hasInstallScript` only for
 * packages npm has resolved that way, while the manifest on disk is what npm
 * actually executes.
 */
function packagesWithInstallScripts(root = "node_modules"): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const path = join(directory, entry.name);
      // A scope is a folder of packages, not a package.
      if (entry.name.startsWith("@")) {
        walk(path);
        continue;
      }
      try {
        const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        const scripts = manifest.scripts ?? {};
        if (INSTALL_HOOKS.some((hook) => scripts[hook])) found.push(manifest.name ?? entry.name);
      } catch {
        // Not a package directory; keep walking.
      }
      walk(join(path, "node_modules"));
    }
  };
  walk(root);
  return [...new Set(found)].sort();
}

/** Every install hook is an allowlisted decision; a new one fails here, and an entry no longer installed must be pruned. */
const ALLOWED = ["esbuild", "unrs-resolver"];

describe("install-time code execution", () => {
  it("runs install scripts only from the packages that are meant to", () => {
    // An empty or half-installed tree cannot equal the allowlist, so this
    // cannot pass while proving nothing.
    expect(packagesWithInstallScripts(), "install-time code differs from the allowlist").toEqual(ALLOWED);
  });
});
