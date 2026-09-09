// Dev-only rig for how the reader should move between chapters.
//
// The question it exists to answer: the chapter boundary is currently a mode
// switch. Reading is one gesture repeated ~99 times (a chapter in the open
// book is ~14 viewport-heights), and then the boundary demands a DIFFERENT
// gesture with a threshold, an arming pill and a 400ms lockout. Loosening that
// threshold brings back the accidental three-chapter skips it was added to
// stop — friction and skip-safety are the same knob, which is the sign that
// the knob is the wrong design.
//
// So four models are mounted over one identical fixture, driven with a real
// wheel, and measured:
//
//   push    — today. A deliberate push past the edge swaps the chapter.
//             Uses the REAL velocityEngine, not an imitation of it.
//   card    — discrete, but the turn is a visible card at the chapter's end.
//             One notch past it, a click, or Space turns. No lockout.
//   append  — the next chapter is appended below as you approach the end.
//             Forward never has a boundary; backward still jumps.
//   stream  — a window of chapters in one scroller, both directions. Chapter
//             identity is OBSERVED from what is on screen, never commanded.
//
// The scoreboard measures input that bought nothing, because that is what
// "inefficient" means here and it is not a matter of opinion:
//
//   wasted notches — wheel events after which nothing moved and no chapter
//                    turned (threshold arming, lockout, waiting on a fetch)
//   dead ms        — time spent scrolling with no reading progress
//   flow breaks    — turns that needed something other than continuing to
//                    scroll the same way
//   skips          — turns landing under 600ms apart. Must stay 0, or the fix
//                    that stopped one spin eating three chapters is undone.
//   mounted paras  — the DOM cost, so `stream`'s price is visible too.
//
// `?model=push|card|append|stream`, `?latency=<ms>`, `?theme=`.
// Open it at /nav-harness.html.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { velocityEngine, type WheelEngine } from "./scroll/wheelBoundary";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import { ACCENT, FONT_STACKS, THEMES, type ThemeKey } from "../styles/tokens";
import "../styles/global.css";

const PARA =
  "التقط فانغ يوان الثوب الأسود والجوارب التي غيّرها، ألم أقل ذلك من قبل، " +
  "سنذهب إلى جبل باي غو الآن. أما بالنسبة إلى غو اليانغ، فانتظر على الأقل " +
  "حتى أكون في الرتبة الثالثة أولاً، وحتى ذلك الحين لا تتحدث عن الأمر مع أحد.";

/** The real book's shape, from the reader's own log: 2372 chapters, ~107
 *  paragraphs each, which is about 14 viewport-heights at this font size. */
const CHAPTER_COUNT = 2372;
const PARAS_PER_CHAPTER = 107;
const START_CHAPTER = 227;

type Model = "push" | "card" | "append" | "stream";

const MODELS: { id: Model; name: string; blurb: string }[] = [
  {
    id: "push",
    name: "1 · Today",
    blurb: "Deliberate wheel push past the edge · 400ms lockout · no end marker",
  },
  {
    id: "card",
    name: "2 · End-of-chapter card",
    blurb: "A visible card at the end · one notch, a click, or Space turns",
  },
  {
    id: "append",
    name: "3 · Forward append",
    blurb: "Next chapter appended below as you near the end · back still jumps",
  },
  {
    id: "stream",
    name: "4 · Continuous stream",
    blurb: "A window of chapters, both directions · no boundary at all",
  },
];

interface Chapter {
  index: number;
  title: string;
  paras: string[];
}

function makeChapter(index: number): Chapter {
  return {
    index,
    title: `الفصل ${index + 1}`,
    paras: Array.from({ length: PARAS_PER_CHAPTER }, () => PARA),
  };
}

const params = new URLSearchParams(location.search);
const themeKey = (params.get("theme") ?? DEFAULT_TWEAKS.theme) as ThemeKey;
const initialModel = (params.get("model") ?? "push") as Model;
const initialLatency = Number(params.get("latency") ?? 350);

/** How many chapters `stream` keeps mounted before trimming the far end. */
const STREAM_WINDOW = 5;
/** Distance from an edge, in viewports, at which more content is pulled in. */
const PULL_VIEWPORTS = 1.5;
/** No reader asks for two chapter turns closer together than this. */
const SKIP_MS = 600;

