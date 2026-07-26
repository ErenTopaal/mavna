import { useEffect, useState } from "react";

/**
 * Which theme the app is in, so it can tell the widget rather than let it guess.
 *
 * The widget follows the operating system when nobody tells it otherwise, which
 * is right for a guest in someone else's page. Inside our own app it is not a
 * guest, and two components deciding independently is how a light page ended up
 * with a dark panel in the middle of it on any machine set to dark. They now come
 * from the same answer.
 *
 * The class is put on `<html>` by a blocking script in `index.html` before the
 * first paint, so this only has to read it back and keep up if the machine's
 * preference changes while the page is open.
 */
export type Theme = "light" | "dark";

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.classList.toggle("dark", query.matches);
      setTheme(query.matches ? "dark" : "light");
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return theme;
}
