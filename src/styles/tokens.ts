// Design tokens — themes, highlight palette, font stacks.
// Mirrors the prototype's `reader-core.jsx`, but typed.

export type ThemeKey = "light" | "sepia" | "dark" | "oled";

/** Stored theme preference: the four concrete themes plus "system",
 *  which resolves to light/dark from the OS `prefers-color-scheme`. */
export type ThemePref = ThemeKey | "system";

/** Resolve a stored preference to a concrete theme key. "system" maps to
 *  dark/light from the OS setting; the four concrete keys pass through. */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): ThemeKey {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

export interface Theme {
  bg: string;
  paper: string;
  ink: string;
  muted: string;
  rule: string;
  /** A bolder variant of `rule` for edges that need to register against
   *  shadows or larger surfaces (e.g. the mobile bottom-nav top border).
   *  Same hue family as `rule`, ~1.6× the alpha. */
  ruleStrong: string;
  chrome: string;
  /** Translucent `chrome`, for reader bars that float over the page and blur
   *  it (see reader/chrome/glass.ts). Alpha is deliberately high — 0.78-0.80
   *  rather than the ~0.6 a "glass" panel usually gets — because the thing
   *  behind these bars is body text, and the 10px subtitle in the top bar has
   *  to stay legible over the brightest patch of it. At 0.78 with a 24px blur
   *  the effective backdrop of a text page lands around 4.8:1 for `muted`,
   *  which clears AA; dropping much lower does not.
   *
   *  Only for surfaces that actually carry `backdrop-filter`. Without the blur
   *  this is just a washed-out `chrome` with the raw text showing through it —
   *  use `chrome` for anything opaque. */
  chromeGlass: string;
  chromeInk: string;
  /** Translucent overlay tint for hover/press on surfaces whose base
   *  background is TRANSPARENT (e.g. list rows). Do NOT use it to replace an
   *  opaque `chrome` fill — the element would lose its fill and wash out
   *  against a backdrop. For chrome-filled controls use `chromeHover`. */
  hover: string;
  /** Opaque hover/press fill for controls whose base background is `chrome`
   *  (pills, chips, chrome buttons). A slightly darker (light themes) or
   *  lighter (dark themes) sibling of `chrome`, so the control keeps a solid
   *  fill and the state change stays legible on any background. */
  chromeHover: string;
  /** Destructive-action colour: delete affordances, error glyphs, the
   *  bulk-delete button's fill. Tuned per theme against that theme's
   *  `bg` — the flat #b75050 this replaced measured 3.66:1 on dark's
   *  #1a1614 and 4.17:1 on sepia's #f4ecd8, both under WCAG AA 4.5:1
   *  for the 13px destructive menu labels where colour is the only
   *  signal beyond the trash glyph.
   *
   *  Every value below clears 4.5:1 against its theme's `bg` AND
   *  against `bg` with `hover` composited over it (list rows arm their
   *  trash icon on hover, so the hovered surface is the one that
   *  matters). A solid destructive fill therefore takes `theme.bg` as
   *  its text colour — the ratio is the token's own bg ratio by
   *  construction, so it can never drift out of AA. Mirrors Material
   *  3's error / on-error pairing, where the dark scheme's error is a
   *  LIGHT red carrying dark text. */
  danger: string;
}

export const THEMES: Record<ThemeKey, Theme> = {
  sepia: {
    bg: "#f4ecd8",
    paper: "#f4ecd8",
    ink: "#3a2f1f",
    // Darkened from #8b7355 to clear WCAG AA (4.5:1) for secondary text on
    // paper/bg/chrome (was ~3.4:1). Same warm hue, lower lightness.
    muted: "#6f5a3d",
    rule: "rgba(58,47,31,0.14)",
    ruleStrong: "rgba(58,47,31,0.22)",
    chrome: "#ebe0c5",
    chromeGlass: "rgba(235,224,197,0.78)",
    chromeInk: "#5a4a2e",
    hover: "rgba(58,47,31,0.06)",
    chromeHover: "#e0d3b2",
    // 5.18:1 on bg, 4.68:1 hovered.
    danger: "#a4433c",
  },
  light: {
    bg: "#faf8f3",
    paper: "#ffffff",
    ink: "#1f1a14",
    // Darkened from #8b7e6a to clear WCAG AA (4.5:1) on paper/bg/chrome.
    muted: "#6e6250",
    rule: "rgba(31,26,20,0.10)",
    ruleStrong: "rgba(31,26,20,0.18)",
    chrome: "#f0ece2",
    chromeGlass: "rgba(240,236,226,0.78)",
    chromeInk: "#3a332a",
    hover: "rgba(31,26,20,0.05)",
    chromeHover: "#e5ded0",
    // 5.74:1 on bg, 5.21:1 hovered.
    danger: "#a4433c",
  },
  dark: {
    bg: "#1a1614",
    paper: "#1a1614",
    ink: "#d8cbb0",
    // Lightened from #887a60 to clear WCAG AA (4.5:1) for secondary text on
    // the dark surfaces (was ~3.9:1). Same warm hue, higher lightness.
    muted: "#9c8e70",
    rule: "rgba(216,203,176,0.14)",
    ruleStrong: "rgba(216,203,176,0.22)",
    chrome: "#24201c",
    chromeGlass: "rgba(36,32,28,0.78)",
    chromeInk: "#c4b89c",
    hover: "rgba(216,203,176,0.06)",
    chromeHover: "#322d27",
    // 5.79:1 on bg, 5.15:1 hovered.
    danger: "#d4796f",
  },
  oled: {
    bg: "#000000",
    paper: "#000000",
    ink: "#b8ad94",
    // Lightened from #6a6148 to clear WCAG AA (4.5:1) on the near-black
    // surfaces (was ~3.2:1).
    muted: "#8a7f61",
    rule: "rgba(184,173,148,0.10)",
    ruleStrong: "rgba(184,173,148,0.18)",
    chrome: "#0c0a08",
    chromeGlass: "rgba(12,10,8,0.82)",
    chromeInk: "#a89d84",
    hover: "rgba(184,173,148,0.05)",
    chromeHover: "#211d17",
    // 6.26:1 on bg, 5.94:1 hovered.
    danger: "#cf7268",
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

/** Every value `Tweaks.fontFamily` can hold.
 *
 *  `serif` / `sans` / `dyslexic` are LEGACY. They predate the font library and
 *  are no longer offered in the picker (see READING_FONTS), but they stay in
 *  the union for two reasons: `FONT_STACKS.sans` is the app-chrome stack used
 *  by ~100 call sites, and `FONT_STACKS.serif` is what the fixed DOCX
 *  paginator sets its pages in. Persisted values are migrated away on load
 *  (see hooks/useTweaks). */
export type FontFamilyKey =
  | "serif"
  | "sans"
  | "dyslexic"
  // ── the reading library ──
  | "readex"
  | "cairo"
  | "tajawal"
  | "almarai"
  | "ibmplex"
  | "alexandria"
  | "vazirmatn"
  | "elmessiri"
  | "notonaskh"
  | "scheherazade"
  | "markazi"
  | "mirza"
  | "lateef"
  | "notokufi"
  | "changa"
  | "lalezar"
  | "thmanyah";

/** Typographic style, used to group the picker. One selector drives both
 *  scripts, so grouping by script would be meaningless. */
export type FontGroup = "naskh" | "modern" | "kufi" | "display";

// UI sans is Readex Pro — a variable Latin+Arabic family, so Arabic glyphs
// render in the same family instead of falling through to an OS default.
// Serif reading/display stacks still list Readex Pro after their Latin
// primary so Arabic titles/body text pick it up via per-glyph fallback.
//
// Cairo / Lateef / Tajawal are Arabic reading fonts self-hosted under
// /public/fonts/reading/. Each lists an Amiri/Readex/system sans fallback
// so Latin glyphs interleaved in the text render in a compatible family
// instead of the browser default.
/** The literal Readex-Pro sans stack. Used by BOOK CONTENT — the reader's
 *  "Sans" reading option and the generated cover's author line — so it stays
 *  fixed regardless of the chosen UI/chrome font. `FONT_STACKS.sans`, by
 *  contrast, resolves to the user-selectable chrome font via `--ui-font`. */
export const FONT_READING_SANS =
  '"Readex Pro", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

// The reading-font picker is live again (the UI/chrome font stays Readex Pro
// — that picker is gone). `sans` is the odd one out: it is the CHROME stack,
// resolved through `--ui-font`, and is what every app surface uses via
// `FONT_STACKS.sans`. Book content asking for "Sans" goes through
// FONT_READING_SANS instead, so reading text never rides on the chrome font.
// Every reading stack ends in Readex Pro before the generic family: one
// selector drives BOTH scripts, so a family carrying only Arabic still needs
// somewhere sane for Latin runs to land (and vice versa). The picker's
// two-script preview makes that fallback visible rather than hiding it.
export const FONT_STACKS: Record<FontFamilyKey, string> = {
  serif:
    '"Literata", "Iowan Old Style", "Source Serif Pro", "Readex Pro", Georgia, serif',
  // Chrome/UI sans — resolves to `--ui-font`, which App sets from
  // UI_FONT_STACKS and which defaults to Readex Pro when unset.
  sans: 'var(--ui-font, "Readex Pro", -apple-system, BlinkMacSystemFont, system-ui, sans-serif)',
  dyslexic:
    '"Atkinson Hyperlegible", "Lexend", "Readex Pro", system-ui, sans-serif',

  readex: FONT_READING_SANS,
  cairo: '"Cairo", "Readex Pro", system-ui, sans-serif',
  tajawal: '"Tajawal", "Readex Pro", system-ui, sans-serif',
  almarai: '"Almarai", "Readex Pro", system-ui, sans-serif',
  ibmplex: '"IBM Plex Sans Arabic", "Readex Pro", system-ui, sans-serif',
  alexandria: '"Alexandria", "Readex Pro", system-ui, sans-serif',
  vazirmatn: '"Vazirmatn", "Readex Pro", system-ui, sans-serif',
  elmessiri: '"El Messiri", "Readex Pro", system-ui, sans-serif',
  notonaskh: '"Noto Naskh Arabic", "Readex Pro", serif',
  scheherazade: '"Scheherazade New", "Readex Pro", serif',
  markazi: '"Markazi Text", "Readex Pro", serif',
  mirza: '"Mirza", "Readex Pro", serif',
  lateef: '"Lateef", "Amiri", "Readex Pro", serif',
  notokufi: '"Noto Kufi Arabic", "Readex Pro", sans-serif',
  changa: '"Changa", "Readex Pro", system-ui, sans-serif',
  lalezar: '"Lalezar", "Readex Pro", system-ui, sans-serif',
  thmanyah: '"Thmanyah Serif Display", "Readex Pro", Georgia, serif',
};

export const FONT_FAMILY_LABELS: Record<FontFamilyKey, string> = {
  serif: "Serif",
  sans: "Sans",
  dyslexic: "Dyslexic",
  readex: "Readex Pro",
  cairo: "Cairo",
  tajawal: "Tajawal",
  almarai: "Almarai",
  ibmplex: "IBM Plex Sans Arabic",
  alexandria: "Alexandria",
  vazirmatn: "Vazirmatn",
  elmessiri: "El Messiri",
  notonaskh: "Noto Naskh Arabic",
  scheherazade: "Scheherazade New",
  markazi: "Markazi Text",
  mirza: "Mirza",
  lateef: "Lateef",
  notokufi: "Noto Kufi Arabic",
  changa: "Changa",
  lalezar: "Lalezar",
  thmanyah: "Thmanyah",
};

/** The pickable reading library, in picker order. Excludes the legacy
 *  serif/sans/dyslexic keys, which name faces that were never bundled (they
 *  silently resolved to Readex Pro or a system fallback). */
export const READING_FONTS: ReadonlyArray<{
  key: FontFamilyKey;
  group: FontGroup;
}> = [
  { key: "notonaskh", group: "naskh" },
  { key: "scheherazade", group: "naskh" },
  { key: "markazi", group: "naskh" },
  { key: "mirza", group: "naskh" },
  { key: "lateef", group: "naskh" },

  { key: "readex", group: "modern" },
  { key: "cairo", group: "modern" },
  { key: "tajawal", group: "modern" },
  { key: "almarai", group: "modern" },
  { key: "ibmplex", group: "modern" },
  { key: "alexandria", group: "modern" },
  { key: "vazirmatn", group: "modern" },
  { key: "elmessiri", group: "modern" },

  { key: "notokufi", group: "kufi" },

  { key: "changa", group: "display" },
  { key: "lalezar", group: "display" },
  { key: "thmanyah", group: "display" },
];

export const FONT_GROUP_ORDER: ReadonlyArray<FontGroup> = [
  "naskh",
  "modern",
  "kufi",
  "display",
];

/** Legacy `fontFamily` values → the closest bundled family. `serif` and
 *  `dyslexic` named faces that were never shipped, so they were already
 *  rendering as Readex Pro on Android; `markazi` gives `serif` a real serif
 *  for the first time. */
export const LEGACY_FONT_FAMILY: Partial<Record<FontFamilyKey, FontFamilyKey>> =
  {
    sans: "readex",
    dyslexic: "readex",
    serif: "markazi",
  };

/** Selectable UI (app-chrome) font — distinct from the per-book reading
 *  `FontFamilyKey`. Applied through the `--ui-font` CSS variable that
 *  `FONT_STACKS.sans` falls back through. All families are Latin+Arabic. */
export type UiFontKey =
  | "readex"
  | "alexandria"
  | "almarai"
  | "ibmplex"
  | "vazirmatn"
  | "thmanyah";

export const UI_FONT_STACKS: Record<UiFontKey, string> = {
  readex: FONT_READING_SANS,
  alexandria: FONT_READING_SANS,
  almarai: FONT_READING_SANS,
  ibmplex: FONT_READING_SANS,
  vazirmatn: FONT_READING_SANS,
  thmanyah: FONT_READING_SANS,
};

export const UI_FONT_LABELS: Record<UiFontKey, string> = {
  readex: "Readex Pro",
  alexandria: "Alexandria",
  almarai: "Almarai",
  ibmplex: "IBM Plex Sans Arabic",
  vazirmatn: "Vazirmatn",
  thmanyah: "Thmanyah",
};

/** Per-font `font-size-adjust` so every UI font renders at a consistent
 *  apparent size while the LAYOUT stays identical — font-size-adjust only
 *  scales glyph rendering; fixed px paddings/gaps/margins/heights don't move,
 *  so switching UI font never resizes the UI. Values are calibrated so each
 *  font's apparent Arabic size matches Readex. Applied to the chrome via the
 *  `--ui-font-adjust` variable; book content opts out (font-size-adjust:none). */
export const UI_FONT_ADJUST: Record<UiFontKey, number> = {
  readex: 0.525,
  alexandria: 0.525,
  almarai: 0.525,
  ibmplex: 0.525,
  vazirmatn: 0.525,
  thmanyah: 0.525,
};

// Titles are no longer set in a serif — display text is Readex Pro too.
export const FONT_SERIF_DISPLAY = FONT_READING_SANS;

// Match anything in the Arabic Unicode blocks (base, supplement, extended-A,
// presentation forms A & B). Used to decide whether to render a book title
// in the editorial Fraunces stack or fall back to the UI's Readex Pro so
// digits and punctuation match the Arabic glyphs visually.
const ARABIC_RANGE =
  /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function isArabicTitle(title: string): boolean {
  return ARABIC_RANGE.test(title);
}

/** Book-title display stack. Both Latin and Arabic titles now use the
 *  editorial display serif: FONT_SERIF_DISPLAY lists Fraunces then Thmanyah
 *  Serif Display, so per-glyph fallback renders Latin in Fraunces and Arabic
 *  in Thmanyah — Arabic titles no longer fall back to the sans. `isArabicTitle`
 *  stays exported for callers that still tune fontStyle (italic vs upright). */
export function titleFontFor(_title: string): string {
  return FONT_SERIF_DISPLAY;
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

// ── reading surfaces ────────────────────────────────────────────────────────

/** Parse "#rgb"/"#rrggbb" to 8-bit RGB, or null if it isn't a hex colour. */
function parseHexColor(hex: string): [number, number, number] | null {
  let h = hex.trim();
  if (h[0] !== "#") return null;
  h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** Move a colour `amount` (0..1) of the way toward black (negative) or white. */
function shade(hex: string, amount: number): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return hex;
  const target = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  return toHex(rgb.map((c) => c + (target - c) * k) as [number, number, number]);
}

/** How far the surround sits from the page. Small on purpose — enough to read
 *  as a sheet, not so much that it becomes a frame competing with the text. */
const SURFACE_STEP = 0.06;

export interface ReadingSurfaces {
  /** The sheet the words sit on. */
  page: string;
  /** What sits behind and around the sheet. */
  surround: string;
}

/** Page and surround for a theme.
 *
 *  Three of the four themes set `paper` equal to `bg`, so a page rendered at
 *  the theme's paper colour is indistinguishable from what's behind it — with
 *  no border and no gutter at fit-width, the sheet simply disappears. These
 *  derive a tonal step instead of relying on the tokens differing.
 *
 *  The page is always the more elevated of the two. Normally that means
 *  recessing the surround; on a pure-black theme there is nothing below black
 *  to recess to, so the page is lifted instead. */
export function readingSurfaces(theme: Theme): ReadingSurfaces {
  const rgb = parseHexColor(theme.paper);
  const nearBlack = !rgb || (rgb[0] + rgb[1] + rgb[2]) / 3 < 24;
  return nearBlack
    ? { page: shade(theme.paper, SURFACE_STEP), surround: theme.paper }
    : { page: theme.paper, surround: shade(theme.paper, -SURFACE_STEP) };
}
