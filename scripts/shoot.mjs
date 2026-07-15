/**
 * Screenshot a running page, for looking at the design rather than asserting on it.
 *
 * Separate from the Playwright suite on purpose: the suite asserts, this one is
 * for judgement. A design rule like "two states that mean different things must
 * not look the same" cannot be checked by any assertion I can write, only by
 * looking at the two of them side by side.
 */
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://localhost:4319/";
const out = process.argv[3] ?? "shot.png";
const width = Number(process.argv[4] ?? 1500);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height: 1200 },
  deviceScaleFactor: 2,
});
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

// A fifth argument clips to one element, for looking closely at a single card
// rather than squinting at a wall of them.
const selector = process.argv[5];
if (selector === undefined) {
  await page.screenshot({ path: out, fullPage: true });
} else {
  const target = page.locator(selector).first();
  await target.waitFor();
  await target.screenshot({ path: out });
}
await browser.close();
console.log(`  wrote ${out}`);
