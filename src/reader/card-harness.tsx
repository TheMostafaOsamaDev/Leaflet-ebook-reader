// Dev-only rig for the END-OF-CHAPTER CARD design.
//
// The navigation model is settled (see nav-harness): the chapter turn becomes a
// visible card at the end of the chapter rather than a hidden wheel push. This
// rig is for choosing how that card LOOKS and how it behaves per platform,
// which are the parts worth judging with your own eyes and hand.
//
// Interaction, by platform — deliberately not the same:
//   desktop  click the card, press Enter/Space on it, or simply keep scrolling
//            past it. A short quiet-lockout stops a continuing spin from
//            turning twice when the next chapter is shorter than the viewport.
//   mobile   tap only. Scroll-to-turn is off there on purpose: touch momentum
//            keeps firing events after the finger has left the glass, which is
//            exactly how one flick used to eat three chapters.
//
// Every variant is one <button>, so it is focusable, announced, and hits the
// 44px minimum with room to spare; press feedback changes fill and never
// layout, so nothing shifts under the thumb.
//
// `?variant=1..4`, `?platform=desktop|mobile`, `?theme=light|sepia|dark|oled`.
// Open it at /card-harness.html.

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "../components/Icon";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import {
  ACCENT,
  FONT_STACKS,
  THEMES,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
import "../styles/global.css";

const PARA =
  "التقط فانغ يوان الثوب الأسود والجوارب التي غيّرها، ألم أقل ذلك من قبل، " +
  "سنذهب إلى جبل باي غو الآن. أما بالنسبة إلى غو اليانغ، فانتظر على الأقل " +
  "حتى أكون في الرتبة الثالثة أولاً، وحتى ذلك الحين لا تتحدث عن الأمر مع أحد.";

const TITLES = [
  "صدمة التغيير",
  "المعركة الثالثة ضد باي نينغ بينغ",
  "كارثة طائر الكركي",
  "غو رفع الحواجب والزفير",
  "الخطوة الأخيرة للمحقق الإلهي",
  "ستارة دم زهرة السماء",
];

const TOTAL = 2372;
/** Short on purpose — the card is what is being judged, not the scrolling. */
const PARAS = 9;
/** Silence that must pass before a second scroll-past can turn again. */
const QUIET_MS = 350;

type Variant = 1 | 2 | 3 | 4;
type Platform = "desktop" | "mobile";

const VARIANTS: { id: Variant; name: string; blurb: string }[] = [
  { id: 1, name: "Quiet rule", blurb: "Editorial hairline · stays inside the reading surface" },
  { id: 2, name: "Card", blurb: "Filled surface, clear edge · the obvious affordance" },
  { id: 3, name: "Prominent", blurb: "Generous block with an explicit action pill" },
  { id: 4, name: "Contextual", blurb: "Card plus what's next: downloaded, position, previous" },
];

const params = new URLSearchParams(location.search);
const initialVariant = (Number(params.get("variant") ?? 2) as Variant) ?? 2;
const initialPlatform = (params.get("platform") ?? "desktop") as Platform;
const initialTheme = (params.get("theme") ?? "sepia") as ThemeKey;

function Harness() {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [themeKey, setThemeKey] = useState<ThemeKey>(initialTheme);
  const [chapter, setChapter] = useState(226);
  const [turns, setTurns] = useState(0);
  const [lastTurnVia, setLastTurnVia] = useState<string>("—");

  const theme = THEMES[themeKey] ?? THEMES.sepia;
  const isMobile = platform === "mobile";
  const scrollRef = useRef<HTMLDivElement>(null);
  const lockUntil = useRef(0);

  const turn = useCallback(
    (via: string) => {
      if (performance.now() < lockUntil.current) return;
      lockUntil.current = performance.now() + QUIET_MS;
      setChapter((c) => Math.min(TOTAL - 1, c + 1));
      setTurns((t) => t + 1);
      setLastTurnVia(via);
      const el = scrollRef.current;
      if (el) requestAnimationFrame(() => { el.scrollTop = 0; });
    },
    [],
  );

  // Desktop only: keep scrolling past the card and the chapter turns. The card
  // is already the affordance, so the gesture does not also have to prove
  // intent — one notch past the end is enough, where the hidden push needed
  // up to five. The lockout is all that is left of that machinery, and it is
  // there only to stop a chapter shorter than the viewport chaining.
  useEffect(() => {
    if (isMobile) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
      if (!atBottom || e.deltaY <= 0) return;
      e.preventDefault();
      if (Math.abs(e.deltaY) > 8) turn("scrolled past");
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isMobile, turn]);

  useEffect(() => {
    if (isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = scrollRef.current;
      if (!el) return;
      e.preventDefault();
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
      if (atBottom) turn("space");
      else el.scrollTop += el.clientHeight * 0.9;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, turn]);

  const nextTitle = TITLES[(chapter + 1) % TITLES.length];
  const downloaded = (chapter + 1) % 3 !== 0;

  const pane = (
    <div
      ref={scrollRef}
      style={{
        height: "100%",
        overflowY: "auto",
        overscrollBehavior: "contain",
        direction: "rtl",
        background: theme.paper,
      }}
    >
      <div
        style={{
          maxWidth: isMobile ? "none" : 660,
          margin: "0 auto",
          padding: isMobile ? "40px 20px 24px" : "56px 40px 24px",
          fontFamily: FONT_STACKS[DEFAULT_TWEAKS.fontFamily],
          fontSize: isMobile ? 17 : DEFAULT_TWEAKS.fontSize,
          lineHeight: DEFAULT_TWEAKS.lineHeight,
          textAlign: "right",
          color: theme.ink,
        }}
      >
        <div style={{ fontSize: 10.5, color: theme.muted, marginBottom: 8, fontFamily: FONT_STACKS.sans, letterSpacing: "0.06em" }}>
          {`الفصل ${chapter + 1} من ${TOTAL}`}
        </div>
        <h1 style={{ fontSize: isMobile ? 25 : 30, margin: "0 0 26px", fontWeight: 600 }}>
          {TITLES[chapter % TITLES.length]}
        </h1>
        {Array.from({ length: PARAS }, (_, i) => (
          <p key={i} style={{ margin: `0 0 ${DEFAULT_TWEAKS.paragraphSpacing}em` }}>
            {PARA}
          </p>
        ))}
      </div>

      <EndOfChapter
        variant={variant}
        theme={theme}
        isMobile={isMobile}
        nextNumber={chapter + 2}
        nextTitle={nextTitle}
        position={`${chapter + 2} من ${TOTAL}`}
        downloaded={downloaded}
        onNext={() => turn(isMobile ? "tapped" : "clicked")}
        onPrev={() => setChapter((c) => Math.max(0, c - 1))}
      />
    </div>
  );

  return (
    <div style={{ display: "flex", height: "100%", background: theme.bg, fontFamily: FONT_STACKS.sans }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: isMobile ? "center" : "stretch",
          justifyContent: "center",
          padding: isMobile ? 24 : 0,
          background: isMobile ? theme.bg : undefined,
        }}
      >
        {isMobile ? (
          // A phone-sized frame, so touch sizing and line length are judged at
          // the width they will actually be read at.
          <div
            style={{
              width: 390,
              height: 780,
              borderRadius: 34,
              overflow: "hidden",
              border: `1px solid ${theme.ruleStrong}`,
              boxShadow: `0 24px 60px rgba(0,0,0,0.22)`,
            }}
          >
            {pane}
          </div>
        ) : (
          pane
        )}
      </div>

      <aside
        style={{
          width: 340,
          flexShrink: 0,
          borderInlineStart: `1px solid ${theme.ruleStrong}`,
          background: theme.chrome,
          color: theme.ink,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          direction: "ltr",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>End-of-chapter card</div>
          <div style={{ fontSize: 11, color: theme.muted, marginTop: 3, lineHeight: 1.5 }}>
            Scroll to the end of the chapter. On desktop: click, press Space, or keep
            scrolling. On mobile: tap only.
          </div>
        </div>

        <Group label="Design" theme={theme}>
          {VARIANTS.map((v) => (
            <Row
              key={v.id}
              theme={theme}
              on={variant === v.id}
              onClick={() => setVariant(v.id)}
              title={`${v.id} · ${v.name}`}
              sub={v.blurb}
            />
          ))}
        </Group>

        <Group label="Platform" theme={theme}>
          <div style={{ display: "flex", gap: 6 }}>
            {(["desktop", "mobile"] as Platform[]).map((p) => (
              <Chip key={p} theme={theme} on={platform === p} onClick={() => setPlatform(p)}>
                {p}
              </Chip>
            ))}
          </div>
        </Group>

        <Group label="Theme" theme={theme}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["light", "sepia", "dark", "oled"] as ThemeKey[]).map((k) => (
              <Chip key={k} theme={theme} on={themeKey === k} onClick={() => setThemeKey(k)}>
                {k}
              </Chip>
            ))}
          </div>
        </Group>

        <Group label="State" theme={theme}>
          <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: theme.muted, lineHeight: 1.7 }}>
            <div>{`chapter    ${chapter + 1}`}</div>
            <div>{`turns      ${turns}`}</div>
            <div>{`last via   ${lastTurnVia}`}</div>
            <div>{`next is    ${downloaded ? "downloaded" : "online only"}`}</div>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <Chip
              theme={theme}
              on={false}
              onClick={() => {
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              jump to the card
            </Chip>
          </div>
        </Group>
      </aside>
    </div>
  );
}

// ── the four designs ───────────────────────────────────────────────────────

interface CardProps {
  variant: Variant;
  theme: Theme;
  isMobile: boolean;
  nextNumber: number;
  nextTitle: string;
  position: string;
  downloaded: boolean;
  onNext: () => void;
  onPrev: () => void;
}

function EndOfChapter(p: CardProps) {
  const { variant, theme, isMobile } = p;
  const pad = isMobile ? "0 20px 56px" : "0 40px 96px";
  return (
    <div style={{ maxWidth: isMobile ? "none" : 660, margin: "0 auto", padding: pad, direction: "rtl" }}>
      <EndRule theme={theme} />
      {variant === 1 ? <QuietRule {...p} /> : null}
      {variant === 2 ? <FilledCard {...p} /> : null}
      {variant === 3 ? <Prominent {...p} /> : null}
      {variant === 4 ? <Contextual {...p} /> : null}
    </div>
  );
}

/** Says the chapter is over before offering the next one. Shared by all four:
 *  an end marker is the thing the reader currently has no signal for at all. */
function EndRule({ theme }: { theme: Theme }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        margin: "8px 0 22px",
        color: theme.muted,
        fontFamily: FONT_STACKS.sans,
        fontSize: 10.5,
        letterSpacing: "0.1em",
      }}
    >
      <span style={{ flex: 1, height: 1, background: theme.rule }} />
      <span>نهاية الفصل</span>
      <span style={{ flex: 1, height: 1, background: theme.rule }} />
    </div>
  );
}

