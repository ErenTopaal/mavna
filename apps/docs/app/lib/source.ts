import { loader } from "fumadocs-core/source";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";

export const docs = defineDocs({
  dir: "content",
  docs: {
    async: true,
    // every language the pages use, loaded before any page is highlighted: left
    // to load on demand, two pages compiling at once could tokenise a block
    // differently in the prerender and in the browser bundle
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: { langs: ["css", "json", "sh", "ts", "tsx", "txt"] },
    }),
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
});
