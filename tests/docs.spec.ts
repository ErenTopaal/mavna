import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PORTS } from "./env.js";

const DOCS = `http://localhost:${PORTS.docs}`;
const content = fileURLToPath(new URL("../apps/docs/content", import.meta.url));

// every page, by the address the site gives its content file
const PAGES = readdirSync(content, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".mdx"))
  .map((file) =>
    `/${file.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "")}`.replace(/(.)\/$/, "$1"),
  );

// one test per page: all of them in one test ran close to its time limit and
// failed at random under a loaded gate
for (const path of PAGES) {
  test(`${path} renders without a console error`, async ({ page }) => {
    // a page that hydrates differently from its prerendered html, or throws, says so here
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await page.goto(`${DOCS}${path}`, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("the docs follow the system theme until the reader picks one", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${DOCS}/`);
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${scheme}\\b`));
    await context.close();
  }
});

test("the docs search finds a page from its text", async ({ page }) => {
  await page.goto(`${DOCS}/`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /search/i })
    .first()
    .click();
  await page.keyboard.type("settlement commit");
  await expect(page.getByRole("dialog").getByText("POST /settlement/commit").first()).toBeVisible();
});

test("an old docs address leads to the page that holds its content", async ({ page }) => {
  await page.goto(`${DOCS}/developers/sponsor`);
  await expect(page).toHaveURL(`${DOCS}/operate`);
  await expect(page.locator("h1").first()).toHaveText("Run Mavna");
});

test("an unknown docs address answers 404 with the not-found page", async ({ page }) => {
  const response = await page.goto(`${DOCS}/no-such-page`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText("No page at this address")).toBeVisible();
});
