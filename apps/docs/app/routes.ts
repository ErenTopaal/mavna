import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/docs.tsx", { id: "home" }),
  route("api/search", "routes/search.ts"),
  route("*", "routes/docs.tsx"),
] satisfies RouteConfig;
