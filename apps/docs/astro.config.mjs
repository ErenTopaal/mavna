// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

/**
 * The documentation site.
 *
 * No edit links and no social links: the GitHub organisation does not exist yet,
 * and a link to a repository nobody can open is worse than no link. They go in
 * when there is something behind them.
 *
 * If you are here because `pnpm install` started refusing semver@6.3.1: the
 * `@vitejs/plugin-react` override in pnpm-workspace.yaml is what keeps that away.
 * @astrojs/react asks for plugin-react 5.x, which runs on Babel and pulls in a
 * semver release with weaker trust evidence than the versions before it. Version
 * 6 uses Vite's Oxc transform and has no Babel at all, and the app already ships
 * on it. Removing that override reintroduces the problem; do not do it to make an
 * install quieter.
 *
 * The one thing to know if the pin is ever revisited: plugin-react 6 dropped the
 * `babel` option, and @astrojs/react still forwards one. Nothing here passes it,
 * so it arrives undefined and is ignored. Pass a `babel` option to react() below
 * and this combination stops holding.
 */
export default defineConfig({
  site: "https://docs.mavna.app",
  integrations: [
    react(),
    starlight({
      title: "Mavna",
      description:
        "Move USDC into Stellar from twenty-six chains. An SDK that builds transactions and " +
        "never signs them, and a widget that renders the whole transfer.",
      customCss: ["./src/styles/docs.css"],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      // Every page here is written for this repository at a known commit. A date
      // stamp read from git says something about the file, not about whether the
      // API it documents has moved, and reads as freshness it cannot promise.
      lastUpdated: false,
      expressiveCode: {
        // The same two-value neutral treatment the rest of the site uses. The
        // default pair introduces a third and fourth background into a palette
        // that has two.
        themes: ["github-light", "github-dark"],
        styleOverrides: {
          borderRadius: "5.2px",
          borderColor: "var(--sl-color-hairline)",
          frames: {
            // Both themes mark the active file tab with an orange bar. This site
            // has one chromatic value and it means something has gone wrong, so
            // a second one used as decoration makes the first one quieter.
            editorActiveTabIndicatorTopColor: "var(--sl-color-gray-3)",
            editorActiveTabBorderColor: "var(--sl-color-hairline)",
            editorTabBarBorderBottomColor: "var(--sl-color-hairline)",
          },
        },
      },
      sidebar: [
        {
          label: "Start",
          items: [{ slug: "install" }, { slug: "quickstart/sdk" }, { slug: "quickstart/widget" }],
        },
        { label: "Playground", items: [{ slug: "playground" }] },
        {
          label: "Reference",
          items: [
            { slug: "reference/bridge-adapter" },
            { slug: "reference/types" },
            { slug: "reference/theming" },
            { slug: "reference/packages" },
          ],
        },
        { label: "Security", items: [{ slug: "security/reporting" }] },
      ],
    }),
  ],
});
