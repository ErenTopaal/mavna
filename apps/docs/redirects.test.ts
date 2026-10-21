import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REDIRECTS } from "./app/lib/redirects";

const content = fileURLToPath(new URL("content", import.meta.url));

// every page the previous docs site had, so none of their addresses goes dark
const PREVIOUS = [
  "/developers",
  "/developers/concepts",
  "/developers/concepts/delivery",
  "/developers/concepts/model",
  "/developers/concepts/routes",
  "/developers/concepts/signing",
  "/developers/concepts/sponsorship",
  "/developers/concepts/status",
  "/developers/concepts/swap",
  "/developers/concepts/trust",
  "/developers/deploy",
  "/developers/install",
  "/developers/quickstart",
  "/developers/rails",
  "/developers/rails/axelar",
  "/developers/rails/cctp",
  "/developers/rails/layerzero",
  "/developers/rails/near-intents",
  "/developers/reference",
  "/developers/reference/bridge-adapter",
  "/developers/reference/core-types",
  "/developers/reference/packages",
  "/developers/security",
  "/developers/security/model",
  "/developers/security/reporting",
  "/developers/sponsor",
  "/developers/sponsor/api",
  "/guides",
  "/guides/costs",
  "/guides/finish",
  "/guides/new-account",
  "/guides/receive-xlm",
  "/guides/send",
  "/guides/send-usdt0",
  "/guides/track",
  "/guides/wallets",
  "/widget",
  "/widget/configuration",
  "/widget/playground",
  "/widget/quickstart",
  "/widget/theming",
  "/widget/variants",
];

/** Every page's address, from the content files, the way the site names them. */
function pages(dir: string): Set<string> {
  return new Set(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => {
        const path = `/${file.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "")}`;
        return path === "/" ? "/" : path.replace(/\/$/, "");
      }),
  );
}

describe("old addresses", () => {
  const now = pages(content);

  it("each lead to a page that exists", () => {
    for (const [from, to] of Object.entries(REDIRECTS)) {
      expect(now.has(to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("never shadow a page", () => {
    for (const from of Object.keys(REDIRECTS)) expect(now.has(from), from).toBe(false);
  });

  it("cover every page the previous docs had", () => {
    for (const path of PREVIOUS) {
      expect(now.has(path) || path in REDIRECTS, path).toBe(true);
    }
  });
});
