import { RootProvider } from "fumadocs-ui/provider/react-router";
import type { ReactElement, ReactNode } from "react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
// the app's two faces, self-hosted, so the docs read as the same product
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/azeret-mono/400.css";
import "./app.css";
import DocsSearchDialog from "@/components/search";
import type { Route } from "./+types/root";
import { NotFound } from "./routes/not-found";

export function Layout({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog: DocsSearchDialog }}>{children}</RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App(): ReactElement {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps): ReactElement {
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  // anything else is a defect in the site: say what it was rather than hide it
  const detail =
    error instanceof Error ? error.message : isRouteErrorResponse(error) ? error.statusText : String(error);
  return (
    <main className="mx-auto flex max-w-2xl flex-1 flex-col gap-3 p-8">
      <h1 className="text-2xl font-semibold">This page failed to load</h1>
      <pre className="overflow-x-auto whitespace-pre-wrap text-sm">{detail}</pre>
    </main>
  );
}
