import { useCallback, useEffect, useState } from "react";
import type { Tweaks } from "../types/reader";
import {
  FONT_STACKS,
  LEGACY_FONT_FAMILY,
  UI_FONT_STACKS,
  type FontFamilyKey,
} from "../styles/tokens";
import { migrateStorageKey } from "../lib/legacyStorage";

const STORAGE_KEY = "riwaq:tweaks:v1";

export const DEFAULT_TWEAKS: Tweaks = {
  uiLang: "system",
  theme: "sepia",
  fontFamily: "readex",
  fontSize: 17,
  lineHeight: 1.6,
  letterSpacing: 0,
  textAlign: "auto",
  readingMode: "paginated-2",
  focusMode: false,
  contentWidth: 100,
  uiFont: "readex",
  paragraphSpacing: 1.1,
  hyphenation: false,
  pageTurnAnimation: true,
  keepScreenAwake: false,
  startupView: "library",
  confirmDelete: true,
  reduceMotion: "auto",
  maxConcurrentDownloads: 2,
  wifiOnlyDownloads: false,
  fixedFlow: "scroll",
  fixedFit: "width",
  fixedPageTint: "none",
};

function load(): Tweaks {
  if (typeof localStorage === "undefined") return DEFAULT_TWEAKS;
  try {
    migrateStorageKey(STORAGE_KEY);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TWEAKS;
    const parsed = JSON.parse(raw);
    // Migrate the old `columns: 1 | 2` field into the new `readingMode`
    // shape — pre-readingMode users had two-column scroll if they picked
    // `columns: 2`, otherwise single-column scroll.
    if (parsed && typeof parsed === "object" && parsed.readingMode === undefined) {
      if (parsed.columns === 2) parsed.readingMode = "paginated-2";
      else if (parsed.columns === 1) parsed.readingMode = "scroll";
      delete parsed.columns;
    }
    // The old manual `rtl` toggle is gone — direction is now derived from
    // the book's language tag at render time. Drop the field so the
    // spread merge with DEFAULT_TWEAKS doesn't keep a stale boolean.
    if (parsed && typeof parsed === "object" && "rtl" in parsed) {
      delete parsed.rtl;
    }
    // pageWidth (px scroll-mode cap) was superseded by contentWidth (%);
    // strip it so the spread doesn't keep a stale field.
    if (parsed && typeof parsed === "object" && "pageWidth" in parsed) {
      delete parsed.pageWidth;
    }
    // Tap-to-turn is gone — the reading surface is scroll-only now, and a tap
    // anywhere on it toggles the chrome. Strip the three settings it owned so
    // the spread below doesn't carry them forward on every save.
    if (parsed && typeof parsed === "object") {
      delete parsed.mobileTapNav;
      delete parsed.mobileTapZoneWidth;
      delete parsed.mobileTapStride;
    }
    const merged = { ...DEFAULT_TWEAKS, ...parsed };
    // The reading library replaced the old three-option picker. `serif`,
    // `sans` and `dyslexic` named faces that were never bundled, so they were
    // already resolving to Readex Pro (or a system fallback) — point them at
    // real families instead. Anything unrecognised falls back to the default
    // so a corrupt or hand-edited value can't leave the reader unstyled.
    const legacy =
      LEGACY_FONT_FAMILY[merged.fontFamily as FontFamilyKey];
    if (legacy) merged.fontFamily = legacy;
    if (!(merged.fontFamily in FONT_STACKS)) {
      merged.fontFamily = DEFAULT_TWEAKS.fontFamily;
    }
    // Cairo/Tajawal were removed as UI (chrome) fonts — coerce a stale
    // persisted value (or any unknown one) back to the default so the picker
    // and the chrome font stay valid.
    if (!(merged.uiFont in UI_FONT_STACKS)) merged.uiFont = "readex";
    return merged;
  } catch {
    return DEFAULT_TWEAKS;
  }
}

export function useTweaks() {
  const [t, setT] = useState<Tweaks>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    } catch {
      // ignore persistence failure — it's not load-bearing
    }
  }, [t]);

  const setTweak = useCallback(
    <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
      setT((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const applyTweaks = useCallback((partial: Partial<Tweaks>) => {
    setT((prev) => {
      const next: Tweaks = { ...prev };
      for (const k of Object.keys(partial) as (keyof Tweaks)[]) {
        const v = partial[k];
        // Only accept a known key whose value matches the default's type (and,
        // for numbers, is finite). Guards Import Settings against corrupt or
        // foreign JSON — e.g. a string where a number is expected, or NaN,
        // which would otherwise poison a downstream effect (chrome font,
        // download concurrency).
        if (
          k in DEFAULT_TWEAKS &&
          v !== undefined &&
          typeof v === typeof DEFAULT_TWEAKS[k] &&
          !(typeof v === "number" && !Number.isFinite(v))
        ) {
          (next as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return next;
    });
  }, []);

  return [t, setTweak, applyTweaks] as const;
}
