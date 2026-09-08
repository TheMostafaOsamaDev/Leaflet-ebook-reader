import type { FontFamilyKey, ThemePref, UiFontKey } from "../styles/tokens";
import type { UiLangPref } from "../i18n";

export type ActivePanel =
  | null
  | "toc"
  | "highlights"
  | "settings"
  | "progress";

/**
 * How the chapter is laid out in the reader.
 *
 *  - `paginated-2`: two side-by-side columns that exactly fill the page.
 *    No vertical scroll; left/right arrows flip pages.
 *  - `paginated-1`: single column filling the page, paginated.
 *  - `scroll`: classic vertical scroll, the entire chapter in one column.
 *
 * Position is preserved across modes via the persisted paragraph index —
 * switching modes lands the reader on the same paragraph it was last
 * showing, mapped onto whichever layout is active.
 */
export type ReadingMode = "paginated-2" | "paginated-1" | "scroll";

export interface Tweaks {
  /** UI-language preference for the app chrome (NOT book content). "system"
      resolves from the OS/browser locale; "en"/"ar" pin a language. Drives the
      shell's reading direction. Book content direction stays derived per-book. */
  uiLang: UiLangPref;
  /** Theme preference. "system" follows the OS light/dark setting; the
      four concrete values pin a specific theme. Resolved to a concrete
      ThemeKey at render time via resolveTheme(). */
  theme: ThemePref;
  /** Reuses the token union so the reading library has ONE source of truth —
   *  this was a duplicated inline literal and drifted the moment fonts were
   *  added. */
  fontFamily: FontFamilyKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /** "auto" derives alignment from the book's language: justify in LTR
      books, right in RTL books. The explicit values let the user override. */
  textAlign: "auto" | "left" | "justify" | "right";
  readingMode: ReadingMode;
  /** Desktop only. Hides the reader chrome (top bar + bottom scrubber) so the
      page fills the window; hovering either edge brings that bar back. The
      phone reader has its own tap-to-hide chrome and ignores this. */
  focusMode: boolean;
  /** Reading column width as a percentage of the available container width
      (50–100). Applies in every reading mode on both desktop and mobile,
      letting the user shrink or expand the text column to match their
      screen. */
  contentWidth: number;
  /** Selectable UI font for the app chrome. Resolved to a concrete font
      stack via UI_FONT_STACKS and applied through the `--ui-font` CSS var. */
  uiFont: UiFontKey;
  /** Extra vertical spacing between paragraphs, in em. Default 1.1
      preserves the previously hardcoded spacing. */
  paragraphSpacing: number;
  /** Enable automatic hyphenation of book text at line breaks. */
  hyphenation: boolean;
  /** Animate page turns in paginated modes. When off, pages flip instantly. */
  pageTurnAnimation: boolean;
  /** Request a wake lock while reading to keep the screen from sleeping. */
  keepScreenAwake: boolean;
  /** What the app shows on launch: the library, or resume the last book. */
  startupView: "library" | "resume";
  /** Ask for confirmation before deleting a book. */
  confirmDelete: boolean;
  /** Reduced-motion preference. "auto" follows the OS setting; "on"/"off"
      force it regardless of the OS media query. */
  reduceMotion: "auto" | "on" | "off";
  /** Maximum number of downloads to run at once (1–5). */
  maxConcurrentDownloads: number;
  /** Only download over Wi-Fi / non-metered connections. */
  wifiOnlyDownloads: boolean;
  /** Fixed-page (PDF/DOCX) default flow: continuous scroll or one page at a
      time. Reflowable books ignore it (they use `readingMode`). */
  fixedFlow: FixedFlow;
  /** Fixed-page fit: fit the page width, or the whole page, to the viewport. */
  fixedFit: FixedFit;
  /** Fixed-page tint: keep page colors, dim them (glare in dark themes), or
      invert (text-only PDFs; wrecks color art, so opt-in). */
  fixedPageTint: FixedPageTint;
}

// ── Normalized, format-agnostic reader vocabulary ───────────────────────────
// The reader shell + panels speak these instead of EpubBook, so the same
// Contents / Progress / Highlights UI serves reflowable and fixed-page books.

/** Where the reader is / can go, independent of format. Reflowable books use
 *  the chapter/paragraph anchor; fixed (PDF/DOCX) books use a page index. */
export type ReaderLocation =
  | { fmt: "reflow"; chapter: number; paragraphIndex: number; paragraphOffset?: number }
  | { fmt: "page"; page: number; pageOffset?: number };

/** One entry in a Contents / outline list. `level` is 0-based nesting depth. */
export interface TocEntry {
  title: string;
  dest: ReaderLocation;
  level: number;
}

/** One collapsible volume in the Contents list, over a contiguous run of
 *  chapter `order`s. Only sources that publish volumes can supply these —
 *  local EPUBs flatten to a single spine with no grouping metadata, so the
 *  Contents panel falls back to an ungrouped list when they're absent. */
export interface TocVolume {
  /** Stable key within the book. */
  id: string;
  title: string;
  /** First chapter `order` in the volume. */
  start: number;
  /** Last chapter `order` in the volume, inclusive. */
  end: number;
}

/** Progress the shell renders in the header bar + counter + Progress panel. */
export interface ReaderProgress {
  /** 0..1. */
  fraction: number;
  /** Localized, e.g. "٧ / ٢٩٨" or "Ch. 3 · 24%". */
  label: string;
  /** Fixed-layout only: the 0-based page this progress refers to. Carried
   *  explicitly because `fraction` cannot be inverted back to a page — it is
   *  `(page + 1) / pageCount`, so recovering the index from it lands a page
   *  ahead and the counter reads one too high on every page. */
  page?: number;
}

/** Fixed-page (PDF/DOCX) flow: continuous stacked pages, or one page at a time. */
export type FixedFlow = "scroll" | "paged";
/** Fixed-page fit: fit the page width, or the whole page, to the viewport. */
export type FixedFit = "width" | "page";
/** Fixed-page tint: keep colors, dim (dark-theme glare), or invert (text PDFs). */
export type FixedPageTint = "none" | "dim" | "invert";
