import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { notesFor } from "../../scripts/release-notes.mjs";

const root = join(import.meta.dirname, "../..");

/**
 * Version discipline: `app.json` is the version of record, the
 * changelog's newest section names it, and `release.yml` publishes a tag only
 * from that section. Bumping the version and stopping there fails here.
 */
describe("version and changelog", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const app = JSON.parse(read("app.json"));
  const packageJson = JSON.parse(read("package.json"));
  const changelog = read("CHANGELOG.md");
  const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map((match) => match[1]!);
  const order = (version: string) => version.split(".").map(Number);

  it("ships one version string, in app.json and package.json alike", () => {
    expect(app.expo.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.version).toBe(app.expo.version);
  });

  it("names the shipped version at the top of the changelog, newest first, none twice", () => {
    expect(versions[0]).toBe(app.expo.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let at = 1; at < versions.length; at += 1) {
      const [newer, older] = [order(versions[at - 1]!), order(versions[at]!)];
      expect([0, 1, 2].map((part) => Math.sign(newer[part]! - older[part]!)).find((rank) => rank !== 0), `${versions[at - 1]} above ${versions[at]}`).toBe(1);
    }
  });

  it("gives every release a note of its own", () => {
    for (const version of versions) expect(notesFor(changelog, version), version).toMatch(/^### .+\n\n- .{10,}/);
  });

  it("finds a section by its exact heading, never by a prefix", () => {
    const text = "## 1.4.10\n\n- ten\n\n## 1.4.1\n\n- one\n";
    expect(notesFor(text, "1.4.1")).toBe("- one");
    expect(notesFor(text, "1.4.10")).toBe("- ten");
    expect(notesFor(text, "1.4")).toBeNull();
    expect(notesFor("## 2.0.0\n\n", "2.0.0")).toBeNull();
  });
});
