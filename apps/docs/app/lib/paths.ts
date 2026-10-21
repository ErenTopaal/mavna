import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGetUrl, getSlugs } from "fumadocs-core/source";
import { REDIRECTS } from "./redirects";

const content = fileURLToPath(new URL("../../content", import.meta.url));
const urlOf = createGetUrl("/");

/** Every url the build writes a file for: each page, each old address, and the search index. */
export function prerenderPaths(): string[] {
  const pages = readdirSync(content, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => urlOf(getSlugs(file)));
  return [...pages, ...Object.keys(REDIRECTS), "/api/search"];
}