/** Shared press behaviour: fill and border change, never layout — a thumb
 *  must not make the page move. */
function usedPress() {
  const [pressed, setPressed] = useState(false);
  return {
    pressed,
    handlers: {
      onPointerDown: () => setPressed(true),
      onPointerUp: () => setPressed(false),
      onPointerLeave: () => setPressed(false),
      onPointerCancel: () => setPressed(false),
    },
  };
}

function Chevron({ size = 16 }: { size?: number }) {
  // "Forward in the book" points LEFT in an RTL layout, which is what
  // rtl-flip-x does to a directional glyph.
  return <Icon name="chevronR" size={size} className="rtl-flip-x" />;
}

function QuietRule({ theme, isMobile, nextNumber, nextTitle, onNext }: CardProps) {
  const { pressed, handlers } = usedPress();
  return (
    <button
      onClick={onNext}
      {...handlers}
      aria-label={`الفصل التالي: ${nextTitle}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        minHeight: isMobile ? 68 : 56,
        padding: isMobile ? "16px 6px" : "12px 4px",
        cursor: "pointer",
        font: "inherit",
        textAlign: "right",
        background: pressed ? theme.hover : "transparent",
        border: "none",
        borderTop: `1px solid ${theme.rule}`,
        borderBottom: `1px solid ${theme.rule}`,
        color: theme.ink,
        transition: "background 120ms ease-out",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            letterSpacing: "0.1em",
            color: theme.muted,
            fontFamily: FONT_STACKS.sans,
            marginBottom: 4,
          }}
        >
          {`الفصل ${nextNumber}`}
        </span>
        <span
          style={{
            display: "block",
            fontSize: isMobile ? 17 : 18,
            fontWeight: 600,
            fontFamily: FONT_STACKS[DEFAULT_TWEAKS.fontFamily],
          }}
        >
          {nextTitle}
        </span>
      </span>
      <span style={{ color: theme.muted, display: "inline-flex" }}>
        <Chevron size={18} />
      </span>
    </button>
  );
}

function FilledCard({ theme, isMobile, nextNumber, nextTitle, onNext }: CardProps) {
  const { pressed, handlers } = usedPress();
  return (
    <button
      onClick={onNext}
      {...handlers}
      aria-label={`الفصل التالي: ${nextTitle}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        minHeight: isMobile ? 76 : 64,
        padding: isMobile ? "18px 18px" : "18px 22px",
        borderRadius: 14,
        cursor: "pointer",
        font: "inherit",
        textAlign: "right",
        background: pressed ? theme.chromeHover : theme.chrome,
        border: `1px solid ${pressed ? theme.ruleStrong : theme.rule}`,
        color: theme.ink,
        transition: "background 120ms ease-out, border-color 120ms ease-out",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            letterSpacing: "0.1em",
            color: theme.muted,
            fontFamily: FONT_STACKS.sans,
            marginBottom: 6,
          }}
        >
          الفصل التالي
        </span>
        <span
          style={{
            display: "block",
            fontSize: isMobile ? 18 : 19,
            fontWeight: 600,
            fontFamily: FONT_STACKS[DEFAULT_TWEAKS.fontFamily],
          }}
        >
          {`${nextNumber}. ${nextTitle}`}
        </span>
      </span>
      <span style={{ color: theme.muted, display: "inline-flex" }}>
        <Chevron size={20} />
      </span>
    </button>
  );
}

