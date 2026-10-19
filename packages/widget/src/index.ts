// The stylesheet is imported by MavnaWidget, which puts it in the build graph so
// tsdown extracts it to dist/widget.css. Integrators add one line,
// `import "@mavna/widget/widget.css"`, and get the scoped, themeable styles.
export type {
  Appearance,
  HiddenUIElement,
  MavnaWidgetConfig,
  MavnaWidgetEvent,
  RailName,
  RequiredUIElement,
  ResolvedConfig,
  SendAsset,
  Variant,
  WalletConfig,
  WidgetTheme,
} from "./config.js";
export type { EngineConfig } from "./engine.js";
export { MavnaWidget, type MavnaWidgetProps, type MavnaWidgetRef } from "./MavnaWidget.js";
