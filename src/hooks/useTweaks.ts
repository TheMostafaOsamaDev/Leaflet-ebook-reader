import { useCallback, useEffect, useState } from "react";
import type { Tweaks } from "../types/reader";

const STORAGE_KEY = "leaflet:tweaks:v1";

export const DEFAULT_TWEAKS: Tweaks = {
  theme: "sepia",
  fontFamily: "serif",
  fontSize: 17,
  lineHeight: 1.6,
  letterSpacing: 0,
  textAlign: "auto",
  readingMode: "paginated-2",
  pageWidth: 900,
};

function load(): Tweaks {
  if (typeof localStorage === "undefined") return DEFAULT_TWEAKS;
  try {
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
    return { ...DEFAULT_TWEAKS, ...parsed };
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

  return [t, setTweak] as const;
}