function Prominent({ theme, isMobile, nextTitle, position, onNext }: CardProps) {
  const { pressed, handlers } = usedPress();
  return (
    <button
      onClick={onNext}
      {...handlers}
      aria-label={`الفصل التالي: ${nextTitle}`}
      style={{
        display: "block",
        width: "100%",
        padding: isMobile ? "26px 20px" : "32px 28px",
        borderRadius: 18,
        cursor: "pointer",
        font: "inherit",
        textAlign: "center",
        background: pressed ? theme.chromeHover : theme.chrome,
        border: `1px solid ${theme.rule}`,
        color: theme.ink,
        transition: "background 120ms ease-out",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: "0.12em",
          color: theme.muted,
          fontFamily: FONT_STACKS.sans,
          marginBottom: 10,
        }}
      >
        {`التالي · ${position}`}
      </div>
      <div
        style={{
          fontSize: isMobile ? 22 : 26,
          fontWeight: 600,
          lineHeight: 1.25,
          marginBottom: 18,
          fontFamily: FONT_STACKS[DEFAULT_TWEAKS.fontFamily],
        }}
      >
        {nextTitle}
      </div>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minHeight: 44,
          padding: "0 22px",
          borderRadius: 999,
          background: ACCENT,
          color: theme.bg,
          fontSize: 13.5,
          fontWeight: 600,
          fontFamily: FONT_STACKS.sans,
        }}
      >
        متابعة القراءة
        <Chevron size={16} />
      </span>
    </button>
  );
}

