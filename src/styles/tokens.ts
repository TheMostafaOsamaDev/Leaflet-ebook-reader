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

export type FontFamilyKey =
  | "serif"
  | "sans"
  | "dyslexic"
  | "cairo"
  | "lateef"
  | "tajawal";

// UI sans is Readex Pro — a variable Latin+Arabic family, so Arabic glyphs
// render in the same family instead of falling through to an OS default.
// Serif reading/display stacks still list Readex Pro after their Latin
// primary so Arabic titles/body text pick it up via per-glyph fallback.
//
// Cairo / Lateef / Tajawal are Arabic reading fonts self-hosted under
// /public/fonts/reading/. Each lists an Amiri/Readex/system sans fallback
// so Latin glyphs interleaved in the text render in a compatible family
// instead of the browser default.
export const FONT_STACKS: Record<FontFamilyKey, string> = {
  serif:
    '"Literata", "Iowan Old Style", "Source Serif Pro", "Readex Pro", Georgia, serif',
  sans: '"Readex Pro", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  dyslexic:
    '"Atkinson Hyperlegible", "Lexend", "Readex Pro", system-ui, sans-serif',
  cairo: '"Cairo", "Readex Pro", system-ui, sans-serif',
  lateef: '"Lateef", "Amiri", "Readex Pro", serif',
  tajawal: '"Tajawal", "Readex Pro", system-ui, sans-serif',
};

export const FONT_FAMILY_LABELS: Record<FontFamilyKey, string> = {
  serif: "Serif",
  sans: "Sans",
  dyslexic: "Dyslexic",
  cairo: "Cairo",
  lateef: "Lateef",
  tajawal: "Tajawal",
};

export const FONT_SERIF_DISPLAY =
  '"Fraunces", "Literata", "Readex Pro", Georgia, serif';

// Match anything in the Arabic Unicode blocks (base, supplement, extended-A,
// presentation forms A & B). Used to decide whether to render a book title
// in the editorial Fraunces stack or fall back to the UI's Readex Pro so
// digits and punctuation match the Arabic glyphs visually.
const ARABIC_RANGE =
  /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function isArabicTitle(title: string): boolean {
  return ARABIC_RANGE.test(title);
}

/** Pick the right title font stack for a book whose title may be Arabic.
 *  - Arabic / mixed: FONT_STACKS.sans (Readex Pro), so digits and Latin
 *    punctuation interleaved with Arabic don't fall through to Fraunces.
 *  - Pure Latin: FONT_SERIF_DISPLAY (Fraunces), the editorial display feel. */
export function titleFontFor(title: string): string {
  return isArabicTitle(title) ? FONT_STACKS.sans : FONT_SERIF_DISPLAY;
}

// BCP-47 language subtags whose script is right-to-left. We only check the
// primary subtag (before the first hyphen), so `ar-EG`, `fa-IR`, etc. all
// resolve correctly.
const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi"]);

/** True when the book's language tag indicates an RTL script. Used to
 *  auto-flip column / text direction without making the user toggle it. */
export function isRtlLanguage(language: string | undefined | null): boolean {
  if (!language) return false;
  const primary = language.toLowerCase().split(/[-_]/)[0];
  return RTL_LANGS.has(primary);
}
export const FONT_ARABIC =
  '"Amiri", "Noto Naskh Arabic", "Scheherazade New", serif';

export const ACCENT = "#c96442"; // warm copper amber, matches design
