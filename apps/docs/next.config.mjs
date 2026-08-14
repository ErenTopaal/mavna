// @ts-check
import nextra from "nextra";

/**
 * The documentation site, on Nextra's docs theme.
 *
 * Content lives in `content/` as MDX; the reference tables and source excerpts
 * under `generated/` are written by scripts/sync-reference.mjs from the packages
 * themselves before every build, so a page can only show what the source says.
 */
const withNextra = nextra({
  // Code blocks are indexed too: this reference is mostly identifiers, and a
  // search that cannot find `TransferHandle` because it sits in a fence would
  // miss the queries this site exists to answer.
  search: { codeblocks: true },
});

export default withNextra({
  reactStrictMode: true,
  // Do not write CLAUDE.md / AGENTS.md into this app on every dev run.
  agentRules: false,
});