function Contextual(p: CardProps) {
  // The card itself is variant 2; this one adds the context row beneath it.
  const { theme, position, downloaded, onPrev } = p;
  return (
    <div>
      <FilledCard {...p} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 12,
          padding: "0 4px",
          fontFamily: FONT_STACKS.sans,
          fontSize: 11,
          color: theme.muted,
          minHeight: 44,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name={downloaded ? "check" : "downloadCirc"} size={13} />
          {downloaded ? "محفوظ على الجهاز" : "يتطلب اتصالاً"}
        </span>
        <span aria-hidden>·</span>
        <span>{position}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onPrev}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 44,
            padding: "0 10px",
            cursor: "pointer",
            font: "inherit",
            fontSize: 11,
            background: "transparent",
            border: "none",
            color: theme.muted,
          }}
        >
          <span style={{ display: "inline-flex", transform: "scaleX(-1)" }}>
            <Chevron size={13} />
          </span>
          الفصل السابق
        </button>
      </div>
    </div>
  );
}

// ── chrome ─────────────────────────────────────────────────────────────────

function Group({
  label,
  theme,
  children,
}: {
  label: string;
  theme: Theme;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: theme.muted,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function Row({
  theme,
  on,
  onClick,
  title,
  sub,
}: {
  theme: Theme;
  on: boolean;
  onClick: () => void;
  title: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        cursor: "pointer",
        padding: "9px 11px",
        borderRadius: 10,
        minHeight: 44,
        font: "inherit",
        color: on ? theme.bg : theme.ink,
        background: on ? ACCENT : "transparent",
        border: `1px solid ${on ? ACCENT : theme.rule}`,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 10.5, marginTop: 2, opacity: on ? 0.85 : 0.7 }}>{sub}</div>
    </button>
  );
}

function Chip({
  children,
  onClick,
  theme,
  on,
}: {
  children: React.ReactNode;
  onClick: () => void;
  theme: Theme;
  on: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: "pointer",
        font: "inherit",
        fontSize: 11.5,
        padding: "8px 11px",
        minHeight: 36,
        borderRadius: 8,
        color: on ? theme.bg : theme.ink,
        background: on ? ACCENT : theme.chromeHover,
        border: `1px solid ${on ? ACCENT : theme.rule}`,
      }}
    >
      {children}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
