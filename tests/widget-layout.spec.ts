import { expect, type Page, test } from "@playwright/test";
import { PORTS } from "./env.js";

// layout regressions that only show in a real browser, found by looking at the widget

async function offline(page: Page, base: string | undefined): Promise<void> {
  const origin = new URL(base ?? "http://localhost:4319").origin;
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
}

test("the routes panel keeps its size after a quick trip away from the form", async ({
  page,
  baseURL,
}) => {
  await offline(page, baseURL);
  await page.goto("/");
  const root = page.locator(".mv-root");
  const panel = root.getByRole("heading", { name: "Receive" }).locator("..").locator("..");
  await expect(panel).toBeVisible();
  // past the entrance, which slides everything up into place
  await page.waitForTimeout(1500);
  const before = await panel.boundingBox();

  // back before the panel has finished leaving, so it is put back rather than remounted
  await root.getByRole("button", { name: "Settings" }).click();
  await root.getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(1500);

  const after = await panel.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
  expect(after?.y).toBe(before?.y);
});

for (const width of [360, 390]) {
  test(`the app header does not lay its controls over the wordmark at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await offline(page, baseURL);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const root = page.locator(".mv-root");
    await expect(root.getByText("Send to Stellar")).toBeVisible();
    await page.waitForTimeout(1200);
    const mark = await root.getByRole("button", { name: "Mavna home" }).boundingBox();
    const toggle = await root.getByRole("button", { name: "TESTNET" }).boundingBox();
    if (mark === null || toggle === null) throw new Error("header not laid out");
    const overlaps =
      mark.x < toggle.x + toggle.width &&
      toggle.x < mark.x + mark.width &&
      mark.y < toggle.y + toggle.height &&
      toggle.y < mark.y + mark.height;
    expect(overlaps).toBe(false);
    // and the wordmark is not squeezed narrower than it is
    const word = root.getByText("MAVNA", { exact: true });
    expect(
      await word.evaluate((el) => el.scrollWidth <= (el.parentElement?.clientWidth ?? 0)),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test("Escape in the drawer closes what is open inside it before the drawer itself", async ({
  page,
}) => {
  await offline(page, `http://localhost:${PORTS.playground}/`);
  await page.goto(`http://localhost:${PORTS.playground}/`);
  await page.getByRole("button", { name: "Drawer", exact: true }).click();
  await page.getByRole("button", { name: "Bring funds to Stellar" }).click();
  const dialog = page.getByRole("dialog", { name: "Bring funds to Stellar" });
  await expect(dialog).toBeVisible();

  // the wallet menu closes, the drawer stays
  const wallet = dialog.getByRole("button", { name: /Connect/ }).first();
  await wallet.click();
  await expect(dialog.getByText("Source wallet")).toBeVisible();
  await wallet.focus();
  await page.keyboard.press("Escape");
  await expect(dialog.getByText("Source wallet")).toBeHidden();
  await page.waitForTimeout(600);
  await expect(dialog).toBeVisible();

  // a screen inside goes back, the drawer stays
  await dialog.getByRole("button", { name: "Settings" }).click();
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  // the button that opened it is gone with the form, so focus moves to the new screen
  await expect(dialog.getByRole("button", { name: "Back" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("heading", { name: "Send to Stellar" })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(dialog).toBeVisible();

  // with nothing left to close, Escape closes the drawer
  await dialog.getByRole("button", { name: "Settings" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
