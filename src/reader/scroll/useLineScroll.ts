import { useEffect, useRef } from "react";
import {
  createLineBank,
  glideStep,
  measureLineBox,
  settleDelta,
  wheelDeltaToPixels,
} from "./lineScroll";

/**
 * `wheel`   desktop: the reader owns wheel scrolling, gliding to a target that
 *           always rests on a whole line.
 * `settle`  mobile: touch scrolling is left entirely to the platform, and only
 *           the last few pixels are glided onto a line once the fling ends.
 * `off`     paginated modes, which do not scroll.
 */
export type LineScrollMode = "off" | "wheel" | "settle";

/** Silence after a fling that means the platform has finished with it. */
const SETTLE_AFTER_MS = 160;
/** Stop the frame loop after this many still frames. */
const IDLE_FRAMES = 12;
/**
 * A scroll position this far from where we last put it came from somewhere
 * else — a chapter turn, the scrubber, a keypress — and the glide must adopt
 * it rather than dragging the reader back.
 */
const EXTERNAL_JUMP_PX = 2;

interface Options {
  scrollRef: React.RefObject<HTMLElement | null>;
  mode: LineScrollMode;
  /** When true, moves land immediately instead of gliding. */
  reducedMotion: boolean;
}

/**
 * Line-aware scrolling for the reading surface. See lineScroll.ts for what
 * this is fixing and the numbers behind it; this file is only the wiring.
 *
 * Deliberately different per platform. A phone has no wheel, and touch
 * scrolling belongs to the compositor — attaching a non-passive listener that
 * calls preventDefault to a touch surface is how momentum scrolling gets
 * broken. So mobile never intercepts a gesture; it waits for the fling to
 * finish and then settles.
 */
export function useLineScroll({ scrollRef, mode, reducedMotion }: Options): void {
  const lineBox = useRef(0);
  const target = useRef(0);
  const applied = useRef(0);
  const raf = useRef(0);
  const idle = useRef(0);
  const bank = useRef(createLineBank());
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  useEffect(() => {
    if (mode === "off") return;
    const el = scrollRef.current;
    lineBox.current = measureLineBox(el);
    bank.current.reset();
    if (el) {
      target.current = el.scrollTop;
      applied.current = el.scrollTop;
    }
  }, [mode, scrollRef]);

  const pump = useRef<() => void>(() => {});
  pump.current = () => {
    const el = scrollRef.current;
    if (!el) {
      raf.current = 0;
      return;
    }
    // Adopt any position change that did not come from this loop, so a chapter
    // turn or a TOC jump is never fought.
    if (Math.abs(el.scrollTop - applied.current) > EXTERNAL_JUMP_PX) {
      target.current = el.scrollTop;
      applied.current = el.scrollTop;
      bank.current.reset();
    }
    if (el.scrollTop !== target.current) {
      const next = reducedRef.current
        ? target.current
        : glideStep(el.scrollTop, target.current);
      el.scrollTop = next;
      applied.current = el.scrollTop;
      idle.current = 0;
    } else {
      idle.current += 1;
    }
    if (idle.current > IDLE_FRAMES) {
      raf.current = 0;
      return;
    }
    raf.current = requestAnimationFrame(() => pump.current());
  };

  const wake = useRef<() => void>(() => {});
  wake.current = () => {
    idle.current = 0;
    if (!raf.current) {
      // Re-measure at the start of each gesture rather than keying off the
      // reader's settings. The rendered line height also moves with the
      // global font scale, which this component never sees, so anything
      // derived from props would go stale without anyone noticing. One
      // getComputedStyle per gesture is nothing.
      lineBox.current = measureLineBox(scrollRef.current);
      raf.current = requestAnimationFrame(() => pump.current());
    }
  };

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  // ── desktop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "wheel") return;
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Measure here if the mount pass had nothing to measure — a streamed
      // chapter mounts empty and its text arrives over the network, and
      // without this the feature would silently never engage for the rest of
      // the session (the early return skips the re-measure in wake()).
      let line = lineBox.current;
      if (!(line > 0)) {
        line = measureLineBox(el);
        lineBox.current = line;
      }
      // Still nothing rendered: leave the surface to the browser rather than
      // guess a line box and move the reader oddly.
      if (!(line > 0)) return;
      e.preventDefault();
      const px = wheelDeltaToPixels(e.deltaY, e.deltaMode);
      const step = bank.current.spend(px, line);
      if (step === 0) return;
      const max = el.scrollHeight - el.clientHeight;
      // Build on the target, not the current position, so a burst of events
      // becomes one glide instead of a series of jumps.
      const base = raf.current ? target.current : el.scrollTop;
      const next = Math.max(0, Math.min(max, base + step));
      // Clipped at either end: drop the bank so unspent travel cannot pile up
      // and lurch when the reader turns round.
      if (next === base) bank.current.reset();
      target.current = next;
      wake.current();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode, scrollRef]);

  // ── mobile ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "settle") return;
    const el = scrollRef.current;
    if (!el) return;
    let timer = 0;

    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Measure here too if the mount pass had nothing to measure. The
        // wheel path needed the same guard: without it a single failed
        // measurement at mount disables the feature for the whole session,
        // because the early return skips the re-measure in wake().
        let line = lineBox.current;
        if (!(line > 0)) {
          line = measureLineBox(el);
          lineBox.current = line;
        }
        if (!(line > 0)) return;
        const top = el.scrollTop;
        const max = el.scrollHeight - el.clientHeight;
        // Leave the extremes alone: snapping at the very end would scroll away
        // from it and open a gap under the last line.
        if (top < line || top > max - line) return;
        const delta = settleDelta(top, line);
        if (Math.abs(delta) < 0.5) return;
        target.current = Math.max(0, Math.min(max, top + delta));
        // Adopt the platform's position as ours BEFORE waking the loop. The
        // pump treats an unexplained change in scrollTop as someone else
        // moving the reader (a chapter turn, the scrubber) and resets the
        // target to match — and a touch scroll is, by definition, not ours.
        // Without this the guard destroyed every settle the moment it was
        // asked for: scrollTop had moved 67px while `applied` still said 0.
        applied.current = top;
        wake.current();
      }, SETTLE_AFTER_MS);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [mode, scrollRef]);
}
