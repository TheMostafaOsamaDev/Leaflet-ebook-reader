import { useCallback, useEffect, useState } from "react";
import type { Tweaks } from "../types/reader";

const STORAGE_KEY = "leaflet:tweaks:v1";

export const DEFAULT_TWEAKS: Tweaks = {
  theme: "sepia",
  fontFamily: "serif",
  fontSize: 17,
  lineHeight: 1.6,
  letterSpacing: 0,
  textAlign: "justify",
  rtl: false,
};

function load(): Tweaks {
  if (typeof localStorage === "undefined") return DEFAULT_TWEAKS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TWEAKS;
    const parsed = JSON.parse(raw);
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
