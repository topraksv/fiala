/**
 * What a person on a phone, a tablet or with a screen reader meets on every
 * screen reachable without data of one's own: no WCAG A/AA violation axe can
 * find, no sideways scroll, no control outside the viewport. Directly
 * checkable risks stand in for pixel baselines (`docs/UI.md` sections 9, 10).
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 1024, height: 1366 },
] as const;

// Every route that holds in the local-only build. `/account-security` is not
// among them: it needs Supabase and sends a browser build to Ayarlar.
const ROUTES = [
  "/fiala/",
  "/fiala/cabinet",
  "/fiala/guide",
  "/fiala/settings",
  "/fiala/add-box",
  "/fiala/boxes",
  "/fiala/documents",
  "/fiala/add-document",
  "/fiala/doses",
  "/fiala/dose-plan",
  "/fiala/history",
  "/fiala/households",
  "/fiala/import",
  "/fiala/notices",
  "/fiala/pharmacies",
  "/fiala/privacy",
  "/fiala/profile",
  "/fiala/status-cards",
  "/fiala/sync-issues",
  "/fiala/to-buy",
  "/fiala/to-dispose",
  "/fiala/data-privacy",
  "/fiala/data-reset",
  "/fiala/feedback",
  "/fiala/help",
  "/fiala/names/people",
  "/fiala/names/locations",
  "/fiala/names/tags",
];

/** The shell opens on the tour; a screen is audited with it closed, as it is used. */
async function skipTour(page: Page): Promise<void> {
  await page.goto("/fiala/");
  await expect(page.getByRole("dialog", { name: "Evdeki her kutu tek yerde" })).toBeVisible();
  await page.getByRole("button", { name: "Geç" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * A box in the cabinet, so the list and the two detail screens are audited
 * with a row on them; several violations elsewhere only showed with data.
 * Returns the paths of the product and the box it opened.
 */
async function addBoxAndOpenIt(page: Page): Promise<string[]> {
  await page.goto("/fiala/add-box");
  await page.getByRole("textbox", { name: "Adı", exact: true }).fill("Parasetamol");
  await page.getByRole("textbox", { name: "Son kullanma tarihi" }).fill("01.01.2030");
  await page.getByRole("textbox", { name: "Kalan miktar" }).fill("12");
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();
  await page.getByRole("button", { name: "Açık Rıza Veriyorum" }).click();
  await expect(page).toHaveURL(/\/fiala\/cabinet$/);
  await page.getByRole("button", { name: /^Parasetamol, 1 kutu/ }).click();
  await expect(page).toHaveURL(/\/fiala\/product\/[^/]+$/);
  const product = new URL(page.url()).pathname;
  await page.getByRole("button", { name: /^SKT 01\.01\.2030/ }).last().click();
  await expect(page).toHaveURL(/\/fiala\/box\/[^/]+$/);
  return [product, new URL(page.url()).pathname];
}

async function offscreenControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const found: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[role="button"],[role="tab"],[role="switch"],[role="link"],[role="radio"],[role="checkbox"]'))) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.left < -1 || box.right > width + 1) {
        found.push(`${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)} @${Math.round(box.left)}..${Math.round(box.right)} of ${width}`);
      }
    }
    return found;
  });
}

test("every screen has no WCAG A/AA violation, no sideways scroll and no control off screen, on a phone and a tablet", async ({ page }) => {
  test.setTimeout(240_000);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await skipTour(page);
  const routes = [...ROUTES, ...(await addBoxAndOpenIt(page))];

  // The detectors are live before the sweep is trusted: an unnamed button and a control off the edge.
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "__probe";
    probe.innerHTML = '<button style="position:fixed;top:0;left:-200px;width:100px;height:40px"></button>'
      + '<div role="button" aria-label="probe" style="position:fixed;top:60px;left:-200px;width:100px;height:40px"></div>';
    document.body.append(probe);
  });
  const probed = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(probed.violations.map((violation) => violation.id), "axe is live").toContain("button-name");
  expect(await offscreenControls(page), "the off-screen check is live").toHaveLength(1);
  await page.evaluate(() => document.getElementById("__probe")?.remove());

  const problems: string[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of routes) {
      const tag = `${viewport.name} ${route}`;
      await page.goto(route);
      await expect(page.locator("#root")).toBeVisible();
      await expect(page.getByRole("heading").first(), `${tag} has a heading`).toBeVisible();
      // Last, once the screen has had the axe run to settle: a guard that redirects would audit another screen twice.
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const violation of result.violations) {
        problems.push(`${tag} axe ${violation.id} (${violation.nodes.length}): ${violation.nodes[0]?.html.slice(0, 160)}`);
      }
      const landed = new URL(page.url()).pathname;
      if (landed !== route && landed !== route.replace(/\/$/, "")) problems.push(`${tag} redirected to ${landed}`);
      if (await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth + 1)) problems.push(`${tag} scrolls sideways`);
      for (const control of await offscreenControls(page)) problems.push(`${tag} control outside the viewport: ${control}`);
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
  expect(failures).toEqual([]);
});
