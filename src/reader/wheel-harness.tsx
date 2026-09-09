// Dev-only rig for how the reading surface SCROLLS under a mouse wheel.
//
// The reader currently does nothing at all to wheel input — there is no
// smoothing and no `scroll-behavior` on the reading surface, so whatever the
// webview does natively is what the reader gets. Measured against the real
// line box (27.2px at fontSize 17 / lineHeight 1.6), the device in use
// produces:
//
//   12-13px per event when scrolling slowly   = 0.44-0.48 of a line
//   104-209px per event during a momentum burst, 17ms apart = 3.8-7.7 lines
//
// So slow scrolling leaves the text grid permanently misaligned — the top and
// bottom lines half-cut, the eye's anchor drifting by fractions of a line —
// while a flick moves 230-460 lines a second, which reads as a blur rather
// than as scrolling.
//
// Both are measurable, so this rig measures them rather than asking anyone to
// judge smoothness by eye:
//
//   align   mean distance from the viewport top to the nearest line boundary.
//           0 means the grid is locked to the viewport; ~6.8px is the average
//           you get from unquantised scrolling (a quarter of a line box).
//   px/frame  the largest single-frame jump, and the mean while moving. This
//           is the blur number.
//
// `?mode=native|snap|ease|both`, `?lines=<n>` per notch, `?theme=`.
// Open it at /wheel-harness.html.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import { ACCENT, FONT_STACKS, THEMES, type Theme, type ThemeKey } from "../styles/tokens";
import "../styles/global.css";

const PARA =
  "التقط فانغ يوان الثوب الأسود والجوارب التي غيّرها، ألم أقل ذلك من قبل، " +
  "سنذهب إلى جبل باي غو الآن. أما بالنسبة إلى غو اليانغ، فانتظر على الأقل " +
  "حتى أكون في الرتبة الثالثة أولاً، وحتى ذلك الحين لا تتحدث عن الأمر مع أحد.";

/** One chapter's worth, the shape of the real book. */
const PARAS = 107;

type Mode = "native" | "snap" | "ease" | "both";
type Platform = "desktop" | "mobile";

const MODES: { id: Mode; name: string; blurb: string }[] = [
  { id: "native", name: "1 · Native", blurb: "What the reader does today — nothing" },
  { id: "snap", name: "2 · Line-snapped", blurb: "Land on whole lines · no animation" },
  { id: "ease", name: "3 · Eased", blurb: "Glide to the target · no snapping" },
  { id: "both", name: "4 · Eased + snapped", blurb: "Glide, and land on a line" },
];

const params = new URLSearchParams(location.search);
const themeKey = (params.get("theme") ?? DEFAULT_TWEAKS.theme) as ThemeKey;
const initialMode = (params.get("mode") ?? "native") as Mode;
const initialLines = Number(params.get("lines") ?? 0); // 0 = use the device's own delta
const initialPlatform = (params.get("platform") ?? "desktop") as Platform;

/**
 * How fast the glide closes the gap, per frame. Exponential smoothing rather
 * than a fixed duration: it starts immediately (so it never feels laggy),
 * damps a momentum burst automatically, and has no end-of-animation stall to
 * fight when the next event arrives mid-glide.
 */
const EASE_PER_FRAME = 0.22;
/** Below this, snap the last fraction rather than crawling toward it. */
const SETTLE_PX = 0.5;

interface Metrics {
  events: number;
  frames: number;
  alignSum: number;
  alignMax: number;
  /** Alignment sampled only on frames where nothing moved — see below. */
  restSum: number;
  restFrames: number;
  moveSum: number;
  moveFrames: number;
  moveMax: number;
}

const ZERO: Metrics = {
  events: 0, frames: 0, alignSum: 0, alignMax: 0, restSum: 0, restFrames: 0,
  moveSum: 0, moveFrames: 0, moveMax: 0,
};

