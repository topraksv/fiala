import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

interface CorpusOptions {
  /** Which files count. Defaults to TypeScript sources. */
  extensions?: readonly string[];
  /** Directory names never walked into. */
  skip?: readonly string[];
  /**
   * The smallest corpus that can still be the thing this test means to scan.
   * Required on purpose — see below.
   */
  atLeast: number;
}

/**
 * The files a contract test scans, proven to exist.
 *
 * Every source-scanning test in this suite has the same shape: walk a
 * directory, collect what breaks a rule, assert the list of offenders is
 * empty. All of them also pass when the walk returns NOTHING — so a renamed
 * directory, a changed extension or a different working directory quietly
 * turns an architectural guard into a green test that checks nothing, and the
 * suite reports it as coverage.
 *
 * `atLeast` has no default because the floor is part of the assertion.
 */
export function sourceFiles(directory: string, options: CorpusOptions): string[] {
  const { extensions = [".ts", ".tsx"], skip = ["migrations", "node_modules"], atLeast } = options;
  const walk = (relative: string): string[] =>
    readdirSync(join(ROOT, relative), { withFileTypes: true }).flatMap((entry) => {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) return skip.includes(entry.name) ? [] : walk(path);
      return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
    });
  const found = walk(directory);
  if (found.length < atLeast) {
    throw new Error(
      `${directory} yielded ${found.length} source files, expected at least ${atLeast}. `
      + "A contract test that scans an empty corpus passes for the wrong reason.",
    );
  }
  return found;
}
