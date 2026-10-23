import { expect, test } from "@playwright/test";

// an account, a muxed account on it, and a contract: each kind the address check accepts
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const MUXED_ADDRESS = "MBM4KX6TWI4GIY2RHT6LVRYCTW4VONGCNSCQVV7PEZVJOHPEI3IDIAAAAAAAAAAD5FW3K";
const CONTRACT_ADDRESS = "CD4WSUP2DK5Q7KJNZYFSJVUCBQQ6PLWW27LQP67UNO3CQMC4ITO6I5CS";

test("the app renders the widget and validates a recipient address", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost:4319").origin;
  // Nothing leaves the preview server, so the quote race has no network to find.
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );

  await page.goto("/");
  const root = page.locator(".mv-root");
  await expect(root).toBeVisible();
  await expect(root.getByText("Send to Stellar")).toBeVisible();

  // The source chain button shows the default chain; opening it lists the rest.
  await root.getByRole("button", { name: /Ethereum Sepolia/ }).click();
  await expect(root.getByRole("textbox", { name: "Search chains" })).toBeVisible();
  await expect(root.getByRole("button", { name: /Arbitrum Sepolia/ })).toBeVisible();
  await root.getByRole("button", { name: /Base Sepolia Testnet/ }).click();
  await expect(root.getByRole("button", { name: /Base Sepolia Testnet/ })).toBeVisible();

  await root.getByRole("button", { name: /Recipient/ }).click();
  const address = root.getByRole("textbox", { name: "Stellar address" });
  const hint = root.getByText(
    "A Stellar address starts with G or C and is 56 characters, or starts with M and is 69.",
  );

  await address.fill("not-an-address");
  await expect(hint).toBeVisible();

  for (const accepted of [MUXED_ADDRESS, CONTRACT_ADDRESS]) {
    await address.fill(accepted);
    await expect(hint).toBeHidden();
    await address.fill("not-an-address");
    await expect(hint).toBeVisible();
  }

  await address.fill(VALID_ADDRESS);
  await expect(hint).toBeHidden();

  await root.getByRole("button", { name: "Use this address" }).click();
  await expect(
    root.getByText(`${VALID_ADDRESS.slice(0, 5)}…${VALID_ADDRESS.slice(-4)}`),
  ).toBeVisible();
});

test("an amount with no recipient waits for one instead of showing every rail declined", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://localhost:4319").origin;
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );

  await page.goto("/");
  const root = page.locator(".mv-root");
  await root.getByRole("textbox", { name: "Amount to send" }).fill("5");
  await expect(root.getByText("Awaiting a recipient")).toBeVisible();
  await expect(root.getByText(/Set a recipient to compare\./)).toBeVisible();
  await expect(root.getByText("Declined")).toHaveCount(0);
});

test("the page is a flat ground, with no grain over it", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost:4319").origin;
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  await page.goto("/");
  const root = page.locator(".mv-root");
  await expect(root.getByText("Send to Stellar")).toBeVisible();
  await expect(root.locator(".mv-grain")).toHaveCount(0);
  // the widget leaves the ground to the page, which paints it flat
  const page_ = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const widget = await root
    .locator(":scope > div")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(widget).toBe("rgba(0, 0, 0, 0)");
  expect(page_).not.toBe("rgba(0, 0, 0, 0)");
});

// the app's own faces: Geist for words, Azeret Mono for figures and addresses
test("the app sets its words in Geist and its figures and addresses in Azeret Mono", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://localhost:4319").origin;
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  await page.goto("/");
  const root = page.locator(".mv-root");
  await expect(root.getByText("Send to Stellar")).toBeVisible();
  const face = (el: Element) => getComputedStyle(el).fontFamily;
  expect(await root.getByText("Send to Stellar").evaluate(face)).toMatch(/^"?Geist Variable"?,/);
  expect(await root.getByText("Route priority").evaluate(face)).toMatch(/^"?Geist Variable"?,/);
  const amount = root.getByRole("textbox", { name: "Amount to send" });
  expect(await amount.evaluate(face)).toMatch(/^"?Azeret Mono"?,/);
  // the faces are shipped with the app, not left to whatever the system has
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")),
  );
  expect(loaded).toContain("Geist Variable");
  expect(loaded).toContain("Azeret Mono");
  expect(loaded).not.toContain("Instrument Sans");
});