function Harness() {
  const theme = THEMES[themeKey] ?? THEMES.sepia;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [linesPerNotch, setLinesPerNotch] = useState(initialLines);
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  /**
   * Mobile's equivalent of line-snapping.
   *
   * A phone has no wheel, and touch scrolling belongs to the compositor —
   * intercepting it to ease by hand would fight the platform's own momentum
   * and lose. So the wheel path is desktop-only, and mobile instead waits for
   * the scroll to stop and then glides the last few pixels onto a line
   * boundary. Same benefit at rest, none of the interference.
   */
  const [settleSnap, setSettleSnap] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [scores, setScores] = useState<Record<string, Metrics>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [lineBox, setLineBox] = useState(27.2);

  // Measure the real line box from the rendered text, rather than recomputing
  // fontSize × lineHeight and hoping the two agree.
  useEffect(() => {
    const p = bodyRef.current?.querySelector("p");
    if (!p) return;
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    if (Number.isFinite(lh) && lh > 0) setLineBox(lh);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const isMobile = platform === "mobile";
  /** Whether anything should be animating the scroll position right now. */
  const glide = isMobile ? settleSnap : mode === "ease" || mode === "both";
  const target = useRef(0);
  /**
   * Sub-line travel not yet spent, in px.
   *
   * Quantising each event independently does not work: this machine's slow
   * scroll is 13px, which rounds to zero whole lines, and because the glide
   * keeps the frame loop alive the next event rounds from the same unmoved
   * target — so it rounds to zero again, for ever. Measured: twelve slow
   * notches moved the page 0px where native moved 156px. Banking the
   * remainder instead preserves the device's total travel exactly while only
   * ever coming to rest on a line boundary.
   */
  const bank = useRef(0);
  const raf = useRef(0);
  const lastTop = useRef(0);
  const metrics = useRef<Metrics>({ ...ZERO });
  const idleFrames = useRef(0);

  const flush = useCallback(() => {
    setScores((prev) => ({ ...prev, [mode]: { ...metrics.current } }));
  }, [mode]);

  /** Sample alignment and per-frame movement. Runs while anything is moving. */
  const sample = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const m = metrics.current;
    const moved = Math.abs(el.scrollTop - lastTop.current);
    lastTop.current = el.scrollTop;
    m.frames += 1;
    // Distance from the viewport's top edge to the nearest line boundary.
    const frac = el.scrollTop % lineBox;
    const err = Math.min(frac, lineBox - frac);
    m.alignSum += err;
    m.alignMax = Math.max(m.alignMax, err);
    if (moved > 0.5) {
      m.moveSum += moved;
      m.moveFrames += 1;
      m.moveMax = Math.max(m.moveMax, moved);
      idleFrames.current = 0;
    } else {
      // Alignment AT REST is the number that matters: the reader reads where
      // the text stops, not where it passes. Averaging every frame instead
      // punishes the glide for its mid-flight frames — it scored a snapped
      // glide WORSE than doing nothing (10.7px against 8.6px) while the text
      // was in fact coming to rest exactly on a line.
      m.restSum += err;
      m.restFrames += 1;
      idleFrames.current += 1;
    }
  }, [lineBox]);

  // The glide. One loop drives both the animation and the sampling, so a
  // frame is never counted twice or missed.
  const pump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      raf.current = 0;
      return;
    }
    if (glide) {
      const gap = target.current - el.scrollTop;
      if (Math.abs(gap) > SETTLE_PX) {
        el.scrollTop += reduced ? gap : gap * EASE_PER_FRAME;
      } else if (gap !== 0) {
        el.scrollTop = target.current;
      }
    }
    sample();
    // Keep the loop alive briefly after movement stops, so the tail of a
    // gesture is measured too, then stand down.
    if (idleFrames.current > 30) {
      raf.current = 0;
      flush();
      return;
    }
    raf.current = requestAnimationFrame(pump);
  }, [glide, reduced, sample, flush]);

  const wake = useCallback(() => {
    idleFrames.current = 0;
    if (!raf.current) raf.current = requestAnimationFrame(pump);
  }, [pump]);

  const wakeRef = useRef(wake);
  wakeRef.current = wake;

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  /**
   * Mobile: settle onto a line once the fling has finished.
   *
   * Nothing intercepts touch — the scroll is entirely the platform's, momentum
   * included — so the only addition is a short glide onto the nearest line
   * boundary after the scrolling stops. Same benefit at rest as the desktop
   * snap, without fighting the compositor for the gesture.
   */
  useEffect(() => {
    if (!isMobile || !settleSnap) return;
    const el = scrollRef.current;
    if (!el) return;
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      // Long enough that the platform's own fling has ended; snapping into a
      // live momentum scroll would feel like a snag.
      timer = window.setTimeout(() => {
        const frac = el.scrollTop % lineBox;
        const delta = frac < lineBox / 2 ? -frac : lineBox - frac;
        if (Math.abs(delta) < 0.5) return;
        const max = el.scrollHeight - el.clientHeight;
        target.current = Math.max(0, Math.min(max, el.scrollTop + delta));
        wakeRef.current();
      }, 160);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [isMobile, settleSnap, lineBox]);

  // Reset per mode so each is measured over its own session.
  useEffect(() => {
    metrics.current = { ...ZERO };
    bank.current = 0;
    const el = scrollRef.current;
    if (el) {
      target.current = el.scrollTop;
      lastTop.current = el.scrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, linesPerNotch]);

  useEffect(() => {
    // Desktop only. A phone delivers no wheel events, and attaching a
    // non-passive listener that calls preventDefault to a touch surface is
    // how you break momentum scrolling — so there is nothing here to attach.
    if (isMobile) return;
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      metrics.current.events += 1;
      if (mode === "native") {
        // Leave it entirely alone — this is the baseline.
        wake();
        return;
      }
      e.preventDefault();

      // Normalise the device's delta into pixels, then optionally into a fixed
      // number of lines so slow and fast events move a predictable amount.
      const px =
        e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const step =
        linesPerNotch > 0 ? Math.sign(px) * linesPerNotch * lineBox : px;

      const max = el.scrollHeight - el.clientHeight;
      const clamp = (v: number) => Math.max(0, Math.min(max, v));

      /** Whole lines the bank can pay for, keeping the remainder. */
      const wholeLines = (raw: number) => {
        bank.current += raw;
        const lines = Math.trunc(bank.current / lineBox);
        bank.current -= lines * lineBox;
        return lines * lineBox;
      };

      if (mode === "snap") {
        // No animation: move whole lines only, and go straight there.
        const move = wholeLines(step);
        if (move !== 0) el.scrollTop = clamp(el.scrollTop + move);
        wake();
        return;
      }
      // Eased modes accumulate a target, so a burst becomes one glide rather
      // than a series of jumps.
      const base = raf.current ? target.current : el.scrollTop;
      const move = mode === "both" ? wholeLines(step) : step;
      const next = clamp(base + move);
      // At the document ends the move is clipped; drop the bank rather than
      // letting unspent travel pile up and lurch when the reader turns round.
      if (next === base && move !== 0) bank.current = 0;
      target.current = next;
      wake();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isMobile, mode, linesPerNotch, lineBox, wake]);

  const mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

  const grid = useMemo(() => {
    if (!showGrid) return null;
    // Guides on the LINE grid, so misalignment is visible and not just a
    // number: with snapping on, text sits between them and stays there.
    return (
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          backgroundImage: `repeating-linear-gradient(
            to bottom,
            ${ACCENT}33 0px, ${ACCENT}33 1px,
            transparent 1px, transparent ${lineBox}px)`,
        }}
      />
    );
  }, [showGrid, lineBox]);

  return (
    <div style={{ display: "flex", height: "100%", background: theme.bg, color: theme.ink, fontFamily: FONT_STACKS.sans }}>
      <div
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          display: isMobile ? "flex" : "block",
          alignItems: "center",
          justifyContent: "center",
          padding: isMobile ? 24 : 0,
        }}
      >
        <div
          style={
            isMobile
              ? {
                  position: "relative",
                  width: 390,
                  height: 780,
                  borderRadius: 34,
                  overflow: "hidden",
                  border: `1px solid ${theme.ruleStrong}`,
                  boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
                }
              : { position: "relative", height: "100%" }
          }
        >
        <div
          ref={scrollRef}
          className="no-scrollbar"
          style={{
            height: "100%",
            overflowY: "auto",
            overscrollBehavior: "contain",
            direction: "rtl",
            background: theme.paper,
          }}
        >
          <div
            ref={bodyRef}
            style={{
              maxWidth: 660,
              margin: "0 auto",
              padding: "56px 40px 96px",
              fontFamily: FONT_STACKS[DEFAULT_TWEAKS.fontFamily],
              fontSize: DEFAULT_TWEAKS.fontSize,
              lineHeight: DEFAULT_TWEAKS.lineHeight,
              textAlign: "right",
            }}
          >
            {Array.from({ length: PARAS }, (_, i) => (
              <p key={i} style={{ margin: `0 0 ${DEFAULT_TWEAKS.paragraphSpacing}em` }}>
                {PARA}
              </p>
            ))}
          </div>
        </div>
        {grid}
        </div>
      </div>

      <aside
        style={{
          width: 356,
          flexShrink: 0,
          borderInlineStart: `1px solid ${theme.ruleStrong}`,
          background: theme.chrome,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          direction: "ltr",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Wheel scrolling</div>
          <div style={{ fontSize: 11, color: theme.muted, marginTop: 3, lineHeight: 1.5 }}>
            {`Scroll the page with your own wheel. Line box is ${lineBox.toFixed(1)}px.`}
          </div>
        </div>

        {isMobile ? (
          <div style={{ fontSize: 11, color: theme.muted, lineHeight: 1.5 }}>
            The four wheel modes below apply to desktop only, and are inert here.
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, opacity: isMobile ? 0.4 : 1 }}>
          {MODES.map((m) => {
            const on = m.id === mode;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                style={{
                  textAlign: "left", cursor: "pointer", padding: "9px 11px",
                  borderRadius: 10, minHeight: 44, font: "inherit",
                  color: on ? theme.bg : theme.ink,
                  background: on ? ACCENT : "transparent",
                  border: `1px solid ${on ? ACCENT : theme.rule}`,
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.name}</div>
                <div style={{ fontSize: 10.5, marginTop: 2, opacity: on ? 0.85 : 0.7 }}>{m.blurb}</div>
              </button>
            );
          })}
        </div>

        <div>
          <Label theme={theme}>Platform</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {(["desktop", "mobile"] as Platform[]).map((pf) => (
              <Chip key={pf} theme={theme} on={platform === pf} onClick={() => setPlatform(pf)}>
                {pf}
              </Chip>
            ))}
          </div>
          {isMobile ? (
            <>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <Chip theme={theme} on={settleSnap} onClick={() => setSettleSnap((v) => !v)}>
                  settle onto a line
                </Chip>
              </div>
              <div style={{ fontSize: 10.5, color: theme.muted, marginTop: 6, lineHeight: 1.5 }}>
                No wheel listener is attached on mobile at all — touch scrolling stays the
                platform's, momentum included. The only thing added is a glide onto the nearest
                line once the fling has stopped.
              </div>
            </>
          ) : null}
        </div>

        <div>
          <Label theme={theme}>Lines per notch</Label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[0, 2, 3, 4].map((n) => (
              <Chip key={n} theme={theme} on={linesPerNotch === n} onClick={() => setLinesPerNotch(n)}>
                {n === 0 ? "device" : `${n} lines`}
              </Chip>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: theme.muted, marginTop: 6, lineHeight: 1.5 }}>
            "device" passes the raw delta through — which is 0.44 of a line on
            this machine's slow scroll, and 7.7 on a flick.
          </div>
        </div>

        <div>
          <Label theme={theme}>Measured</Label>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead>
              <tr style={{ color: theme.muted, textAlign: "right" }}>
                <th style={{ fontWeight: 500, textAlign: "left" }}>Mode</th>
                <th style={{ fontWeight: 500 }}>rest</th>
                <th style={{ fontWeight: 500 }}>align</th>
                <th style={{ fontWeight: 500 }}>px/frame</th>
                <th style={{ fontWeight: 500 }}>worst</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: mono }}>
              {MODES.map((m) => {
                const s = scores[m.id] ?? (m.id === mode ? metrics.current : ZERO);
                const align = s.frames ? s.alignSum / s.frames : 0;
                const rest = s.restFrames ? s.restSum / s.restFrames : 0;
                const perFrame = s.moveFrames ? s.moveSum / s.moveFrames : 0;
                return (
                  <tr key={m.id} style={{ borderTop: `1px solid ${theme.rule}`, opacity: m.id === mode ? 1 : 0.6 }}>
                    <td style={{ padding: "5px 0", fontFamily: FONT_STACKS.sans }}>
                      {m.name.replace(/^\d+ · /, "")}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{rest.toFixed(1)}</td>
                    <td style={{ textAlign: "right", opacity: 0.6 }}>{align.toFixed(1)}</td>
                    <td style={{ textAlign: "right" }}>{perFrame.toFixed(0)}</td>
                    <td style={{ textAlign: "right" }}>{s.moveMax.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 10.5, color: theme.muted, marginTop: 8, lineHeight: 1.55 }}>
            <b>rest</b> — px from the viewport top to the nearest line boundary once
            scrolling has STOPPED. This is the one that matters: you read where the text
            settles. <b>align</b> — the same thing averaged over every frame, mid-glide
            included, which is why it flatters standing still. <b>px/frame</b> and{" "}
            <b>worst</b> — how far the text moves in one frame; above ~{(lineBox * 3).toFixed(0)}px
            it reads as a blur.
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip theme={theme} on={showGrid} onClick={() => setShowGrid((v) => !v)}>
            line grid
          </Chip>
          <Chip theme={theme} on={false} onClick={() => { setScores({}); metrics.current = { ...ZERO }; }}>
            reset
          </Chip>
        </div>

        {reduced ? (
          <div style={{ fontSize: 10.5, color: theme.muted, lineHeight: 1.5 }}>
            Reduced motion is on in the OS, so the eased modes jump to the target
            instead of gliding — deliberately.
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function Label({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  return (
    <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: theme.muted, marginBottom: 8 }}>
      {children}
    </div>
  );
}

function Chip({
  children, onClick, theme, on,
}: { children: React.ReactNode; onClick: () => void; theme: Theme; on: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: "pointer", font: "inherit", fontSize: 11.5, padding: "8px 11px",
        minHeight: 36, borderRadius: 8,
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
