import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  type FontFamilyKey,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
import type { Tweaks } from "../types/reader";
import { PanelShell } from "./PanelShell";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  onClose?: () => void;
  width?: number | string;
  side?: "left" | "right";
  /** Surface mobile-only fields (e.g. tap-to-turn-pages). The desktop
      reader doesn't show these because they have no effect there. */
  mobile?: boolean;
}

const THEME_SWATCHES: ReadonlyArray<[ThemeKey, string, string]> = [
  ["light", "#ffffff", "#1f1a14"],
  ["sepia", "#f4ecd8", "#3a2f1f"],
  ["dark", "#1a1614", "#d8cbb0"],
  ["oled", "#000000", "#b8ad94"],
];

interface FontOpt {
  value: FontFamilyKey;
  label: string;
  name: string;
  font: string;
}

const FONT_ROW_LATIN: ReadonlyArray<FontOpt> = [
  { value: "serif", label: "Aa", name: "Serif", font: FONT_STACKS.serif },
  { value: "sans", label: "Aa", name: "Sans", font: FONT_STACKS.sans },
  {
    value: "dyslexic",
    label: "Aa",
    name: "Dyslexic",
    font: FONT_STACKS.dyslexic,
  },
];

const FONT_ROW_ARABIC: ReadonlyArray<FontOpt> = [
  { value: "cairo", label: "أب", name: "Cairo", font: FONT_STACKS.cairo },
  { value: "lateef", label: "أب", name: "Lateef", font: FONT_STACKS.lateef },
  { value: "tajawal", label: "أب", name: "Tajawal", font: FONT_STACKS.tajawal },
];

