import { expect, test } from "@playwright/test";

// 56 characters, G then base32: what the widget's address check accepts.
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

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
  const hint = root.getByText("A Stellar address is 56 characters and starts with G.");

  await address.fill("not-an-address");
  await expect(hint).toBeVisible();

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
