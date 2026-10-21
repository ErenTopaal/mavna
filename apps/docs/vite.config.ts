import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
import { sponsorRequired } from "./build-settings.ts";

export default defineConfig({
  plugins: [
    sponsorRequired(fileURLToPath(new URL(".", import.meta.url))),
    fumadocsMdx({
      globalOptions: {
        // every language the pages use (plain text needs none), loaded before any
        // page is highlighted: left to load on demand, two pages compiling at once
        // could tokenise a block differently in the prerender and the browser
        // bundle. set here rather than on the collection in app/lib/source.ts,
        // whose imports the dev server runs in the browser, where the mdx plugins
        // module fails on node:url and the page never becomes interactive
        mdxOptions: {
          rehypeCodeOptions: {
            ...rehypeCodeDefaultOptions,
            langs: ["css", "json", "sh", "ts", "tsx"],
          },
        },
      },
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: { tsconfigPaths: true },
});
