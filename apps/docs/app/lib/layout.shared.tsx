import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Mark } from "@/components/mark";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Mark />
          Mavna
        </span>
      ),
    },
    githubUrl: "https://github.com/ErenTopaal/mavna",
    themeSwitch: { mode: "light-dark-system" },
  };
}
