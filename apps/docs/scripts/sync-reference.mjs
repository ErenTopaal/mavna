/**
 * The reference section, taken from the source rather than typed out beside it.
 *
 * Documentation that restates an API by hand is wrong the first time somebody
 * changes the API and does not read the docs. Everything this writes is lifted
 * verbatim from the packages: the export lists come from each `src/index.ts`,
 * the type definitions are the exact lines from the files that declare them, the
 * widget's theme tokens are read out of its stylesheet, and the runnable
 * examples are the real files beside this script.
 *
 * Nothing here is checked in. It runs before `next build` and before `next
 * dev`, so a page can only ever show what the source currently says.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const out = join(here, "..", "generated");

/** Every package the reference covers, in the order the sidebar lists them. */
const PACKAGES = [
  { name: "@mavna/core", dir: "packages/core" },
  { name: "@mavna/routing", dir: "packages/routing" },
  { name: "@mavna/stellar", dir: "packages/stellar" },
  { name: "@mavna/status", dir: "packages/status" },
  { name: "@mavna/swap", dir: "packages/swap" },
  { name: "@mavna/adapter-cctp", dir: "packages/adapters/cctp" },
  { name: "@mavna/adapter-axelar", dir: "packages/adapters/axelar" },
  { name: "@mavna/adapter-layerzero", dir: "packages/adapters/layerzero" },
  { name: "@mavna/widget", dir: "packages/widget" },
];

/**
 * Declarations copied out whole, by file.
 *
 * A reference that paraphrases a type is a second definition that drifts. These
 * are the real lines, comments included, because the comments are where the
 * reasoning lives and an integrator deciding how to use `TransferHandle` needs
 * the reasoning more than the shape.
 */
const EXCERPTS = [
  { slug: "adapter-interface", file: "packages/core/src/adapter.ts", names: ["BridgeAdapter"] },
  { slug: "adapter-request", file: "packages/core/src/adapter.ts", names: ["QuoteRequest"] },
  {
    slug: "adapter-transaction",
    file: "packages/core/src/adapter.ts",
    names: ["TransactionFormat", "UnsignedTransaction"],
  },
  {
    slug: "adapter-unnecessary",
    file: "packages/core/src/adapter.ts",
    names: ["AllowanceCheck", "UnnecessaryWhen"],
  },
  { slug: "adapter-handle", file: "packages/core/src/adapter.ts", names: ["TransferHandle"] },
  {
    slug: "money",
    file: "packages/core/src/money.ts",
    names: ["ChainRef", "Asset", "Amount", "FeeRecipient", "FeeKind", "Fee"],
  },
  {
    slug: "route",
    file: "packages/core/src/route.ts",
    names: [
      "TrustModel",
      "StepQuote",
      "StepExecution",
      "Step",
      "Route",
      "RouteRejection",
      "RouteSet",
      "RouteRanking",
    ],
  },
  {
    slug: "execution",
    file: "packages/core/src/execution.ts",
    names: ["Blocked", "Remedy", "OnChainRef", "StepPhase"],
  },
  {
    slug: "widget-config",
    file: "packages/widget/src/config.ts",
    names: [
      "Variant",
      "Appearance",
      "HiddenUIElement",
      "RequiredUIElement",
      "MavnaWidgetEvent",
      "WalletConfig",
      "WidgetTheme",
      "MavnaWidgetConfig",
    ],
  },
  {
    slug: "widget-component",
    file: "packages/widget/src/MavnaWidget.tsx",
    names: ["MavnaWidgetProps", "MavnaWidgetRef"],
  },
];

/** Runnable examples, embedded as the real file rather than a copy that drifts. */
const EXAMPLES = [
  { slug: "example-quote", file: "apps/docs/examples/quote.ts", lang: "ts" },
  { slug: "example-panel", file: "apps/docs/examples/Panel.tsx", lang: "tsx" },
];

// Cleared rather than overwritten. A file left behind from an older excerpt list
// is a page of documentation for a type nobody removed from the docs.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let exported = 0;
for (const pkg of PACKAGES) {
  const index = readFileSync(join(repo, pkg.dir, "src", "index.ts"), "utf8");
  const rows = exportsOf(index);
  exported += rows.length;
  writeFileSync(
    join(out, `exports-${slugOf(pkg.name)}.mdx`),
    [
      generatedNotice(`${pkg.dir}/src/index.ts`),
      "",
      "| Export | Kind | Declared in |",
      "| --- | --- | --- |",
      ...rows.map((row) => `| \`${row.name}\` | ${row.kind} | \`${row.module}\` |`),
      "",
    ].join("\n"),
  );
}

for (const excerpt of EXCERPTS) {
  const source = readFileSync(join(repo, excerpt.file), "utf8");
  const blocks = excerpt.names.map((name) => declarationOf(source, name, excerpt.file));
  writeFileSync(
    join(out, `source-${excerpt.slug}.mdx`),
    [generatedNotice(excerpt.file), "", "```ts", blocks.join("\n\n"), "```", ""].join("\n"),
  );
}

