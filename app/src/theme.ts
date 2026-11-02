// Appearance: light/dark mode plus a color palette. A cosmetic, per-device
// preference, so localStorage is enough.

import { useEffect, useState } from "react";

export type Mode = "system" | "light" | "dark";

export interface Palette {
  id: string;
  name: string;
  /** Swatch colors for the picker: accent, neutral. */
  swatch: [string, string];
}

// Each palette remaps Tailwind's indigo (accent) and zinc (neutral) scales; see index.css.
export const PALETTES: Palette[] = [
  { id: "indigo", name: "Indigo", swatch: ["#6366f1", "#71717a"] },
  { id: "ocean", name: "Ocean", swatch: ["#0ea5e9", "#64748b"] },
  { id: "forest", name: "Forest", swatch: ["#10b981", "#78716c"] },
  { id: "sunset", name: "Sunset", swatch: ["#f97316", "#78716c"] },
  { id: "rose", name: "Rose", swatch: ["#f43f5e", "#71717a"] },
  { id: "grape", name: "Grape", swatch: ["#8b5cf6", "#737373"] },
];

interface Appearance {
  mode: Mode;
  palette: string;
}

function read(): Appearance {
  try {
    const m = localStorage.getItem("theme");
    const p = localStorage.getItem("palette");
    return {
      mode: m === "light" || m === "dark" ? m : "system",
      palette: PALETTES.some((x) => x.id === p) ? p! : "indigo",
    };
  } catch {
    return { mode: "system", palette: "indigo" };
  }
}

export function applyTheme(a: Appearance = read()) {
  const dark = a.mode === "dark" || (a.mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.palette = a.palette;
}

export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const [appearance, setAppearance] = useState<Appearance>(read);
  useEffect(() => {
    applyTheme(appearance);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(appearance);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance]);
  return [
    appearance,
    (patch) => {
      const next = { ...appearance, ...patch };
      try {
        localStorage.setItem("theme", next.mode);
        localStorage.setItem("palette", next.palette);
      } catch {
        /* storage unavailable */
      }
      setAppearance(next);
    },
  ];
}
