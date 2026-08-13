import type { Metadata } from "next";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { Layout, Navbar, ThemeSwitch } from "nextra-theme-docs";
import type { ReactElement, ReactNode } from "react";
import "nextra-theme-docs/style.css";
// The consumer app's typeface, self-hosted, so the docs read as the same product.
import "@fontsource-variable/figtree";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.mavna.app"),
  title: { default: "Mavna", template: "%s | Mavna" },
  description:
    "Move USDC into Stellar from other chains. An SDK that builds transactions " +
    "and never signs them, and a widget that renders the whole transfer.",
};

/*
 * The mark is a draft scale: the graduated waterline marks read off a hull to
 * tell how deep it sits. The product's own progress component is called the
 * draft scale for the same reason, so the mark is the product, not a boat.
 */
const mark = (
  <svg className="mv-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="2" y="3" width="7" height="1.7" rx="0.85" fill="currentColor" />
    <rect x="2" y="8.15" width="12" height="1.7" rx="0.85" fill="currentColor" />
    <rect x="2" y="13.3" width="9" height="1.7" rx="0.85" fill="currentColor" />
  </svg>
);

const navbar = (
  <Navbar
    logo={
      <span className="mv-logo">
        {mark}
        <span className="mv-wordmark">Mavna</span>
      </span>
    }
  >
    <ThemeSwitch lite className="mv-theme-switch" />
  </Navbar>
);

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      {/*
        The accent is the ink itself: hue and saturation zero, only lightness
        separates the themes. The product owns the one chromatic value on any of
        its surfaces (its error signal), so the docs stay achromatic and show
        interaction with weight and underline. Matches --mv-accent in globals.css.
      */}
      <Head
        color={{ hue: 0, saturation: 0, lightness: { light: 22, dark: 90 } }}
        backgroundColor={{ light: "#fbfbfb", dark: "#0d0d0d" }}
      />
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          // No footer: the site is a reference, and a repeated licence line at the
          // bottom of every page is chrome that earns nothing.
          footer={null}
          sidebar={{ defaultMenuCollapseLevel: 1, autoCollapse: true, toggleButton: true }}
          // No edit link and no feedback link: the GitHub organisation does not
          // exist yet, and a link nobody can open is worse than no link.
          editLink={null}
          feedback={{ content: null }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
