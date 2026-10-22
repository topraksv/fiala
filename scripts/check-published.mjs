/**
 * Ask what was actually published, rather than whether a request succeeded.
 *
 *   node scripts/check-published.mjs entry <export-dir>
 *   node scripts/check-published.mjs web <base-url> [--entry <path>] [--wait <seconds>]
 *   node scripts/check-published.mjs ota <eas-update.json>
 *   node scripts/check-published.mjs expo-go
 *   node scripts/check-published.mjs green [--sha <commit>] [--head <commit>]
 *
 * `entry` prints the export's entry bundle as `path=…`, for $GITHUB_OUTPUT.
 * That name is a content hash, so no other build carries it, and `web` asks
 * the live site for exactly that name with the same code. It also refuses an
 * export whose page has no title to show. A 200 would not do:
 * Pages answers 200 with the previous deploy while a new one propagates, and a
 * half-published artifact answers 200 for a shell whose bundle is gone.
 * Without `--entry`, `web` checks what the nightly can know — that the live
 * bundle declares the version `app.json` names.
 *
 * `ota` verifies and records one `eas update --json` publication. `expo-go`
 * asks whether the Expo Go the stores carry can open this project at all;
 * `.github/workflows/nightly.yml` records why that is a question.
 *
 * `green` prints `sha=…` and `url=…` for the newest green `ci` push run on
 * `main` — with `--sha`, that commit's — and with `--head`, `open=…`, how many
 * push runs of that commit are still going.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The entry bundle a page references, as a path below the site's base. */
export function entryOf(html) {
  return /\/_expo\/static\/js\/web\/entry-[\w-]+\.js/.exec(html)?.[0] ?? null;
}

/** The title a browser shows: the first `<title>` in the document, empty or not. */
export function titleOf(html) {
  return /<title[^>]*>([^<]*)<\/title>/.exec(html)?.[1] ?? null;
}

/**
 * The version the app config inside a bundle declares.
 *
 * Expo embeds that config as a JSON string, so every quote in it arrives
 * escaped: a search for `"version":"1.8.0"` finds nothing whether the version
 * matches or not, which is a check that fails the same way on a healthy site.
 * Backslashes go first. The version is read from the object that carries the
 * app's own slug — `[^{}]` keeps both keys in one object — because a library
 * in the same bundle may declare a version of its own.
 */
export function appVersionOf(bundle, slug) {
  // Expo slugs are URL-safe words, and holding the slug to that shape is what
  // lets it sit in a pattern without an escape that could be incomplete.
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error(`not an Expo slug: ${slug}`);
  const flat = bundle.replaceAll("\\", "");
  const after = new RegExp(`"slug":"${slug}"[^{}]*?"version":"(\\d+\\.\\d+\\.\\d+)"`).exec(flat);
  const before = new RegExp(`"version":"(\\d+\\.\\d+\\.\\d+)"[^{}]*?"slug":"${slug}"`).exec(flat);
  return after?.[1] ?? before?.[1] ?? null;
}

/**
 * The newest released SDK in Expo's version list, which names previews before any store carries their client:
 * released means no prerelease tag, no `beta` flag, and a `releaseNoteUrl`.
 */
export function storeSdkMajor(sdkVersions) {
  const released = Object.entries(sdkVersions ?? {})
    .filter(([, sdk]) => typeof sdk?.expoVersion === "string" && !sdk.expoVersion.includes("-") && sdk.beta !== true && typeof sdk.releaseNoteUrl === "string")
    .map(([version]) => Number.parseInt(version, 10))
    .filter((major) => Number.isInteger(major));
  return released.length > 0 ? Math.max(...released) : null;
}

/**
 * The Expo Go major the App Store carries, from Apple's lookup of the app. Expo marks an SDK released, client
 * versions included, while Apple is still reviewing that client: on 2026-10-17 Expo listed iOS 58.0.4 and the
 * store sold 57.0.9.
 */
export function appStoreMajor(lookup) {
  const version = lookup?.results?.[0]?.version;
  const major = typeof version === "string" ? Number.parseInt(version, 10) : Number.NaN;
  return Number.isInteger(major) ? major : null;
}

