export default {
  index: { type: "page", display: "hidden" },
  guides: { type: "page", title: "Guides" },
  developers: { type: "page", title: "Developers" },
  widget: { type: "page", title: "Widget" },
  // The other Mavna surfaces, as three consistent external links so the docs are
  // not a dead end. Nextra adds the external-link arrow itself, so the titles
  // carry none of their own.
  home: { type: "page", title: "Home", href: "https://web.mavna.app" },
  app: { type: "page", title: "App", href: "https://mavna.app" },
  playground: { type: "page", title: "Playground", href: "https://playground.mavna.app" },
};