function Field({
  label,
  theme,
  children,
}: {
  label: string;
  theme: Theme;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "12px 18px",
        borderBottom: `0.5px solid ${theme.rule}`,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          color: theme.muted,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

interface SegRowProps<T extends string> {
  theme: Theme;
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: ReactNode }[];
}

function SegRow<T extends string>({
  theme,
  value,
  onChange,
  options,
}: SegRowProps<T>) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        background: theme.hover,
        borderRadius: 8,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              border: "none",
              background: selected ? theme.paper : "transparent",
              color: theme.ink,
              padding: "8px 4px",
              borderRadius: 6,
              cursor: "pointer",
              fontFamily: FONT_STACKS.sans,
              fontSize: 12,
              fontWeight: 500,
              boxShadow: selected ? `0 1px 2px ${theme.rule}` : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPanel({
  theme,
  themeKey,
  t,
  setTweak,
  onClose,
  width,
  side = "right",
  mobile,
}: Props) {
  return (
    <PanelShell
      theme={theme}
      title="Reading"
      subtitle="Appearance & typography"
      onClose={onClose}
      icon={<Icon name="type" size={14} />}
      width={width}
      side={side}
    >
      <Field label="Theme" theme={theme}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 6,
          }}
        >
          {THEME_SWATCHES.map(([k, bg, ink]) => (
            <button
              key={k}
              onClick={() => setTweak("theme", k)}
              style={{
                border:
                  themeKey === k
                    ? `1.5px solid ${theme.ink}`
                    : `1px solid ${theme.rule}`,
                background: bg,
                color: ink,
                borderRadius: 8,
                padding: "14px 0 8px",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  fontFamily: FONT_SERIF_DISPLAY,
                  fontSize: 18,
                  fontStyle: "italic",
                }}
              >
                Aa
              </span>
              <span
                style={{
                  fontFamily: FONT_STACKS.sans,
                  fontSize: 9.5,
                  color: ink,
                  opacity: 0.7,
                  textTransform: "capitalize",
                }}
              >
                {k}
              </span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Font" theme={theme}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[FONT_ROW_LATIN, FONT_ROW_ARABIC].map((row, i) => (
            <SegRow<FontFamilyKey>
              key={i}
              theme={theme}
              value={t.fontFamily}
              onChange={(v) => setTweak("fontFamily", v)}
              options={row.map((o) => ({
                value: o.value,
                label: (
                  <span
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 3,
                    }}
                  >
                    <span style={{ fontFamily: o.font, fontSize: 16 }}>
                      {o.label}
                    </span>
                    <span
                      style={{
                        fontSize: 9.5,
                        color: theme.muted,
                        fontWeight: 500,
                      }}
                    >
                      {o.name}
                    </span>
                  </span>
                ),
              }))}
            />
          ))}
        </div>
      </Field>

      <Field label={`Font size · ${t.fontSize}px`} theme={theme}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: theme.ink }}>
          <span
            style={{
              fontFamily: FONT_SERIF_DISPLAY,
              fontSize: 12,
              color: theme.muted,
            }}
          >
            A
          </span>
          <input
            type="range"
            min={14}
            max={42}
            value={t.fontSize}
            onChange={(e) => setTweak("fontSize", +e.target.value)}
            style={{ flex: 1, color: theme.ink }}
          />
          <span
            style={{
              fontFamily: FONT_SERIF_DISPLAY,
              fontSize: 22,
              color: theme.ink,
            }}
          >
            A
          </span>
        </div>
      </Field>

      <Field label={`Line height · ${t.lineHeight.toFixed(2)}`} theme={theme}>
        <input
          type="range"
          min={1.3}
          max={2.0}
          step={0.05}
          value={t.lineHeight}
          onChange={(e) => setTweak("lineHeight", +e.target.value)}
          style={{ width: "100%", color: theme.ink }}
        />
      </Field>

      <Field
        label={`Letter spacing · ${t.letterSpacing.toFixed(2)}em`}
        theme={theme}
      >
        <input
          type="range"
          min={-0.02}
          max={0.08}
          step={0.005}
          value={t.letterSpacing}
          onChange={(e) => setTweak("letterSpacing", +e.target.value)}
          style={{ width: "100%", color: theme.ink }}
        />
      </Field>

      <Field label="Alignment" theme={theme}>
        <SegRow<Tweaks["textAlign"]>
          theme={theme}
          value={t.textAlign}
          onChange={(v) => setTweak("textAlign", v)}
          options={[
            { value: "auto", label: <span style={{ fontSize: 11 }}>Auto</span> },
            { value: "left", label: <span style={{ fontSize: 14 }}>⯇</span> },
            {
              value: "justify",
              label: <span style={{ fontSize: 14 }}>☰</span>,
            },
            {
              value: "right",
              label: <span style={{ fontSize: 14 }}>⯈</span>,
            },
          ]}
        />
      </Field>

      <Field label="Reading mode" theme={theme}>
        <SegRow<Tweaks["readingMode"]>
          theme={theme}
          value={t.readingMode}
          onChange={(v) => setTweak("readingMode", v)}
          options={[
            { value: "paginated-2", label: "Two pages" },
            { value: "paginated-1", label: "Single page" },
            { value: "scroll", label: "Scroll" },
          ]}
        />
      </Field>

      {t.readingMode === "scroll" && (
        <Field label={`Page width · ${t.pageWidth}px`} theme={theme}>
          <input
            type="range"
            min={480}
            max={1200}
            step={20}
            value={t.pageWidth}
            onChange={(e) => setTweak("pageWidth", +e.target.value)}
            style={{ width: "100%", color: theme.ink }}
          />
        </Field>
      )}

      {mobile && (
        <Field label="Tap to turn pages" theme={theme}>
          <SegRow<"on" | "off">
            theme={theme}
            value={t.mobileTapNav ? "on" : "off"}
            onChange={(v) => setTweak("mobileTapNav", v === "on")}
            options={[
              { value: "on", label: <span style={{ fontSize: 11 }}>On</span> },
              { value: "off", label: <span style={{ fontSize: 11 }}>Off</span> },
            ]}
          />
        </Field>
      )}

    </PanelShell>
  );
}
