import { expect, type Page, test } from "@playwright/test";
import { SPONSOR_URL } from "./sponsor.js";

// Each hosted surface asks its sponsor for terms once it has something to quote. Built
// with a sponsor url, that is the url it asks; built without one, it would ask
// http://localhost:8787, which no visitor can reach.
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

async function recordAndAbortOffsite(page: Page, origin: string): Promise<string[]> {
  const asked: string[] = [];
  await page.route(
    (url) => url.origin !== origin,
    (route) => {
      asked.push(route.request().url());
      return route.abort();
    },
  );
  return asked;
}

async function askForQuote(page: Page): Promise<void> {
  const root = page.locator(".mv-root").first();
  await expect(root.getByText("Send to Stellar")).toBeVisible();
  await root.getByRole("button", { name: /Recipient/ }).click();
  await root.getByRole("textbox", { name: "Stellar address" }).fill(VALID_ADDRESS);
  await root.getByRole("button", { name: "Use this address" }).click();
  await root.getByRole("textbox", { name: "Amount to send" }).fill("25");
}

const SURFACES: readonly { name: string; url: string; reveal?: string }[] = [
  { name: "app", url: "http://localhost:4319/" },
  { name: "playground", url: "http://localhost:4320/" },
  // the landing mounts its widget only once it nears the viewport
  {
    name: "landing",
    url: "http://localhost:4321/",
    reveal: "One transfer. Every bridge answers at the same time.",
  },
  { name: "docs live widget", url: "http://localhost:4322/widget" },
];

for (const surface of SURFACES) {
  test(`the ${surface.name} asks the sponsor it was built with`, async ({ page }) => {
    const asked = await recordAndAbortOffsite(page, new URL(surface.url).origin);
    await page.goto(surface.url);
    if (surface.reveal !== undefined) await page.getByText(surface.reveal).scrollIntoViewIfNeeded();
    await askForQuote(page);
    await expect.poll(() => asked.some((url) => url === `${SPONSOR_URL}/health`)).toBe(true);
    expect(asked.filter((url) => url.startsWith("http://localhost:8787"))).toEqual([]);
  });
}
