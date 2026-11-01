// Light/dark theme. A cosmetic, per-device preference, so localStorage is enough.

import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

function read(): Theme {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = read()) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  return [
    theme,
    (t) => {
      try {
        localStorage.setItem("theme", t);
      } catch {
        /* storage unavailable */
      }
      setTheme(t);
    },
  ];
}
