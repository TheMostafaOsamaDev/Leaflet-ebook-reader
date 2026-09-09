// Dev-only rig for the DESKTOP reader's mouse-wheel behaviour at a chapter
// boundary in scroll mode.
//
// Why it exists: a single wheel spin can advance three chapters, because the
// flip commits mid-gesture and a chapter shorter than the viewport is already
// at its own bottom the moment it mounts. Judging a fix by feel alone is not
// enough — the whole failure lives in timing you cannot see — so this rig
// pairs a real scrollable reader with a scoreboard that counts the thing that
// actually went wrong: flips landing so soon after the last one that no human
// asked for them.
//
// The fixture is deliberately pathological: a long chapter followed by a run
// of chapters too short to scroll, which is exactly the shape that chains.
//
// `?theme=light|sepia|dark|oled` picks the theme. `?engine=<id>` preselects a
// candidate. Keys 1-4 switch candidates without losing the scoreboard.
//
// Nothing here is imported by the app. Open it at /scroll-harness.html.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ENGINES,
  type EngineId,
  type Edges,
  type Intent,
  type WheelEngine,
} from "./scroll/wheelBoundary";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import { FONT_STACKS, THEMES, ACCENT, type ThemeKey } from "../styles/tokens";
import "../styles/global.css";

// Arabic body text, so the scroll distances are the ones the real reader
// produces — Latin at the same size covers far fewer lines per paragraph, and
// line count is what decides whether a chapter fits the viewport.
const PARA =
  "التقط فانغ يوان الثوب الأسود والجوارب التي غيّرها، ألم أقل ذلك من قبل، " +
  "سنذهب إلى جبل باي غو الآن. أما بالنسبة إلى غو اليانغ، فانتظر على الأقل " +
  "حتى أكون في الرتبة الثالثة أولاً، وحتى ذلك الحين لا تتحدث عن الأمر مع أحد.";

const AR_NUM = ["١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩", "١٠"];

/**
 * Chapter lengths in viewport-screens. Anything under 1.0 cannot scroll at
 * all, so it satisfies the at-bottom test at scrollTop 0 — the run of them in
 * the middle is the trap.
 */
const SHAPE = [3.0, 0.4, 0.3, 0.8, 2.0, 0.35, 0.5, 4.0, 0.25, 1.5];

interface Chapter {
  title: string;
  screens: number;
  paragraphs: string[];
}

/** ~9 paragraphs of the fixture text fill one 720px-ish viewport at 17px. */
const PARAS_PER_SCREEN = 9;

function makeChapters(): Chapter[] {
  return SHAPE.map((screens, i) => ({
    title: `الفصل ${AR_NUM[i] ?? i + 1}`,
    screens,
    paragraphs: Array.from(
      { length: Math.max(1, Math.round(screens * PARAS_PER_SCREEN)) },
      () => PARA,
    ),
  }));
}

interface Score {
  /** Chapter changes the engine committed. */
  flips: number;
  /** Flips landing under 400ms after the previous one — the bug signature. */
  accidental: number;
  /** Most flips the engine ever committed inside one continuous gesture. */
  worstGesture: number;
}

const ZERO: Score = { flips: 0, accidental: 0, worstGesture: 0 };

interface TraceRow {
  seq: number;
  delta: number;
  note: string;
  flip: boolean;
}

const params = new URLSearchParams(location.search);
const themeKey = (params.get("theme") ?? DEFAULT_TWEAKS.theme) as ThemeKey;
const initialEngine = (params.get("engine") ?? "baseline") as EngineId;

/**
 * A gesture is over once the wheel has been silent this long. Deliberately
 * generous: a reader turning a mouse wheel steadily but slowly leaves ~250ms
 * between notches and is plainly still performing ONE gesture. At the 200ms
 * this started out as, a slow continuous spin scored as several separate
 * gestures and today's behaviour looked innocent while eating three chapters.
 */
const GESTURE_GAP_MS = 450;
/** No reader asks for two chapter turns closer together than this. */
const ACCIDENTAL_MS = 600;

function readEdges(el: HTMLElement, chapter: number, total: number): Edges {
  return {
    // Sub-pixel rounding tolerance, matching DesktopReader.
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 1,
    atTop: el.scrollTop <= 1,
    canPrev: chapter > 0,
    canNext: chapter < total - 1,
  };
}