interface Score {
  turns: number;
  wasted: number;
  deadMs: number;
  flowBreaks: number;
  skips: number;
}

const ZERO: Score = { turns: 0, wasted: 0, deadMs: 0, flowBreaks: 0, skips: 0 };

function Harness() {
  const theme = THEMES[themeKey] ?? THEMES.sepia;
  const [model, setModel] = useState<Model>(initialModel);
  const [latency, setLatency] = useState(initialLatency);
  const [symmetricPrefetch, setSymmetricPrefetch] = useState(false);
  const [scores, setScores] = useState<Record<string, Score>>({});

  // Loaded chapter bodies, and which are in flight. A chapter is "downloaded"
  // (instant) or has to be fetched — the real reader reads downloaded chapters
  // off disk and everything else over the network.
  const loaded = useRef(new Map<number, Chapter>());
  const [loadedTick, setLoadedTick] = useState(0);
  const inFlight = useRef(new Set<number>());

  const [current, setCurrent] = useState(START_CHAPTER);
  /** Chapters mounted in the scroller, in order. */
  const [mounted, setMounted] = useState<number[]>([START_CHAPTER]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WheelEngine | null>(null);

  // ── metrics ──────────────────────────────────────────────────────────────
  const lastTurnAt = useRef(0);
  const deadSince = useRef(0);
  const turnedThisEvent = useRef(false);

  const bump = useCallback(
    (patch: (s: Score) => Score) => {
      setScores((prev) => ({ ...prev, [model]: patch(prev[model] ?? ZERO) }));
    },
    [model],
  );

  /** Called for every wheel event, once the frame after it has settled. */
  const recordWheel = useCallback(
    (moved: boolean, turned: boolean) => {
      const now = performance.now();
      if (moved || turned) {
        if (deadSince.current > 0) {
          const dead = now - deadSince.current;
          deadSince.current = 0;
          bump((s) => ({ ...s, deadMs: Math.round(s.deadMs + dead) }));
        }
        return;
      }
      if (deadSince.current === 0) deadSince.current = now;
      bump((s) => ({ ...s, wasted: s.wasted + 1 }));
    },
    [bump],
  );

  const recordTurn = useCallback(
    (flowBreak: boolean, discrete: boolean) => {
      const now = performance.now();
      const gap = lastTurnAt.current ? now - lastTurnAt.current : Infinity;
      lastTurnAt.current = now;
      turnedThisEvent.current = true;
      bump((s) => ({
        ...s,
        turns: s.turns + 1,
        // A "skip" means a SWAP threw away a chapter the reader never saw.
        // That cannot happen where nothing is swapped: in the continuous
        // models an advance is just the reader having scrolled past a
        // divider, with every line still there and still scrollable back.
        // Counting those was about to report the old three-chapter-skip bug
        // in the one design where it is structurally impossible.
        skips: s.skips + (discrete && gap < SKIP_MS ? 1 : 0),
        flowBreaks: s.flowBreaks + (flowBreak ? 1 : 0),
      }));
    },
    [bump],
  );

  // Whether the NEXT chapter change required something other than scrolling
  // on. Set by the discrete paths; an observed change leaves it false, which
  // is the whole point of the continuous models.
  const pendingBreak = useRef(false);
  /** Was the pending change a swap (content replaced) or merely observed? */
  const pendingDiscrete = useRef(false);
  const countedChapter = useRef(START_CHAPTER);
  useEffect(() => {
    if (countedChapter.current === current) return;
    countedChapter.current = current;
    const wasBreak = pendingBreak.current;
    const wasDiscrete = pendingDiscrete.current;
    pendingBreak.current = false;
    pendingDiscrete.current = false;
    recordTurn(wasBreak, wasDiscrete);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const reset = useCallback(() => {
    setScores({});
    lastTurnAt.current = 0;
    deadSince.current = 0;
    loaded.current = new Map();
    inFlight.current = new Set();
    setLoadedTick((v) => v + 1);
    setCurrent(START_CHAPTER);
    setMounted([START_CHAPTER]);
    countedChapter.current = START_CHAPTER;
    pendingBreak.current = false;
    pendingDiscrete.current = false;
    engineRef.current = velocityEngine();
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, []);

  // ── loading ──────────────────────────────────────────────────────────────
  const ensure = useCallback(
    (index: number) => {
      if (index < 0 || index >= CHAPTER_COUNT) return;
      if (loaded.current.has(index) || inFlight.current.has(index)) return;
      inFlight.current.add(index);
      const land = () => {
        loaded.current.set(index, makeChapter(index));
        inFlight.current.delete(index);
        setLoadedTick((v) => v + 1);
      };
      if (latency <= 0) land();
      else window.setTimeout(land, latency);
    },
    [latency],
  );

  // Keep the chapters each model needs warm. Prefetch policy is its own lever,
  // separate from the navigation model: today's reader prefetches exactly one
  // chapter forward and none backward, which is why going back always waits.
  useEffect(() => {
    ensure(current);
    ensure(current + 1);
    if (symmetricPrefetch) {
      ensure(current + 2);
      ensure(current - 1);
      ensure(current - 2);
    }
    for (const i of mounted) ensure(i);
  }, [current, mounted, ensure, symmetricPrefetch]);

  // Rebuild the wheel engine when the model changes; scores survive so the
  // comparison stays like-for-like.
  useEffect(() => {
    engineRef.current = velocityEngine();
    setMounted([current]);
    deadSince.current = 0;
    // Switching model is not a chapter advance — don't charge one for it.
    countedChapter.current = current;
    pendingBreak.current = false;
    pendingDiscrete.current = false;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= MODELS.length) setModel(MODELS[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── turning ──────────────────────────────────────────────────────────────
  /** Discrete swap, for the models that still have a boundary. */
  const swapTo = useCallback(
    (index: number, landAtEnd: boolean, flowBreak: boolean) => {
      if (index < 0 || index >= CHAPTER_COUNT) return;
      pendingBreak.current = flowBreak;
      pendingDiscrete.current = true;
      turnedThisEvent.current = true;
      setCurrent(index);
      setMounted([index]);
      const el = scrollRef.current;
      if (el) {
        // Position before the browser paints, so the chapter's first paint is
        // at the right offset (see scrollJump / the WKWebView paint miss).
        requestAnimationFrame(() => {
          if (!el) return;
          el.scrollTop = landAtEnd ? el.scrollHeight : 0;
        });
      }
    },
    [],
  );

  // ── continuous models: pull content in at the edges ──────────────────────
  /** Height to restore after prepending, measured before the DOM changed. */
  const anchor = useRef<{ before: number; top: number } | null>(null);

  const maybeExtend = useCallback(
    (el: HTMLElement) => {
      if (model !== "append" && model !== "stream") return;
      const vh = el.clientHeight;
      const nearBottom =
        el.scrollHeight - el.scrollTop - vh < vh * PULL_VIEWPORTS;
      const nearTop = el.scrollTop < vh * PULL_VIEWPORTS;

      if (nearBottom) {
        const last = mounted[mounted.length - 1];
        const next = last + 1;
        if (next < CHAPTER_COUNT && !mounted.includes(next)) {
          ensure(next);
          if (loaded.current.has(next)) {
            setMounted((prev) => {
              const grown = [...prev, next];
              // Trim from the top once the window is full. Removing content
              // ABOVE moves everything up, so the scroll offset has to be
              // compensated or the page jumps under the reader.
              if (model === "stream" && grown.length > STREAM_WINDOW) {
                anchor.current = { before: el.scrollHeight, top: el.scrollTop };
                return grown.slice(1);
              }
              if (model === "append" && grown.length > STREAM_WINDOW) {
                anchor.current = { before: el.scrollHeight, top: el.scrollTop };
                return grown.slice(1);
              }
              return grown;
            });
          }
        }
      }

      if (nearTop && model === "stream") {
        const first = mounted[0];
        const prev = first - 1;
        if (prev >= 0 && !mounted.includes(prev)) {
          ensure(prev);
          if (loaded.current.has(prev)) {
            // Prepending is the hard half: the content the reader is looking
            // at gets pushed DOWN by the height of what went in above, so the
            // offset must be corrected in the same frame.
            anchor.current = { before: el.scrollHeight, top: el.scrollTop };
            setMounted((p) => [prev, ...p]);
          }
        }
      }
    },
    [model, mounted, ensure],
  );

  // Restore the reader's place after the mounted set changed above them.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    const delta = el.scrollHeight - a.before;
    if (delta !== 0) el.scrollTop = a.top + delta;
  }, [mounted]);

  /** For the continuous models, the chapter on screen is observed, not set. */
  const observeCurrent = useCallback(
    (el: HTMLElement) => {
      if (model !== "append" && model !== "stream") return;
      const top = el.getBoundingClientRect().top;
      let best = mounted[0];
      for (const section of el.querySelectorAll<HTMLElement>("[data-ch]")) {
        if (section.getBoundingClientRect().top - top > 8) break;
        best = Number(section.dataset.ch);
      }
      if (best !== current) setCurrent(best);
    },
    [model, mounted, current],
  );

  // ── wheel ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const before = el.scrollTop;
      turnedThisEvent.current = false;

      if (model === "push") {
        const engine = engineRef.current;
        const intent = engine?.onWheel(
          { deltaY: e.deltaY, deltaMode: e.deltaMode, t: performance.now() },
          {
            atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 1,
            atTop: el.scrollTop <= 1,
            canPrev: current > 0,
            canNext: current < CHAPTER_COUNT - 1,
          },
        );
        if (intent?.preventDefault) e.preventDefault();
        if (intent?.flip) {
          // Every turn here is a flow break by construction: it took a
          // different gesture from the one that was reading.
          swapTo(
            intent.flip === "down" ? current + 1 : current - 1,
            intent.flip === "up",
            true,
          );
          engine?.didFlip(performance.now());
        }
      } else if (model === "card") {
        const atBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
        const atTop = el.scrollTop <= 1;
        if (atBottom && e.deltaY > 0 && current < CHAPTER_COUNT - 1) {
          e.preventDefault();
          // One notch past the card is enough — the card is the affordance,
          // so the gesture does not also have to prove intent. Scrolling on
          // past a card the reader has already seen is not a break in flow.
          if (Math.abs(e.deltaY) > 8) swapTo(current + 1, false, false);
        } else if (atTop && e.deltaY < 0 && current > 0) {
          e.preventDefault();
          if (Math.abs(e.deltaY) > 8) swapTo(current - 1, true, false);
        }
      } else if (model === "append") {
        const atTop = el.scrollTop <= 1;
        if (atTop && e.deltaY < 0 && mounted[0] > 0) {
          e.preventDefault();
          // Backward still jumps in this model — that is the trade it makes.
          if (Math.abs(e.deltaY) > 8) swapTo(mounted[0] - 1, true, true);
        }
      }
      // `stream` never intercepts: scrolling is only ever scrolling.

      // Did that input buy anything? Compare after the frame has settled.
      requestAnimationFrame(() => {
        const moved = Math.abs(el.scrollTop - before) > 0.5;
        recordWheel(moved, turnedThisEvent.current);
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [model, current, mounted, swapTo, recordWheel]);

  // ── scroll ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        maybeExtend(el);
        observeCurrent(el);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Also run once — a freshly mounted pane may already be near an edge.
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [maybeExtend, observeCurrent]);

  // Content arriving can unblock an extend that was waiting on a fetch.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) maybeExtend(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedTick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || model !== "card") return;
      const el = scrollRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
      e.preventDefault();
      if (atBottom) swapTo(current + 1, false, false);
      else el.scrollTop += el.clientHeight * 0.9;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model, current, swapTo]);

  const score = scores[model] ?? ZERO;
  const mountedParas = useMemo(
    () => mounted.filter((i) => loaded.current.has(i)).length * PARAS_PER_CHAPTER,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, loadedTick],
  );
  const waitingFor = mounted.find((i) => !loaded.current.has(i));
  const ui = FONT_STACKS.sans;
  const mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

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
      {/* ── reading pane ── */}
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <div
          ref={scrollRef}
          style={{
            height: "100%",
            overflowY: "auto",
            overscrollBehavior: "contain",
            direction: "rtl",
          }}
        >
          {mounted.map((index) => {
            const ch = loaded.current.get(index);
            return (
              <div key={index} data-ch={index}>
                {(model === "append" || model === "stream") && index !== mounted[0] ? (
                  <ChapterDivider theme={theme} title={ch?.title ?? `الفصل ${index + 1}`} />
                ) : null}
                {ch ? (
                  <ChapterBody theme={theme} chapter={ch} total={CHAPTER_COUNT} />
                ) : (
                  <LoadingBlock theme={theme} index={index} />
                )}
              </div>
            );
          })}

          {model === "card" && current < CHAPTER_COUNT - 1 ? (
            <NextCard
              theme={theme}
              title={`الفصل ${current + 2}`}
              onClick={() => swapTo(current + 1, false, true)}
            />
          ) : null}

          {(model === "append" || model === "stream") && waitingFor !== undefined ? (
            <LoadingBlock theme={theme} index={waitingFor} />
          ) : null}
        </div>
      </div>

      {/* ── instruments ── */}
      <aside
        style={{
          width: 384,
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
          <div style={{ fontSize: 13, fontWeight: 600 }}>Moving between chapters</div>
          <div style={{ fontSize: 11, color: theme.muted, marginTop: 2, lineHeight: 1.5 }}>
            {`Chapter ${current + 1} of ${CHAPTER_COUNT} · ~${PARAS_PER_CHAPTER} paragraphs each,
             the shape of the real book. Keys 1-4 switch model.`}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {MODELS.map((m) => {
            const on = m.id === model;
            return (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
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
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.name}</div>
                <div style={{ fontSize: 11, marginTop: 3, opacity: on ? 0.85 : 0.7 }}>
                  {m.blurb}
                </div>
              </button>
            );
          })}
        </div>

        <div>
          <Label theme={theme}>Chapter latency</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {[0, 350, 900].map((ms) => (
              <Chip
                key={ms}
                theme={theme}
                on={latency === ms}
                onClick={() => setLatency(ms)}
              >
                {ms === 0 ? "downloaded" : `${ms}ms`}
              </Chip>
            ))}
          </div>
          <Label theme={theme} style={{ marginTop: 10 }}>Prefetch</Label>
          <div style={{ display: "flex", gap: 6 }}>
            <Chip theme={theme} on={!symmetricPrefetch} onClick={() => setSymmetricPrefetch(false)}>
              today (+1 fwd)
            </Chip>
            <Chip theme={theme} on={symmetricPrefetch} onClick={() => setSymmetricPrefetch(true)}>
              symmetric (±2)
            </Chip>
          </div>
        </div>

        <div>
          <Label theme={theme}>Scoreboard</Label>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead>
              <tr style={{ color: theme.muted, textAlign: "right" }}>
                <th style={{ fontWeight: 500, textAlign: "left" }}>Model</th>
                <th style={{ fontWeight: 500 }}>Turns</th>
                <th style={{ fontWeight: 500 }}>Wasted</th>
                <th style={{ fontWeight: 500 }}>Dead</th>
                <th style={{ fontWeight: 500 }}>Breaks</th>
                <th style={{ fontWeight: 500 }}>Skips</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: mono }}>
              {MODELS.map((m) => {
                const s = scores[m.id] ?? ZERO;
                return (
                  <tr
                    key={m.id}
                    style={{
                      borderTop: `1px solid ${theme.rule}`,
                      opacity: m.id === model ? 1 : 0.6,
                    }}
                  >
                    <td style={{ padding: "5px 0", fontFamily: ui }}>
                      {m.name.replace(/^\d+ · /, "")}
                    </td>
                    <td style={{ textAlign: "right" }}>{s.turns}</td>
                    <td style={{ textAlign: "right" }}>{s.wasted}</td>
                    <td style={{ textAlign: "right" }}>{(s.deadMs / 1000).toFixed(1)}s</td>
                    <td style={{ textAlign: "right" }}>{s.flowBreaks}</td>
                    <td
                      style={{
                        textAlign: "right",
                        color: s.skips > 0 ? theme.danger : undefined,
                        fontWeight: s.skips > 0 ? 700 : 400,
                      }}
                    >
                      {s.skips}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 10.5, color: theme.muted, marginTop: 8, lineHeight: 1.55 }}>
            <b>Wasted</b> — wheel notches after which nothing moved and no chapter turned.{" "}
            <b>Dead</b> — time spent scrolling with no reading progress.{" "}
            <b>Breaks</b> — turns that needed something other than scrolling on.{" "}
            <b>Skips</b> — a SWAP under {SKIP_MS}ms after the last one, i.e. a chapter thrown
            away unseen; anything above 0 undoes the earlier fix. Structurally impossible where
            nothing is swapped, so the continuous models cannot score here.
          </div>
        </div>

        <div>
          <Label theme={theme}>Cost right now</Label>
          <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted, lineHeight: 1.7 }}>
            <div>{`mounted chapters   ${mounted.length}`}</div>
            <div>{`mounted paragraphs ${mountedParas}`}</div>
            <div>{`waiting on         ${waitingFor === undefined ? "—" : `chapter ${waitingFor + 1}`}`}</div>
            <div>{`wasted / turn      ${score.turns ? (score.wasted / score.turns).toFixed(1) : "—"}`}</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <Chip theme={theme} on={false} onClick={reset}>Reset scores</Chip>
        </div>
      </aside>
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────

function ChapterBody({
  theme,
  chapter,
  total,
}: {
  theme: (typeof THEMES)[ThemeKey];
  chapter: Chapter;
  total: number;
}) {
  return (
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
      <div style={{ fontSize: 11, color: theme.muted, marginBottom: 8, fontFamily: FONT_STACKS.sans }}>
        {`الفصل ${chapter.index + 1} من ${total}`}
      </div>
      <h1 style={{ fontSize: 30, margin: "0 0 28px", fontWeight: 600 }}>{chapter.title}</h1>
      {chapter.paras.map((text, i) => (
        <p key={i} style={{ margin: `0 0 ${DEFAULT_TWEAKS.paragraphSpacing}em` }}>
          {text}
        </p>
      ))}
    </div>
  );
}

/** Marks where one chapter ends and the next begins in the continuous models. */
function ChapterDivider({
  theme,
  title,
}: {
  theme: (typeof THEMES)[ThemeKey];
  title: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        maxWidth: 660,
        margin: "0 auto",
        padding: "8px 40px",
        color: theme.muted,
        fontFamily: FONT_STACKS.sans,
        fontSize: 11,
        letterSpacing: "0.08em",
      }}
    >
      <span style={{ flex: 1, height: 1, background: theme.rule }} />
      <span>{title}</span>
      <span style={{ flex: 1, height: 1, background: theme.rule }} />
    </div>
  );
}

