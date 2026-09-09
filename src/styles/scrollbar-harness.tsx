// Throwaway harness for the overlay scrollbar. Not part of the app.
//
// Mirrors what the app does at boot: import global.css, publish the theme's
// `--sb-thumb`, and install the delegated controller. Then renders the three
// shapes of scroll area the app actually has — a full-height page column, a
// small rounded panel, and an RTL one — so the bar can be screenshot-verified
// without Tauri.

import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "./global.css";
import { THEMES, type ThemeKey } from "./tokens";
import { installOverlayScrollbar } from "./overlayScrollbar";

const KEYS: ThemeKey[] = ["sepia", "light", "dark", "oled"];

function Rows({ n, prefix }: { n: number; prefix: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ padding: "14px 20px", fontSize: 15 }}>
          {prefix} {i + 1} — الفصل الأول من الكتاب
        </div>
      ))}
    </>
  );
}

function Harness() {
  const [key, setKey] = useState<ThemeKey>(
    (new URLSearchParams(location.search).get("theme") as ThemeKey) ?? "sepia",
  );
  const theme = THEMES[key];

  useEffect(() => {
    document.body.style.background = theme.bg;
    document.body.style.color = theme.ink;
    document.documentElement.style.setProperty("--sb-thumb", theme.muted);
  }, [theme]);

  // `?nobar=1` skips the controller, so a perf run can compare frame timing
  // against the same page without it.
  const off = new URLSearchParams(location.search).has("nobar");
  useEffect(() => (off ? undefined : installOverlayScrollbar()), [off]);

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ width: 150, padding: 12, flex: "0 0 auto" }}>
        {KEYS.map((k) => (
          <button
            key={k}
            data-testid={`theme-${k}`}
            onClick={() => setKey(k)}
            style={{ display: "block", margin: "4px 0", width: "100%" }}
          >
            {k}
          </button>
        ))}
      </div>

      {/* A full-height page column, like the library or settings. */}
      <div
        data-testid="page"
        style={{
          flex: 1,
          overflowY: "auto",
          borderInlineStart: `1px solid ${theme.ruleStrong}`,
        }}
      >
        <Rows n={60} prefix="Row" />
      </div>

      {/* Like the reader column: pads its content clear of floating chrome,
          so the bar must stay inside that padding rather than crossing it. */}
      <div
        data-testid="padded"
        style={{
          flex: "0 0 260px",
          overflowY: "auto",
          padding: "110px 16px 70px",
          borderInlineStart: `1px solid ${theme.ruleStrong}`,
        }}
      >
        <Rows n={40} prefix="Pad" />
      </div>

      {/* A small rounded panel, like a dialog body or the TOC. */}
      <div style={{ flex: "0 0 320px", padding: 24 }}>
        <div
          data-testid="panel"
          style={{
            height: 300,
            overflowY: "auto",
            borderRadius: 16,
            border: `1px solid ${theme.ruleStrong}`,
          }}
        >
          <Rows n={30} prefix="Panel" />
        </div>

        {/* Opted out: a container that draws its own bar must get no overlay
            one, or the reader would show two bars side by side. */}
        <div
          data-testid="optout"
          data-no-overlay-scrollbar
          style={{
            marginTop: 24,
            height: 120,
            overflowY: "auto",
            borderRadius: 16,
            border: `1px solid ${theme.ruleStrong}`,
          }}
        >
          <Rows n={20} prefix="OptOut" />
        </div>

        {/* The same panel mirrored — the bar must land on the left edge. */}
        <div
          data-testid="rtl"
          dir="rtl"
          style={{
            marginTop: 24,
            height: 240,
            overflowY: "auto",
            borderRadius: 16,
            border: `1px solid ${theme.ruleStrong}`,
          }}
        >
          <Rows n={30} prefix="مدخل" />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
