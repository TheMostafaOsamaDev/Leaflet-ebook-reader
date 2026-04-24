// Design tokens — themes, highlight palette, font stacks.
// Mirrors the prototype's `reader-core.jsx`, but typed.

export type ThemeKey = "light" | "sepia" | "dark" | "oled";

export interface Theme {
  bg: string;
  paper: string;
  ink: string;
  muted: string;
  rule: string;
  chrome: string;
  chromeInk: string;
  hover: string;
}

export const THEMES: Record<ThemeKey, Theme> = {
  sepia: {
    bg: "#f4ecd8",
    paper: "#f4ecd8",
    ink: "#3a2f1f",
    muted: "#8b7355",
    rule: "rgba(58,47,31,0.14)",
    chrome: "#ebe0c5",
    chromeInk: "#5a4a2e",
    hover: "rgba(58,47,31,0.06)",
  },
  light: {
    bg: "#faf8f3",
    paper: "#ffffff",
    ink: "#1f1a14",
    muted: "#8b7e6a",
    rule: "rgba(31,26,20,0.10)",
    chrome: "#f0ece2",
    chromeInk: "#3a332a",
    hover: "rgba(31,26,20,0.05)",
  },
  dark: {
    bg: "#1a1614",
    paper: "#1a1614",
    ink: "#d8cbb0",
    muted: "#887a60",
    rule: "rgba(216,203,176,0.14)",
    chrome: "#24201c",
    chromeInk: "#c4b89c",
    hover: "rgba(216,203,176,0.06)",
  },
  oled: {
    bg: "#000000",
    paper: "#000000",
    ink: "#b8ad94",
    muted: "#6a6148",
    rule: "rgba(184,173,148,0.10)",
    chrome: "#0c0a08",
    chromeInk: "#a89d84",
    hover: "rgba(184,173,148,0.05)",
  },
};

export type HighlightColor = "yellow" | "blue" | "pink" | "green";

export const HIGHLIGHT_COLORS: Record<
  HighlightColor,
  { light: string; dark: string; dot: string }
> = {
  yellow: {
    light: "rgba(232,197,78,0.32)",
    dark: "rgba(232,197,78,0.26)",
    dot: "#d4a84a",
  },
  blue: {
    light: "rgba(120,160,210,0.32)",
    dark: "rgba(120,160,210,0.28)",
    dot: "#6b8cb5",
  },
  pink: {
    light: "rgba(220,140,170,0.32)",
    dark: "rgba(220,140,170,0.28)",
    dot: "#c2708c",
  },
  green: {
    light: "rgba(140,180,130,0.32)",
    dark: "rgba(140,180,130,0.26)",
    dot: "#7ba570",
  },
};

export function hlBg(color: HighlightColor, themeKey: ThemeKey): string {
  const isDark = themeKey === "dark" || themeKey === "oled";
  return HIGHLIGHT_COLORS[color][isDark ? "dark" : "light"];
}

export type FontFamilyKey = "serif" | "sans" | "dyslexic";

export const FONT_STACKS: Record<FontFamilyKey, string> = {
  serif:
    '"Literata", "Iowan Old Style", "Source Serif Pro", Georgia, serif',
  sans: '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  dyslexic: '"Atkinson Hyperlegible", "Lexend", system-ui, sans-serif',
};

export const FONT_SERIF_DISPLAY = '"Fraunces", "Literata", Georgia, serif';
export const FONT_ARABIC =
  '"Amiri", "Noto Naskh Arabic", "Scheherazade New", serif';

export const ACCENT = "#c96442"; // warm copper amber, matches design
