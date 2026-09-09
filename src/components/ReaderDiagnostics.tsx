import { useEffect, useRef, useState } from "react";

interface Props {
  /** The reader's scroll container. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  chapterIndex: number;
  chapterId: string;
  /** What React thinks the chapter holds, to compare against the DOM. */
  reactItemCount: number;
}

interface Snap {
  at: string;
  chapter: number;
  chapterId: string;
  reactItems: number;
  domParas: number;
  inView: number;
  scrollTop: number;
  scrollMax: number;
  clientHeight: number;
  headingTop: number | null;
  headingText: string;
  opacity: string;
  visibility: string;
  verdict: string;
}

/**
 * Dev-only readout of what the reading pane is ACTUALLY showing.
 *
 * A blank reading pane has several possible causes that look identical in a
 * screenshot, and they point in completely different directions: content that
 * never arrived (react items 0), content that rendered but sits outside the
 * viewport (paras > 0, in view 0), a render that React did but the DOM did not
 * get (react items > 0, dom paras 0), or content that is present and
 * positioned but invisible (opacity 0). Guessing between them from a picture
 * of an empty window costs far more than measuring.
 *
 * The first blank state seen is FROZEN and shown in red, so a screenshot taken
 * after the pane recovers still carries the evidence.
 *
 * Rendered only under `import.meta.env.DEV`.
 */
export function ReaderDiagnostics({
  scrollRef,
  chapterIndex,
  chapterId,
  reactItemCount,
}: Props) {
  const [live, setLive] = useState<Snap | null>(null);
  const [frozen, setFrozen] = useState<Snap | null>(null);
  const frozenRef = useRef(false);
  // Latest sample, readable from the key handler without re-binding it.
  const liveRef = useRef<Snap | null>(null);
  /** When the pane first looked unreadable in this stretch, or 0. */
  const blankSince = useRef(0);

  useEffect(() => {
    const read = () => {
      const el = scrollRef.current;
      if (!el) return;
      const paras = el.querySelectorAll<HTMLElement>("[data-p-index]");
      const heading = el.querySelector("h2");
      // The chapter wrapper. Its computed opacity is what a stuck entry
      // animation used to strand at 0 — see finishStuckAnimations.
      const enter = el.firstElementChild as HTMLElement | null;
      const cs = enter ? getComputedStyle(enter) : null;
      const top = el.getBoundingClientRect().top;
      let inView = 0;
      for (const p of paras) {
        const r = p.getBoundingClientRect();
        if (r.bottom > top && r.top < top + el.clientHeight) inView += 1;
      }
      const headingRect = heading?.getBoundingClientRect();
      const headingTop = headingRect ? Math.round(headingRect.top - top) : null;
      const headingVisible =
        headingTop !== null && headingTop > -20 && headingTop < el.clientHeight;
      const invisible = cs !== null && Number(cs.opacity) < 0.05;

      // Name the cause rather than leaving a row of numbers to interpret.
      // These four states look identical on screen and need opposite fixes.
      let verdict: string;
      if (reactItemCount === 0) {
        verdict = "NO CONTENT — chapter body never arrived (loading/fetch)";
      } else if (paras.length === 0) {
        verdict = "RENDER GAP — React has content, the DOM does not";
      } else if (invisible) {
        verdict = "INVISIBLE — content present and placed, opacity ~0";
      } else if (inView === 0 && !headingVisible) {
        verdict = "WRONG POSITION — content is outside the viewport";
      } else {
        // Everything measures correct. Only the reader can say whether the
        // screen agreed, which is what the manual freeze below is for.
        verdict = "OK — content present, placed and visible";
      }

      const snap: Snap = {
        at: new Date().toISOString().slice(11, 23),
        chapter: chapterIndex + 1,
        chapterId,
        reactItems: reactItemCount,
        domParas: paras.length,
        inView,
        scrollTop: Math.round(el.scrollTop),
        scrollMax: el.scrollHeight - el.clientHeight,
        clientHeight: el.clientHeight,
        headingTop,
        headingText: heading?.textContent?.slice(0, 24) ?? "—",
        opacity: cs?.opacity ?? "—",
        visibility: cs?.visibility ?? "—",
        verdict,
      };
      setLive(snap);
      liveRef.current = snap;

      // Freeze the first state that could not be read on screen. A paint miss
      // cannot be detected from script — the DOM says everything is fine — so
      // the freeze is armed by the reader instead, via the key below.
      //
      // The state has to HOLD to count. Every chapter turn passes through a
      // frame or two that measures unreadable — the enter fade's first frame
      // is literally opacity 0, and content swaps in before it is positioned —
      // and freezing on those reported "INVISIBLE" for what was just a normal
      // fade starting. What the reader actually sees persists until they
      // scroll, so require it to outlast the 280ms animation by a margin.
      const BLANK_DWELL_MS = 500;
      const blankNow = (inView === 0 && !headingVisible) || invisible;
      if (!blankNow) {
        blankSince.current = 0;
      } else {
        if (blankSince.current === 0) blankSince.current = Date.now();
        const held = Date.now() - blankSince.current;
        if (held >= BLANK_DWELL_MS && !frozenRef.current) {
          frozenRef.current = true;
          setFrozen(snap);
        }
      }
    };
    const id = window.setInterval(read, 100);
    return () => window.clearInterval(id);
  }, [scrollRef, chapterIndex, chapterId, reactItemCount]);

  // A paint miss is invisible to script: every measurement reads correct while
  // the screen shows nothing. So the reader arms the freeze by hand — press
  // this WHILE the pane looks blank, before scrolling to bring it back.
  //
  // Matches on `code`, not `key`: on macOS, holding Option rewrites the
  // character, so Option+B arrives as "∫" and a `key === "b"` test never
  // fires. Cmd+Shift also stays clear of Control+Option, which is VoiceOver's
  // own modifier and gets swallowed when VoiceOver is running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyB" || !e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      frozenRef.current = true;
      setFrozen(liveRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const row = (s: Snap) =>
    [
      `ch ${s.chapter}`,
      `id ${s.chapterId}`,
      `react ${s.reactItems}`,
      `dom ${s.domParas}`,
      `inView ${s.inView}`,
      `scroll ${s.scrollTop}/${s.scrollMax}`,
      `h ${s.clientHeight}`,
      `head ${s.headingTop ?? "none"} "${s.headingText}"`,
      `op ${s.opacity}`,
      `vis ${s.visibility}`,
    ].join("  ");

  return (
    <div
      style={{
        position: "fixed",
        left: 6,
        bottom: 6,
        zIndex: 10000,
        maxWidth: "min(96vw, 1100px)",
        padding: "6px 8px",
        borderRadius: 6,
        background: "rgba(0,0,0,0.86)",
        font: '10.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: "#cfc6b4",
        pointerEvents: "none",
        direction: "ltr",
        whiteSpace: "pre-wrap",
      }}
    >
      <div>{live ? row(live) : "reading…"}</div>
      <div style={{ opacity: 0.55 }}>
        {live ? live.verdict : ""}
        {"   ·   ⌘⇧B while blank = freeze"}
      </div>
      {frozen ? (
        <div style={{ color: "#ff8f7d", marginTop: 3 }}>
          {`SNAPSHOT @ ${frozen.at}   ${
            frozen.verdict.startsWith("OK")
              ? "every measurement correct — if the screen was blank here, it is a PAINT MISS"
              : frozen.verdict
          }\n${row(frozen)}`}
        </div>
      ) : null}
    </div>
  );
}