/**
 * One `eas update --platform all` publication, verified and written down.
 *
 * It is two updates in one group, and each must name the runtime Expo Go loads
 * for this SDK; anything else was published for a client that does not exist
 * here. The group and both ids are what a rollback republishes from, so they
 * are recorded where the run keeps them rather than copied out by hand.
 */
export function otaRecord(updates, sdkMajor) {
  const list = Array.isArray(updates) ? updates : [];
  const runtime = `exposdk:${sdkMajor}.0.0`;
  const problems = [];
  const platforms = list.map((update) => update.platform).sort().join(",");
  if (platforms !== "android,ios") problems.push(`expected one update per platform, got [${platforms}]`);
  const groups = new Set(list.map((update) => update.group));
  if (groups.size !== 1) problems.push(`expected one update group, got ${groups.size}`);
  for (const update of list) {
    if (update.runtimeVersion !== runtime) {
      problems.push(`the ${update.platform} update targets ${update.runtimeVersion}, not ${runtime}`);
    }
  }
  const [first] = list;
  const summary = [
    "### Expo Go preview update",
    "",
    `- **Group:** \`${first?.group ?? "none"}\``,
    `- **Runtime:** \`${first?.runtimeVersion ?? "none"}\``,
    `- **Message:** ${first?.message ?? "none"}`,
    "",
    "| Platform | Update | Manifest |",
    "|---|---|---|",
    ...list.map((update) => `| ${update.platform} | \`${update.id}\` | ${update.manifestPermalink} |`),
  ];
  return { problems, summary };
}

/** The run `green` looks for, newest first; GitHub's own run-search filters returned stale runs, so every filter is applied here. */
export function greenRun(runs, sha) {
  return runs.find((run) => run.event === "push" && run.head_branch === "main" && run.conclusion === "success" && (!sha || run.head_sha === sha)) ?? null;
}

/** Push runs of `head` on `main` that have not finished. */
export const openRuns = (runs, head) =>
  runs.filter((run) => run.event === "push" && run.head_branch === "main" && run.head_sha === head && run.status !== "completed").length;

/** Ten pages: a thousand runs is months of pushes, and a commit older is refused. */
const RUN_PAGES = 10;

async function checkGreen({ sha, head }) {
  const runs = [];
  for (let page = 1; page <= RUN_PAGES && !greenRun(runs, sha); page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return fail(`GitHub answered HTTP ${response.status} for page ${page} of ci's runs`);
    const { workflow_runs: more = [] } = await response.json();
    runs.push(...more);
    if (more.length < 100) break;
  }
  const run = greenRun(runs, sha);
  process.stdout.write(`sha=${run?.head_sha ?? ""}\nurl=${run?.html_url ?? ""}\n`);
  if (head) process.stdout.write(`open=${openRuns(runs, head)}\n`);
}

const fail = (message) => {
  console.log(`::error::${message}`);
  process.exitCode = 1;
};

const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** A network error is asked again; an HTTP status is an answer and returned as one. */
async function get(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (attempt === 3) throw error;
      await pause(5_000);
    }
  }
}

async function checkWeb(base, { expected, waitSeconds, version, slug }) {
  const site = base.replace(/\/+$/, "");
  const deadline = Date.now() + waitSeconds * 1_000;
  let shell = await get(`${site}/`);
  let entry = shell.status === 200 ? entryOf(shell.body) : null;
  while (expected && entry !== expected && Date.now() < deadline) {
    console.log(`the site still serves ${entry ?? `HTTP ${shell.status}`}; asking again`);
    await pause(15_000);
    shell = await get(`${site}/`);
    entry = shell.status === 200 ? entryOf(shell.body) : null;
  }
  if (shell.status !== 200) return fail(`${site}/ answered HTTP ${shell.status}`);
  if (!entry) return fail(`${site}/ references no entry bundle`);
  if (expected && entry !== expected) {
    return fail(`production serves ${entry} after ${waitSeconds}s of asking; this run built ${expected}`);
  }
  const bundle = await get(`${site}${entry}`);
  if (bundle.status !== 200) return fail(`the shell references ${entry} and the site answers HTTP ${bundle.status} for it`);
  const served = appVersionOf(bundle.body, slug);
  if (served !== version) return fail(`production is not serving ${version}: the live bundle declares ${served ?? "no app version"}`);
  // A static route below the root, so a publication that carried only the shell is caught too.
  const route = await get(`${site}/privacy`);
  if (route.status !== 200) return fail(`${site}/privacy answered HTTP ${route.status}`);
  console.log(`production serves ${entry}, declaring ${version}`);
  // The summary renders as Markdown, so it records only what this run asserted, never anything the site sent.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const confirmed = expected ? `serves \`${expected}\`, declaring ${version}` : `declares ${version}`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Web publication\n\nProduction ${confirmed}\n`);
  }
}

