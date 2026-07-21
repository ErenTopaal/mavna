import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { WidgetStates } from "@/dev/WidgetStates";
import { Transfer } from "@/routes/Transfer";

/**
 * Routes defined in code rather than generated from the filesystem.
 *
 * The file-based generator wants a Vite plugin and a generated route tree checked
 * into the repository. For three routes that is a build step and a generated file
 * to keep in sync, in exchange for nothing.
 */
const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const transferRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Transfer,
});

/**
 * The widget's every state, on one page.
 *
 * Shipped rather than kept local: the design rules require every failure state to
 * be designed and reachable, and a gallery that only exists on one machine cannot
 * be reviewed by anyone else.
 */
const widgetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/widget",
  component: WidgetStates,
});

const routeTree = rootRoute.addChildren([transferRoute, widgetRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
