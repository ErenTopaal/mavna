import { expect, test } from "@playwright/test";

test("picking USDT0 narrows the chains to LayerZero's and offers it, USDC or XLM on arrival", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://localhost:4319").origin;
  // Nothing leaves the preview server, so the quote race has no network to find.
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );

  await page.goto("/");
  const root = page.locator(".mv-root");
  await expect(root.getByText("Send to Stellar")).toBeVisible();

  const usdt0 = root.getByRole("button", { name: "USDT0", exact: true });
  await expect(usdt0).toHaveAttribute("aria-pressed", "false");
  const receive = (asset: string) =>
    root.getByRole("button", { name: `Receive ${asset}`, exact: true });
  // the receive side offers USDC or XLM while USDC is being sent
  await expect(receive("XLM")).toBeVisible();
  await expect(receive("USDT0")).toBeHidden();

  await usdt0.click();
  await expect(usdt0).toHaveAttribute("aria-pressed", "true");
  // USDT0 arrives as itself unless a conversion into USDC or XLM is picked
  await expect(receive("USDT0")).toHaveAttribute("aria-pressed", "true");
  await expect(receive("USDC")).toHaveAttribute("aria-pressed", "false");
  await expect(receive("XLM")).toBeVisible();
  await receive("XLM").click();
  await expect(receive("XLM")).toHaveAttribute("aria-pressed", "true");

  // Ethereum Sepolia carries the Stellar pathway, so the chain stays put
  await root.getByRole("button", { name: /Ethereum Sepolia/ }).click();
  await expect(root.getByRole("textbox", { name: "Search chains" })).toBeVisible();
  await expect(root.getByRole("button", { name: /Arbitrum Sepolia/ })).toBeVisible();
  await expect(root.getByRole("button", { name: /BNB Smart Chain Testnet/ })).toBeVisible();
  // a Circle chain LayerZero does not send from is not offered for USDT0
  await expect(root.getByRole("button", { name: /Base Sepolia Testnet/ })).toBeHidden();
});
