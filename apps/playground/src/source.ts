import type { MavnaWidgetConfig } from "@mavna/widget";

/**
 * Print the config as the JSX an integrator would paste. The event hook goes
 * inside config, where MavnaWidget reads it, as a stand-in that logs.
 */
export function buildSource(config: MavnaWidgetConfig): string {
  // the sponsor is this page's own; an integrator points the widget at theirs
  const { onEvent: _onEvent, sponsorUrl: _sponsorUrl, ...rest } = config;
  const props = JSON.stringify(rest, null, 2).split("\n").slice(1, -1);
  const body = ["{", ...props.map((line, i) => (i === props.length - 1 ? `${line},` : line))]
    .concat(["  onEvent: (e) => console.log(e),", "}"])
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
  return `import { MavnaWidget } from "@mavna/widget";\nimport "@mavna/widget/widget.css";\n\n<MavnaWidget\n  config={${body}}\n/>`;
}
