import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { LiveWidget } from "./LiveWidget";
import { Paths } from "./Paths";

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return { ...defaultMdxComponents, LiveWidget, Paths, ...components };
}