function Harness() {
  const theme = THEMES[themeKey] ?? THEMES.sepia;
  const chapters = useMemo(makeChapters, []);
  const [engineId, setEngineId] = useState<EngineId>(initialEngine);
  const [chapter, setChapter] = useState(0);
  const [scores, setScores] = useState<Record<string, Score>>({});
  const [trace, setTrace] = useState<TraceRow[]>([]);
  const [edgeUi, setEdgeUi] = useState<{
    dir: "down" | "up";
    pct: number;
    settle: boolean;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pullRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WheelEngine | null>(null);
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;

  // Scoring state, kept in refs so counting never re-renders mid-gesture.
  const lastFlipAt = useRef(0);
  const lastEventAt = useRef(0);
  const flipsThisGesture = useRef(0);
  // Where to land after a flip: bottom when the user went backwards, so
  // reading continues upward the way DesktopReader's landAtEnd does.
  const landAtEnd = useRef(false);

  // Trace is buffered and flushed on a frame — a wheel spin fires far faster
  // than it is worth re-rendering a list at.
  const traceBuf = useRef<TraceRow[]>([]);
  const traceSeq = useRef(0);
  const traceRaf = useRef(0);

  const spec = ENGINES.find((e) => e.id === engineId) ?? ENGINES[0];

  // Rebuild the engine whenever the candidate changes. Scores survive, so
  // switching mid-session compares like with like.
  useEffect(() => {
    engineRef.current = spec.create();
    setEdgeUi(null);
    if (pullRef.current) pullRef.current.style.transform = "translateY(0px)";
    return () => {
      engineRef.current = null;
    };
  }, [spec]);

  const pushTrace = useCallback((row: Omit<TraceRow, "seq">) => {
    traceSeq.current += 1;
    traceBuf.current = [{ ...row, seq: traceSeq.current }, ...traceBuf.current].slice(0, 16);
    if (traceRaf.current) return;
    traceRaf.current = window.requestAnimationFrame(() => {
      traceRaf.current = 0;
      setTrace(traceBuf.current);
    });
  }, []);

  const bump = useCallback((id: EngineId, patch: (s: Score) => Score) => {
    setScores((prev) => ({ ...prev, [id]: patch(prev[id] ?? ZERO) }));
  }, []);

  /** Apply an engine intent to the DOM and the scoreboard. */
  const apply = useCallback(
    (intent: Intent, now: number, deltaForTrace: number | null) => {
      if (pullRef.current) {
        const signed = intent.dir === "up" ? intent.pull : -intent.pull;
        pullRef.current.style.transition = intent.settle
          ? "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)"
          : "none";
        pullRef.current.style.transform = `translateY(${signed}px)`;
      }
      setEdgeUi(
        intent.dir && (intent.pct > 0 || intent.pull > 0)
          ? { dir: intent.dir, pct: intent.pct, settle: intent.settle }
          : null,
      );

      if (deltaForTrace !== null || intent.flip || intent.note !== "scrolling") {
        pushTrace({
          delta: deltaForTrace ?? 0,
          note: intent.note,
          flip: Boolean(intent.flip),
        });
      }

      if (!intent.flip) return;

      const gap = lastFlipAt.current ? now - lastFlipAt.current : Infinity;
      lastFlipAt.current = now;
      flipsThisGesture.current += 1;
      const inGesture = flipsThisGesture.current;
      bump(engineId, (s) => ({
        flips: s.flips + 1,
        accidental: s.accidental + (gap < ACCIDENTAL_MS ? 1 : 0),
        worstGesture: Math.max(s.worstGesture, inGesture),
      }));

      landAtEnd.current = intent.flip === "up";
      setChapter((c) => {
        const next = intent.flip === "down" ? c + 1 : c - 1;
        return Math.max(0, Math.min(chapters.length - 1, next));
      });
      engineRef.current?.didFlip(now);
    },
    [bump, chapters.length, engineId, pushTrace],
  );

  // The wheel listener has to be non-passive to hold the browser's own bounce
  // while the engine decides whether this gesture is a chapter turn.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      const now = performance.now();
      if (now - lastEventAt.current > GESTURE_GAP_MS) flipsThisGesture.current = 0;
      lastEventAt.current = now;
      const intent = engine.onWheel(
        { deltaY: e.deltaY, t: now },
        readEdges(el, chapterRef.current, chapters.length),
      );
      if (intent.preventDefault) e.preventDefault();
      apply(intent, now, e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, chapters.length]);

  // Idle pump. Release-on-commit and the lockout release both need a clock of
  // their own; rAF is what the reader already uses for scroll-driven paint.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = window.requestAnimationFrame(loop);
      const el = scrollRef.current;
      const engine = engineRef.current;
      if (!el || !engine) return;
      const now = performance.now();
      const intent = engine.tick(now, readEdges(el, chapterRef.current, chapters.length));
      if (intent) apply(intent, now, null);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [apply, chapters.length]);

  // Land in the new chapter the way the real reader does.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = landAtEnd.current ? el.scrollHeight : 0;
    landAtEnd.current = false;
  }, [chapter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const idx = Number(e.key);
      if (idx >= 1 && idx <= ENGINES.length) setEngineId(ENGINES[idx - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Replay a scripted gesture through the live pane. Hand-feel is the point of
   * this rig, but hand-feel is not repeatable — a scripted spin is, so the
   * scoreboard numbers mean the same thing for every candidate.
   */
  const replay = useCallback(
    (label: string, notches: number, gapMs: number, notch: number) => {
      const el = scrollRef.current;
      if (!el) return;
      setChapter(0);
      // Start a couple of notches ABOVE the bottom of the long first chapter,
      // not pinned to it. The run-up matters: the velocity-aware candidate
      // sizes its threshold from how fast the wheel was already moving when it
      // reached the edge, so teleporting to the boundary hands it no history
      // and flatters it into behaving like a fixed 150px threshold.
      window.setTimeout(() => {
        const runUp = 2;
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - notch * runUp);
        pushTrace({ delta: 0, note: `▶ replay: ${label}`, flip: false });
        let i = 0;
        const total = notches + runUp;
        const step = () => {
          const engine = engineRef.current;
          if (!engine || i >= total) return;
          i += 1;
          const now = performance.now();
          if (now - lastEventAt.current > GESTURE_GAP_MS) flipsThisGesture.current = 0;
          lastEventAt.current = now;
          const intent = engine.onWheel(
            { deltaY: notch, t: now },
            readEdges(el, chapterRef.current, chapters.length),
          );
          // A real event the engine let through would have scrolled the pane;
          // a synthetic one has to do it by hand.
          if (!intent.preventDefault) el.scrollTop += notch;
          apply(intent, now, notch);
          window.setTimeout(step, gapMs);
        };
        step();
      }, 60);
    },
    [apply, chapters.length, pushTrace],
  );

  const reset = useCallback(() => {
    setScores({});
    setTrace([]);
    traceBuf.current = [];
    lastFlipAt.current = 0;
    flipsThisGesture.current = 0;
    setChapter(0);
    engineRef.current = spec.create();
  }, [spec]);

  const ch = chapters[chapter];
  const mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
  const ui = FONT_STACKS.sans;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        fontFamily: ui,
      }}
    >
      {/* ---------- reading pane ---------- */}
      <div style={{ position: "relative", flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div
          ref={scrollRef}
          style={{
            height: "100%",
            overflowY: "auto",
            overscrollBehavior: "contain",
            direction: "rtl",
          }}
        >
          <div ref={pullRef} style={{ willChange: "transform" }}>
            <div
              style={{
                maxWidth: 660,
                margin: "0 auto",
                padding: "56px 40px 72px",
                fontFamily: FONT_STACKS[DEFAULT_TWEAKS.fontFamily],
                fontSize: DEFAULT_TWEAKS.fontSize,
                lineHeight: DEFAULT_TWEAKS.lineHeight,
                textAlign: "right",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  color: theme.muted,
                  marginBottom: 8,
                  fontFamily: ui,
                }}
              >
                {`الفصل ${chapter + 1} من ${chapters.length}`}
                {ch.screens < 1 ? " · أقصر من الشاشة" : ""}
              </div>
              <h1 style={{ fontSize: 30, margin: "0 0 28px", fontWeight: 600 }}>
                {ch.title}
              </h1>
              {ch.paragraphs.map((p, i) => (
                <p key={i} style={{ margin: `0 0 ${DEFAULT_TWEAKS.paragraphSpacing}em` }}>
                  {p}
                </p>
              ))}
            </div>
          </div>
        </div>

        {/* Edge indicator. Same job as the pill DesktopReader shows today,
            but it also has to read correctly for the pull-and-release
            candidate, where the label changes at the commit line. */}
        {edgeUi ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              [edgeUi.dir === "down" ? "bottom" : "top"]: 0,
              padding: "14px 0",
              display: "flex",
              justifyContent: "center",
              pointerEvents: "none",
              background:
                edgeUi.dir === "down"
                  ? `linear-gradient(to top, ${theme.bg}, transparent)`
                  : `linear-gradient(to bottom, ${theme.bg}, transparent)`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 14px",
                borderRadius: 999,
                background: theme.chrome,
                border: `1px solid ${theme.rule}`,
                fontSize: 12,
                color: theme.chromeInk,
                transition: edgeUi.settle ? "opacity 200ms ease-out" : "none",
              }}
            >
              <span
                style={{
                  width: 68,
                  height: 4,
                  borderRadius: 2,
                  background: theme.rule,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${Math.round(edgeUi.pct * 100)}%`,
                    background: edgeUi.pct >= 1 ? ACCENT : theme.chromeInk,
                    transition: edgeUi.settle ? "width 200ms ease-out" : "none",
                  }}
                />
              </span>
              {edgeUi.pct >= 1
                ? engineId === "rubberband"
                  ? "Let go to turn"
                  : "Turning…"
                : engineId === "rubberband"
                  ? "Keep pulling"
                  : "Keep scrolling to turn"}
            </div>
          </div>
        ) : null}
      </div>

      {/* ---------- instruments ---------- */}
      <aside
        style={{
          width: 372,
          flexShrink: 0,
          borderInlineStart: `1px solid ${theme.ruleStrong}`,
          background: theme.chrome,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          direction: "ltr",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Wheel at the chapter edge</div>
          <div style={{ fontSize: 11, color: theme.muted, marginTop: 2 }}>
            Scroll the pane with your own wheel. Keys 1-4 switch candidates.
          </div>
        </div>

        {/* Candidate picker */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ENGINES.map((e, i) => {
            const on = e.id === engineId;
            return (
              <button
                key={e.id}
                onClick={() => setEngineId(e.id)}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  padding: "10px 12px",
                  borderRadius: 10,
                  minHeight: 44,
                  font: "inherit",
                  color: on ? theme.bg : theme.ink,
                  background: on ? ACCENT : "transparent",
                  border: `1px solid ${on ? ACCENT : theme.rule}`,
                  transition: "background 150ms ease-out, color 150ms ease-out",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: mono, fontSize: 10, opacity: 0.7 }}>
                    {i + 1}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{e.name}</span>
                </div>
                <div style={{ fontSize: 11, marginTop: 3, opacity: on ? 0.85 : 0.7 }}>
                  {e.tagline}
                </div>
              </button>
            );
          })}
        </div>

        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            lineHeight: 1.55,
            color: theme.muted,
            borderInlineStart: `2px solid ${theme.rule}`,
            paddingInlineStart: 10,
          }}
        >
          {spec.detail}
        </p>

        {/* Scoreboard — every candidate, so switching compares like with like */}
        <div>
          <SectionLabel theme={theme}>Scoreboard</SectionLabel>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead>
              <tr style={{ color: theme.muted, textAlign: "left" }}>
                <th style={{ fontWeight: 500, padding: "4px 0" }}>Candidate</th>
                <th style={{ fontWeight: 500, padding: "4px 0", textAlign: "right" }}>
                  Turns
                </th>
                <th style={{ fontWeight: 500, padding: "4px 0", textAlign: "right" }}>
                  Skips
                </th>
                <th style={{ fontWeight: 500, padding: "4px 0", textAlign: "right" }}>
                  Worst
                </th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: mono }}>
              {ENGINES.map((e) => {
                const s = scores[e.id] ?? ZERO;
                const bad = s.accidental > 0;
                return (
                  <tr
                    key={e.id}
                    style={{
                      borderTop: `1px solid ${theme.rule}`,
                      opacity: e.id === engineId ? 1 : 0.62,
                    }}
                  >
                    <td style={{ padding: "5px 0", fontFamily: ui }}>{e.name}</td>
                    <td style={{ padding: "5px 0", textAlign: "right" }}>{s.flips}</td>
                    <td
                      style={{
                        padding: "5px 0",
                        textAlign: "right",
                        color: bad ? theme.danger : theme.muted,
                        fontWeight: bad ? 700 : 400,
                      }}
                    >
                      {s.accidental}
                    </td>
                    <td style={{ padding: "5px 0", textAlign: "right" }}>
                      {s.worstGesture}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 10.5, color: theme.muted, marginTop: 6, lineHeight: 1.5 }}>
            <b>Skips</b> counts turns landing under {ACCIDENTAL_MS}ms after the last one —
            the ones nobody asked for. <b>Worst</b> is the most turns ever committed inside
            one unbroken gesture; anything above 1 is the bug.
          </div>
        </div>

        {/* Scripted gestures, so the numbers are reproducible */}
        <div>
          <SectionLabel theme={theme}>Replay a gesture</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Chip theme={theme} onClick={() => replay("flick · 4 notches", 4, 60, 110)}>
              Flick
            </Chip>
            <Chip theme={theme} onClick={() => replay("long spin · 14 notches", 14, 50, 110)}>
              Long spin
            </Chip>
            <Chip theme={theme} onClick={() => replay("hard flick · 12 × 160px", 12, 35, 160)}>
              Hard flick
            </Chip>
            <Chip theme={theme} onClick={() => replay("slow push · 6 notches", 6, 250, 110)}>
              Slow push
            </Chip>
            <Chip theme={theme} onClick={reset}>
              Reset scores
            </Chip>
          </div>
        </div>

        {/* Chapter map — shows where the trap is */}
        <div>
          <SectionLabel theme={theme}>Fixture</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {chapters.map((c, i) => {
              const on = i === chapter;
              const short = c.screens < 1;
              return (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5 }}
                >
                  <span
                    style={{
                      width: 16,
                      textAlign: "right",
                      fontFamily: mono,
                      color: on ? ACCENT : theme.muted,
                      fontWeight: on ? 700 : 400,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      height: 8,
                      width: `${(c.screens / 4) * 210}px`,
                      minWidth: 4,
                      borderRadius: 2,
                      background: on ? ACCENT : short ? theme.danger : theme.ruleStrong,
                      opacity: on ? 1 : short ? 0.55 : 1,
                    }}
                  />
                  <span style={{ color: theme.muted, fontFamily: mono }}>
                    {c.screens.toFixed(2)} screens
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 10.5, color: theme.muted, marginTop: 6, lineHeight: 1.5 }}>
            Bars in <span style={{ color: theme.danger }}>red</span> are shorter than the
            viewport: they cannot scroll, so they report at-bottom the instant they mount.
          </div>
        </div>

        {/* Live decisions */}
        <div style={{ minHeight: 0 }}>
          <SectionLabel theme={theme}>What the engine decided</SectionLabel>
          <div style={{ fontFamily: mono, fontSize: 10.5, lineHeight: 1.65 }}>
            {trace.length === 0 ? (
              <div style={{ color: theme.muted }}>Scroll the pane to see decisions.</div>
            ) : (
              trace.map((r) => (
                <div
                  key={r.seq}
                  style={{
                    display: "flex",
                    gap: 8,
                    color: r.flip ? ACCENT : theme.muted,
                    fontWeight: r.flip ? 700 : 400,
                  }}
                >
                  <span style={{ width: 40, flexShrink: 0, textAlign: "right" }}>
                    {r.delta ? `${r.delta > 0 ? "+" : ""}${Math.round(r.delta)}` : "—"}
                  </span>
                  <span>{r.note}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function SectionLabel({
  children,
  theme,
}: {
  children: React.ReactNode;
  theme: (typeof THEMES)[ThemeKey];
}) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: theme.muted,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function Chip({
  children,
  onClick,
  theme,
}: {
  children: React.ReactNode;
  onClick: () => void;
  theme: (typeof THEMES)[ThemeKey];
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
        color: theme.ink,
        background: theme.chromeHover,
        border: `1px solid ${theme.rule}`,
      }}
    >
      {children}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