/** The `card` model's affordance: the turn made visible. */
function NextCard({
  theme,
  title,
  onClick,
}: {
  theme: (typeof THEMES)[ThemeKey];
  title: string;
  onClick: () => void;
}) {
  return (
    <div style={{ maxWidth: 660, margin: "0 auto", padding: "0 40px 96px" }}>
      <button
        onClick={onClick}
        style={{
          width: "100%",
          textAlign: "right",
          cursor: "pointer",
          font: "inherit",
          padding: "18px 22px",
          borderRadius: 14,
          background: theme.chrome,
          color: theme.ink,
          border: `1px solid ${theme.rule}`,
          minHeight: 44,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: "0.1em",
            color: theme.muted,
            marginBottom: 6,
            fontFamily: FONT_STACKS.sans,
          }}
        >
          الفصل التالي
        </div>
        <div style={{ fontSize: 19, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 11, color: theme.muted, marginTop: 8, fontFamily: FONT_STACKS.sans }}>
          Space, a click, or one more notch
        </div>
      </button>
    </div>
  );
}

function LoadingBlock({
  theme,
  index,
}: {
  theme: (typeof THEMES)[ThemeKey];
  index: number;
}) {
  return (
    <div
      style={{
        maxWidth: 660,
        margin: "0 auto",
        padding: "56px 40px",
        color: theme.muted,
        fontFamily: FONT_STACKS.sans,
        fontSize: 12,
        textAlign: "center",
        direction: "rtl",
      }}
    >
      {`يُحمّل الفصل ${index + 1}…`}
    </div>
  );
}

function Label({
  children,
  theme,
  style,
}: {
  children: React.ReactNode;
  theme: (typeof THEMES)[ThemeKey];
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: theme.muted,
        marginBottom: 8,
        ...style,
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
  on,
}: {
  children: React.ReactNode;
  onClick: () => void;
  theme: (typeof THEMES)[ThemeKey];
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
