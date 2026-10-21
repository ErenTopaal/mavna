import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { type ReactElement, use } from "react";
import { redirect } from "react-router";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { REDIRECTS } from "@/lib/redirects";
import { docs, source } from "@/lib/source";
import type { Route } from "./+types/docs";

function slugsOf(splat: string | undefined): string[] {
  return (splat ?? "").split("/").filter((segment) => segment.length > 0);
}

/** An old address goes to its new page; anything else unknown is a 404. */
function refuseUnknown(slugs: string[]): void {
  if (source.getPage(slugs) !== undefined) return;
  const moved = REDIRECTS[`/${slugs.join("/")}`];
  if (moved !== undefined) throw redirect(moved, 301);
  throw new Response("Not found", { status: 404 });
}

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = slugsOf(params["*"]);
  refuseUnknown(slugs);
  const page = source.getPage(slugs);
  if (page === undefined) throw new Response("Not found", { status: 404 });
  return {
    path: page.path,
    pageTree: await source.serializePageTree(source.getPageTree()),
  };
}

// runs in the browser for addresses that were not prerendered, which only an
// unknown one is: it answers 404 there rather than fetching data that does not exist
export async function clientLoader({ params, serverLoader }: Route.ClientLoaderArgs) {
  refuseUnknown(slugsOf(params["*"]));
  return serverLoader();
}

function Content({ path }: { readonly path: string }): ReactElement {
  const page = docs.getPage(path);
  if (page === undefined) throw new Error(`unknown page: ${path}`);
  const { toc } = use(page.load());
  const Mdx = page.body;
  return (
    <DocsPage toc={toc}>
      <title>{`${page.title} | Mavna docs`}</title>
      <meta name="description" content={page.description} />
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <Mdx components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export default function Page({ loaderData }: Route.ComponentProps): ReactElement {
  const { path, pageTree } = useFumadocsLoader(loaderData);
  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Content path={path} />
    </DocsLayout>
  );
}
