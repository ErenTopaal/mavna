import { expect, type Page, test } from "@playwright/test";

/*
 * The app's shader backdrop alone, on the harness page the browser-test build
 * adds (apps/app/harness/backdrop.tsx). Headless Chromium needs WebGPU switched
 * on, and a backend that can present to a canvas: with the flag alone its
 * software adapter loses the device and never draws.
 */
const WEBGPU: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["--enable-unsafe-webgpu", "--use-angle=metal"],
};
test.use({ launchOptions: { args: WEBGPU[process.platform] ?? ["--enable-unsafe-webgpu"] } });

const HARNESS = "/harness/backdrop.html";

/** The canvas area of the page, as it is composited. */
async function canvasShot(page: Page): Promise<Buffer> {
  const box = await page.locator("canvas").boundingBox();
  if (box === null) throw new Error("the backdrop canvas has no box");
  return page.screenshot({ clip: box, animations: "allow" });
}

/** The same area with the canvas hidden: the page's flat ground alone. */
async function groundShot(page: Page): Promise<Buffer> {
  const canvas = page.locator("canvas");
  await canvas.evaluate((el) => {
    el.style.visibility = "hidden";
  });
  const shot = await canvasShot(page);
  await canvas.evaluate((el) => {
    el.style.visibility = "";
  });
  return shot;
}

/** Waits until the shader has drawn over the ground. */
async function drawn(page: Page): Promise<void> {
  const ground = await groundShot(page);
  await expect.poll(async () => (await canvasShot(page)).equals(ground)).toBe(false);
}

function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("the backdrop moves", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(HARNESS);
  await drawn(page);
  const first = await canvasShot(page);
  await expect.poll(async () => (await canvasShot(page)).equals(first)).toBe(false);
  expect(errors).toEqual([]);
});

test("under reduced motion it draws one frame and holds it, until the preference lifts", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(HARNESS);
  await drawn(page);
  const held = await canvasShot(page);
  await page.waitForTimeout(1000);
  expect((await canvasShot(page)).equals(held)).toBe(true);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await canvasShot(page)).equals(held)).toBe(false);
  expect(errors).toEqual([]);
});

test("without WebGPU the canvas stays clear over the flat ground, with nothing logged", async ({
  page,
}) => {
  const errors = errorsOf(page);
  // a browser with no WebGPU at all
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined });
  });
  const chunk = page.waitForResponse((r) => /\/assets\/js-[^/]+\.js$/.test(r.url()));
  await page.goto(HARNESS);
  await chunk;
  // once the library has loaded and given up, the canvas must stay clear
  const ground = await groundShot(page);
  for (let i = 0; i < 5; i++) {
    expect((await canvasShot(page)).equals(ground)).toBe(true);
    await page.waitForTimeout(200);
  }
  expect(errors).toEqual([]);
});
