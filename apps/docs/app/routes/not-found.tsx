import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { Link } from "react-router";
import { baseOptions } from "@/lib/layout.shared";

export function NotFound(): ReactElement {
  return (
    <HomeLayout {...baseOptions()}>
      <title>Page not found | Mavna docs</title>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">No page at this address</h1>
        <Link className="underline underline-offset-4" to="/">
          Go to the docs home
        </Link>
      </main>
    </HomeLayout>
  );
}
