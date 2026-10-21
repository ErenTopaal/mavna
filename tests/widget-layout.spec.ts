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
  // the panel's resting place: beside the card, top aligned, at its own size
  const card = root.getByRole("heading", { name: "Send to Stellar" }).locator("..").locator("..");
  const place = async () => {
    const [p, c] = [await panel.boundingBox(), await card.boundingBox()];
    return p === null || c === null
      ? null
      : {
          width: p.width,
          height: p.height,
          top: Math.round(p.y - c.y),
          beside: p.x > c.x + c.width,
        };
  };
  const resting = { width: 380, height: 624, top: 0, beside: true };
  await expect.poll(place).toEqual(resting);

  // back before the panel has finished leaving, so it is put back rather than remounted
  await root.getByRole("button", { name: "Settings" }).click();
  await root.getByRole("button", { name: "Back" }).click();
  await expect.poll(place).toEqual(resting);
  // and it stays there once every animation has run out
  await page.waitForTimeout(1000);
  expect(await place()).toEqual(resting);
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

test("the playground header keeps every link on screen on a phone", async ({ page }) => {
  const url = `http://localhost:${PORTS.playground}/`;
  await offline(page, url);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(url);
  const header = page.locator(".pg-header");
  await expect(header).toBeVisible();
  for (const name of ["Home", "App", "Docs", "GitHub ↗"]) {
    const box = await header.getByRole("link", { name }).boundingBox();
    if (box === null) throw new Error(`${name} is not laid out`);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
});

test("the playground's controls stay usable once the rail stacks above the stage", async ({
  page,
}) => {
  const url = `http://localhost:${PORTS.playground}/`;
  await offline(page, url);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(url);
  const rail = page.locator(".pg-rail");
  await expect(rail).toBeVisible();
  // the whole rail is laid out, not squeezed into a strip that scrolls on its own
  const { height, content } = await rail.evaluate((el) => ({
    height: el.clientHeight,
    content: el.scrollHeight,
  }));
  expect(height).toBe(content);
  await page.getByRole("button", { name: "Drawer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Bring funds to Stellar" })).toBeVisible();
});

test("the amount and recipient fields show where keyboard focus is", async ({ page, baseURL }) => {
  await offline(page, baseURL);
  await page.goto("/");
  const root = page.locator(".mv-root");
  const ring = (name: string) =>
    root.getByRole("textbox", { name }).evaluate((el) => getComputedStyle(el).outlineStyle);
  const amount = root.getByRole("textbox", { name: "Amount to send" });
  await root.getByRole("button", { name: /Ethereum Sepolia/ }).focus();
  await page.keyboard.press("Tab");
  await expect(amount).toBeFocused();
  expect(await ring("Amount to send")).not.toBe("none");

  await root.getByRole("button", { name: /Recipient/ }).focus();
  await page.keyboard.press("Enter");
  // focus moved to the new screen's back button; the field is next
  await page.keyboard.press("Tab");
  await expect(root.getByRole("textbox", { name: "Stellar address" })).toBeFocused();
  expect(await ring("Stellar address")).not.toBe("none");
});

test("Escape from inside a header popover hands focus back to its button", async ({
  page,
  baseURL,
}) => {
  await offline(page, baseURL);
  await page.goto("/");
  const root = page.locator(".mv-root");
  const wallet = root.getByRole("button", { name: /Connect$/ }).first();
  await wallet.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(root.getByRole("button", { name: /Stellar$/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(root.getByText("Source wallet")).toBeHidden();
  await expect(wallet).toBeFocused();

  const more = root.getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(root.getByRole("link", { name: "Home" })).toBeFocused();
  // a list of links, not an application menu that would promise arrow keys
  await expect(root.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(root.getByRole("link", { name: "Home" })).toBeHidden();
  await expect(more).toBeFocused();
});

test("Tab in the drawer never stops on the invisible backdrop", async ({ page }) => {
  const url = `http://localhost:${PORTS.playground}/`;
  await offline(page, url);
  await page.goto(url);
  await page.getByRole("button", { name: "Drawer", exact: true }).click();
  await page.getByRole("button", { name: "Bring funds to Stellar" }).click();
  const dialog = page.getByRole("dialog", { name: "Bring funds to Stellar" });
  await expect(dialog).toBeVisible();
  const scrim = page.locator(".mv-overlay-scrim");
  // round the whole trap twice, forwards and back
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(key);
      await expect(scrim).not.toBeFocused();
    }
  }
  await page.keyboard.press("Tab");
  await expect(page.locator(".mv-overlay").locator(":focus")).toHaveCount(1);
});

test("hover and focus styles show over the inline styles they are written against", async ({
  page,
  baseURL,
}) => {
  await offline(page, baseURL);
  await page.goto("/");
  const root = page.locator(".mv-root");
  const row = root.getByRole("button", { name: /Route priority/ });
  const background = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(row).toBeVisible();
  const rest = await background();
  await row.hover();
  await expect.poll(background).not.toBe(rest);

  await root.getByRole("button", { name: "Activity" }).click();
  const lookup = root.getByRole("textbox", { name: "Transaction or address" });
  const border = () => lookup.evaluate((el) => getComputedStyle(el).borderTopColor);
  const blurred = await border();
  await lookup.focus();
  await expect.poll(border).not.toBe(blurred);
});

test("a focus ring on a full-width row is not clipped by the scrolling body", async ({
  page,
  baseURL,
}) => {
  await offline(page, baseURL);
  await page.goto("/");
  const root = page.locator(".mv-root");
  const row = root.getByRole("button", { name: /Recipient/ });
  await expect(row).toBeVisible();
  // the ring is 2px wide and sits 2px off the element; the clipping box must leave room for it
  const room = await row.evaluate((el) => {
    let clip: Element | null = el.parentElement;
    while (clip !== null && getComputedStyle(clip).overflowX === "visible")
      clip = clip.parentElement;
    if (clip === null) return Number.POSITIVE_INFINITY;
    const a = el.getBoundingClientRect();
    const b = clip.getBoundingClientRect();
    return Math.min(a.left - b.left, b.right - a.right);
  });
  expect(room).toBeGreaterThanOrEqual(4);
});
