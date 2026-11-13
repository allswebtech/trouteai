"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/appConfig";

interface ThemeState {
  theme: string;
  colorTheme: string;
  customColor: string;
  setTheme: (theme: string) => void;
  setColorTheme: (colorTheme: string) => void;
  setCustomColorTheme: (color: string) => void;
  toggleTheme: () => void;
  initTheme: () => void;
}

const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,
      colorTheme: "trouteai",
      customColor: "#2563eb",

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      setColorTheme: (colorTheme) => {
        set({ colorTheme });
        applyColorTheme(colorTheme, get().customColor);
      },

      setCustomColorTheme: (color) => {
        const normalized = normalizeHexColor(color);
        set({ colorTheme: "custom", customColor: normalized });
        applyColorTheme("custom", normalized);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      initTheme: () => {
        const { theme, colorTheme, customColor } = get();
        applyTheme(theme);
        applyColorTheme(colorTheme, customColor);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

export const COLOR_THEMES: Record<string, string> = {
  trouteai: "#2563eb",
  coral: "#e54d5e",
  indigo: "#4f46e5",
  red: "#ef4444",
  green: "#16a34a",
  violet: "#7c3aed",
  orange: "#ea580c",
  cyan: "#0891b2",
};

// Apply light/dark theme to document
function applyTheme(theme: string) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const effectiveTheme = theme === "system" ? systemTheme : theme;

  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

function applyColorTheme(colorTheme: string, customColor: string) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  // Default theme: let globals.css supply the accent and its per-theme text shades.
  if (colorTheme !== "custom" && (colorTheme === "trouteai" || !COLOR_THEMES[colorTheme])) {
    root.style.removeProperty("--color-primary");
    root.style.removeProperty("--color-primary-hover");
    root.style.removeProperty("--color-primary-text");
    return;
  }
  const baseColor =
    colorTheme === "custom"
      ? normalizeHexColor(customColor)
      : COLOR_THEMES[colorTheme] || COLOR_THEMES.trouteai;
  const hoverColor = shadeHexColor(baseColor, -0.14);
  // Lighter shade for text in the main color on dark backgrounds (globals.css .dark rule).
  const textColor = shadeHexColor(baseColor, 0.38);

  root.style.setProperty("--color-primary", baseColor);
  root.style.setProperty("--color-primary-hover", hoverColor);
  root.style.setProperty("--color-primary-text", textColor);
}

function normalizeHexColor(color: string) {
  const value = (color || "").trim();
  const hex = value.startsWith("#") ? value : `#${value}`;
  const valid = /^#([0-9a-fA-F]{6})$/.test(hex);
  return valid ? hex.toLowerCase() : "#2563eb";
}

function shadeHexColor(hex: string, percent: number) {
  const normalized = normalizeHexColor(hex).slice(1);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);

  const shade = (channel: number) => {
    const target = percent < 0 ? 0 : 255;
    const amount = Math.round((target - channel) * Math.abs(percent));
    const next = percent < 0 ? channel - amount : channel + amount;
    return Math.max(0, Math.min(255, next));
  };

  const toHex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${toHex(shade(r))}${toHex(shade(g))}${toHex(shade(b))}`;
}

export default useThemeStore;
