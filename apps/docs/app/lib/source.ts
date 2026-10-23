import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { iconsPlugin } from "./icons";

export const docs = defineDocs({
  dir: "content",
  docs: {
    async: true,
    // mdx options, the highlighting languages among them, are set in vite.config.ts
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
  plugins: [iconsPlugin()],
});
