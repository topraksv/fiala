/**
 * The first thing a person meets, in a real browser against the export that
 * deploys, less its Supabase project: the shell opens on its home tab, reaches
 * Ayarlar, changes the theme and finds it kept after a reload. The unit suite
 * holds each part; this holds that they meet — the sqlite worker, the policy
 * the page runs under, the router and the screens.
 */

import { expect, test, type Page } from "@playwright/test";

/** What the page refused or threw: the policy's refusals and uncaught errors. */
async function watchFailures(page: Page): Promise<string[]> {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A route reloaded is answered as Pages answers it: `404.html`, with a 404
    // Chromium logs. A missing script, picture or font still fails.
    const { url } = message.location();
    if (message.text().startsWith("Failed to load resource:") && /^\/fiala\/[^.]*$/.test(new URL(url).pathname)) return;
    failures.push(message.text());
  });
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) => console.error(`CSP ${event.violatedDirective} ${event.blockedURI}`)),
  );
  return failures;
}

test("the shell opens, reaches Ayarlar and keeps the theme @cross-browser", async ({ page }) => {
  const failures = await watchFailures(page);
  await page.goto("/fiala/");

  await expect(page.getByRole("heading", { name: "Fiala kuruluyor" })).toBeVisible();

  await page.getByRole("tab", { name: "Ayarlar" }).click();
  await expect(page.getByRole("heading", { name: "Ayarlar" })).toBeVisible();

  await page.getByRole("radio", { name: "Koyu" }).click();
  await expect(page.getByRole("radio", { name: "Koyu" })).toBeChecked();

  await page.reload();
  await page.getByRole("tab", { name: "Ayarlar" }).click();
  await expect(page.getByRole("radio", { name: "Koyu" })).toBeChecked();

  expect(failures).toEqual([]);
});
