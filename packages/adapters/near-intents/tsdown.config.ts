import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Pinned explicitly: tsdown's dts plugin auto-selects a generator and routes
  // declaration emit onto an experimental path when TypeScript 7 is installed.
  dts: { generator: "oxc", sourcemap: true },
  sourcemap: true,
});