for (const example of EXAMPLES) {
  const source = readFileSync(join(repo, example.file), "utf8").trimEnd();
  writeFileSync(
    join(out, `${example.slug}.mdx`),
    [
      generatedNotice(example.file),
      "",
      `\`\`\`${example.lang} filename="${example.file}"`,
      source,
      "```",
      "",
    ].join("\n"),
  );
}

writeFileSync(join(out, "widget-tokens.mdx"), tokenTable());

console.log(
  `reference: ${exported} exports across ${PACKAGES.length} packages, ` +
    `${EXCERPTS.length} source excerpts, ${EXAMPLES.length} examples, ` +
    `tokens read from widget.css`,
);

/** Every name an index re-exports, with whether it is a type or a value. */
function exportsOf(source) {
  const rows = [];
  const pattern = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const typeOnly = match[1] !== undefined;
    const module = match[3].replace(/\.js$/, ".ts");
    for (const raw of match[2].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name === "") continue;
      rows.push({
        name,
        kind: typeOnly || raw.trim().startsWith("type ") ? "type" : "value",
        module,
      });
    }
  }

  // Declarations that live in the index itself rather than being re-exported.
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(class|function|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    rows.push({
      name: match[2],
      kind: match[1] === "interface" || match[1] === "type" ? "type" : "value",
      module: "index.ts",
    });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pull one declaration out whole, with the comment above it.
 *
 * Brace counting rather than a parser: these are declarations in files this repo
 * controls and formats, and a dependency on a TypeScript AST for seven types
 * would be a party added to the build for no coverage it does not already have.
 */
function declarationOf(source, name, file) {
  const lines = source.split("\n");
  const opener = new RegExp(`^export (interface|type|const|class|function) ${name}\\b`);
  const start = lines.findIndex((line) => opener.test(line));
  if (start === -1) {
    throw new Error(
      `${file} no longer declares ${name}. The reference names a type the source does not have.`,
    );
  }

  // A union alias ends at its semicolon, and its members are objects whose
  // closing brace would otherwise look like the end of the declaration. An
  // interface ends at the brace. Getting this wrong silently truncates a type,
  // which is worse than failing, so the two cases are separated.
  const closesOnSemicolon = /^export (type|const)\b/.test(lines[start]);

  let head = start;
  while (head > 0) {
    const above = lines[head - 1].trim();
    if (above.startsWith("*") || above.startsWith("/*") || above.startsWith("//")) head -= 1;
    else break;
  }

  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    for (const character of lines[i]) {
      if (character === "{" || character === "(") depth += 1;
      if (character === "}" || character === ")") depth -= 1;
    }
    const line = lines[i].trimEnd();
    const closed = closesOnSemicolon ? line.endsWith(";") : line.endsWith("}");
    if (depth <= 0 && closed) {
      end = i;
      break;
    }
  }

  return lines.slice(head, end + 1).join("\n");
}

/**
 * The widget's theme tokens, read out of the stylesheet that defines them.
 *
 * The list is the contract an integrator restyles against, so it has to be the
 * real one. Values are shown as declared, which is why the colours read as oklch.
 */
function tokenTable() {
  const css = readFileSync(join(repo, "packages/widget/src/widget.css"), "utf8");

  const root = block(css, ".mv-root {");
  const dark = block(css, '.mv-root[data-mv-theme="dark"] {');
  const darkValues = new Map(declarations(dark).map((token) => [token.name, token.value]));

  const rows = declarations(root)
    // Not a token anyone sets. It exists so the widget can tell in development
    // that its stylesheet never loaded.
    .filter((token) => token.name !== "--mv-loaded")
    .map((token) => {
      const overridden = darkValues.get(token.name);
      return `| \`${token.name}\` | \`${token.value}\` | ${
        overridden === undefined ? "same" : `\`${overridden}\``
      } |`;
    });

  return [
    generatedNotice("packages/widget/src/widget.css"),
    "",
    "| Token | Light | Dark |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function block(css, opener) {
  const start = css.indexOf(opener);
  if (start === -1) throw new Error(`widget.css no longer contains ${opener}`);
  const end = css.indexOf("\n}", start);
  return css.slice(start + opener.length, end);
}

/** Custom property declarations, with values that may run over several lines. */
function declarations(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = [];
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    tokens.push({ name: match[1], value: match[2].replace(/\s+/g, " ").trim() });
  }
  return tokens;
}

/** MDX has no HTML comments, so the notice is a JSX comment. */
function generatedNotice(from) {
  return `{/* Generated by scripts/sync-reference.mjs from ${from}. Do not edit. */}`;
}

function slugOf(name) {
  return name.replace("@mavna/", "");
}