async function checkExpoGo(projectMajor) {
  const answer = await get("https://api.expo.dev/v2/versions/latest");
  if (answer.status !== 200) return fail(`api.expo.dev answered HTTP ${answer.status}; the store client could not be read`);
  const sdkVersions = JSON.parse(answer.body).data?.sdkVersions ?? {};
  const store = storeSdkMajor(sdkVersions);
  if (store == null) return fail("Expo's version list names no released SDK");
  const client = Object.entries(sdkVersions).find(([version]) => Number.parseInt(version, 10) === store)[1];
  const clients = `iOS ${client.iosClientVersion}, Android ${client.androidClientVersion}`;
  if (projectMajor < store) {
    // The owner moves when both stores carry the client, and iOS is the one that lags.
    const lookup = await get("https://itunes.apple.com/lookup?id=982107779&country=tr");
    const ios = lookup.status === 200 ? appStoreMajor(JSON.parse(lookup.body)) : null;
    if (ios == null) return fail(`the App Store's Expo Go could not be read (HTTP ${lookup.status})`);
    if (ios === projectMajor) {
      console.log(`::notice::SDK ${store} is released (${clients}), but the App Store's Expo Go still runs SDK ${ios}; move when it carries ${store}`);
      return;
    }
  }
  if (projectMajor !== store) {
    return fail(
      `the stores' Expo Go runs SDK ${store} (${clients}) and this project is on SDK ${projectMajor}: ` +
        "a preview update still publishes, and no up-to-date phone can open it. Move one SDK at a time.",
    );
  }
  console.log(`Expo Go (${clients}) opens SDK ${projectMajor}`);
  const ahead = new Set(Object.keys(sdkVersions).map((version) => Number.parseInt(version, 10)).filter((major) => major > store));
  for (const major of ahead) {
    console.log(`::notice::SDK ${major} is listed ahead of the stores; the day it is released, this check fails until the project moves to it`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [command, target] = args;
  const option = (name) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? "") : undefined);
  const projectMajor = () => Number.parseInt(String(JSON.parse(readFileSync("package.json", "utf8")).dependencies.expo).replace(/^\D*/, ""), 10);

  if (command === "entry" && target) {
    const html = readFileSync(join(target, "index.html"), "utf8");
    const entry = entryOf(html);
    if (!entry) throw new Error(`${target}/index.html references no entry bundle`);
    if (!titleOf(html)) throw new Error(`${target}/index.html shows no title: its first <title> is empty or missing`);
    process.stdout.write(`path=${entry}\n`);
  } else if (command === "web" && target) {
    const expected = option("--entry");
    if (expected === "") return fail("--entry was given no bundle to look for");
    const { version, slug } = JSON.parse(readFileSync("app.json", "utf8")).expo;
    await checkWeb(target, { expected, waitSeconds: Number(option("--wait") ?? 0), version, slug });
  } else if (command === "ota" && target) {
    const { problems, summary } = otaRecord(JSON.parse(readFileSync(target, "utf8")), projectMajor());
    console.log(summary.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
    for (const problem of problems) fail(problem);
  } else if (command === "expo-go") {
    await checkExpoGo(projectMajor());
  } else if (command === "green") {
    await checkGreen({ sha: option("--sha"), head: option("--head") });
  } else {
    console.error("usage: check-published.mjs entry <dir> | web <base-url> [--entry <path>] [--wait <seconds>] | ota <file> | expo-go | green [--sha <commit>] [--head <commit>]");
    process.exitCode = 1;
  }
}

// An unreachable site is a finding with a sentence, not a stack trace: "down" and "stale" need different work.
if (import.meta.main) {
  await main().catch((error) => fail(`could not complete the check: ${error.message}`));
}
