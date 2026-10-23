import type { LoaderPlugin } from "fumadocs-core/source";
import { BookOpen, Code, LayoutTemplate, Send, Server } from "lucide-react";
import { createElement, type ElementType } from "react";

// only the icons the docs name, so the bundle carries these and not the whole set
const ICONS: Record<string, ElementType> = {
  BookOpen,
  Code,
  LayoutTemplate,
  Send,
  Server,
};

type Node = { icon?: unknown };

/** Turns an `icon` name in a meta.json or page frontmatter into its Lucide icon. */
export function iconsPlugin(): LoaderPlugin {
  const replace = <T extends Node>(node: T): T => {
    if (typeof node.icon === "string") {
      const icon = ICONS[node.icon];
      if (icon === undefined)
        throw new Error(`The docs name an icon they do not load: ${node.icon}`);
      node.icon = createElement(icon);
    }
    return node;
  };
  return {
    name: "mavna:icons",
    transformPageTree: { file: replace, folder: replace, separator: replace },
  };
}
