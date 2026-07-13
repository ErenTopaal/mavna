import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { generator: "oxc", sourcemap: true },
  sourcemap: true,
  // One importable stylesheet, compiled and scoped. An integrator installs the
  // widget and gets working styles with no build-tool adoption on their side.
  css: { fileName: "widget.css", minify: true },
  // React is the host's. We never bundle it.
  deps: { neverBundle: ["react", "react/jsx-runtime"] },
});
