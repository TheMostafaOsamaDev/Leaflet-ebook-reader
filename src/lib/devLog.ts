// Dev-only structured logging for the reader, written to a file on disk so a
// reproduction can be handed over whole instead of described.
//
// Why this exists: the reader has a bug where a chapter turn lands on a page
// that is blank on screen while every measurement says the text is present,
// laid out and visible. Diagnosing it through screenshots cost several rounds
// and produced a wrong answer once, because a one-line on-screen readout can
// only carry the fields someone already thought to include — and the field
// that mattered was missing. An earlier probe measured paragraph positions
// relative to the SCROLL CONTAINER, so it would have reported "7 paragraphs in
// view" even if the container itself sat outside the window.
//
// So this records everything relevant, window-relative, with the full ancestor
// chain, and appends it to:
//
//   $APPDATA/debug/reader-debug.log        (JSON, one event per line)
//
// which on macOS is
//   ~/Library/Application Support/com.leaflet.reader/debug/reader-debug.log
//
// The file is truncated when the session starts, so it always describes the
// run in front of you. In a plain browser (no Tauri) the events stay in memory
// and are readable via `window.__readerLog()`.

import {
  BaseDirectory,
  mkdir,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const LOG_DIR = "debug";
const LOG_PATH = "debug/reader-debug.log";
/** Stop appending past this, so a long session cannot fill the disk. */
const MAX_EVENTS = 20000;
const FLUSH_MS = 700;

interface Event {
  t: number;
  kind: string;
  data: unknown;
}

const events: Event[] = [];
let pending: string[] = [];
let started = 0;
let flushTimer: number | null = null;
let ready: Promise<boolean> | null = null;
let capped = false;

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function ensureDir(): Promise<boolean> {
  if (!hasTauri()) return false;
  if (!ready) {
    ready = (async () => {
      try {
        await mkdir(LOG_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return ready;
}

async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const chunk = pending.join("");
  pending = [];
  if (!(await ensureDir())) return;
  try {
    await writeTextFile(LOG_PATH, chunk, {
      baseDir: BaseDirectory.AppData,
      append: true,
    });
  } catch {
    // A failed write must never take the reader down with it.
  }
}

/**
 * Start a clean file for this session, synchronously enough that nothing from
 * the previous one survives.
 *
 * The first version let `flush` do the truncating on its first write, which
 * raced: a flush still holding events from the PREVIOUS mount would consume
 * the truncate, and the session header then appended after them. The log
 * opened with stale events whose timestamps ran from a different origin —
 * unreadable in exactly the way a log is supposed to prevent.
 */
async function truncateForSession(): Promise<void> {
  pending = [];
  if (!(await ensureDir())) return;
  try {
    await writeTextFile(LOG_PATH, "", {
      baseDir: BaseDirectory.AppData,
      append: false,
    });
  } catch {
    // Ignore — an unwritable log is not worth a broken reader.
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
}

/** Record one event. Cheap enough to call from a scroll-adjacent path. */
export function log(kind: string, data?: unknown): void {
  if (!import.meta.env.DEV) return;
  if (capped) return;
  if (started === 0) started = Date.now();
  const ev: Event = { t: Date.now() - started, kind, data: data ?? null };
  events.push(ev);
  pending.push(`${JSON.stringify(ev)}\n`);
  if (events.length >= MAX_EVENTS) {
    capped = true;
    pending.push(`${JSON.stringify({ t: ev.t, kind: "log:capped", data: MAX_EVENTS })}\n`);
  }
  scheduleFlush();
}

/** Write immediately rather than waiting for the timer. */
export function flushNow(): Promise<void> {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flush();
}

export function eventCount(): number {
  return events.length;
}

// ── geometry ───────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

/** Does this rect actually overlap the window? The question the probe missed. */
function onScreen(r: Rect): boolean {
  return (
    r.w > 0 &&
    r.h > 0 &&
    r.x < window.innerWidth &&
    r.y < window.innerHeight &&
    r.x + r.w > 0 &&
    r.y + r.h > 0
  );
}

function describe(el: Element): string {
  const cls =
    typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className.slice(0, 60)
      : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join(".")}` : ""}`;
}

/**
 * Everything about one element that can make it fail to appear: where it is in
 * the WINDOW, whether it is transparent, transformed, clipped, or filtered.
 * Any single one of these explains a blank page, and they are indistinguishable
 * on screen.
 */
function styleOf(el: Element) {
  const cs = getComputedStyle(el);
  return {
    el: describe(el),
    rect: rect(el),
    onScreen: onScreen(rect(el)),
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    transform: cs.transform,
    filter: cs.filter,
    backdropFilter: cs.backdropFilter || (cs as unknown as Record<string, string>)["webkitBackdropFilter"],
    overflow: `${cs.overflowX}/${cs.overflowY}`,
    clipPath: cs.clipPath,
    contain: cs.contain,
    isolation: cs.isolation,
    willChange: cs.willChange,
    position: cs.position,
    zIndex: cs.zIndex,
    animationName: cs.animationName,
    animationPlayState: cs.animationPlayState,
  };
}

/**
 * A full picture of what the reading pane is doing, window-relative.
 *
 * `tag` says what prompted it, so the log reads as a story: the positioning
 * decision, then the same pane sampled again as frames go by, then whatever
 * the reader marked by hand.
 */
export function snapshotReader(
  scroller: HTMLElement | null,
  tag: string,
  extra?: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  if (!scroller) {
    log("geometry", { tag, error: "no scroller", ...extra });
    return;
  }
  const paras = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-p-index]"),
  );
  const heading = scroller.querySelector("h2");
  const wrapper = scroller.firstElementChild;

  // Count against the WINDOW, not the scroller — a scroller pushed off-screen
  // still "contains" its paragraphs.
  const onScreenParas = paras.filter((p) => onScreen(rect(p))).length;

  // What is actually hit-testable at the centre of the reading pane. Hit
  // testing uses layout, so a paragraph here while the screen looks blank
  // separates "not painted" from "not there".
  const sr = rect(scroller);
  const cx = Math.round(sr.x + sr.w / 2);
  const cy = Math.round(sr.y + sr.h / 2);
  const hit =
    cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight
      ? document.elementFromPoint(cx, cy)
      : null;

  // Walk up from the scroller. One of these ancestors is the usual culprit
  // when the pane is fine and the screen is not.
  const chain: ReturnType<typeof styleOf>[] = [];
  let node: Element | null = scroller;
  while (node && node !== document.documentElement && chain.length < 14) {
    chain.push(styleOf(node));
    node = node.parentElement;
  }

  log("geometry", {
    tag,
    ...extra,
    window: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      hidden: document.hidden,
    },
    scroll: {
      top: Math.round(scroller.scrollTop),
      height: scroller.scrollHeight,
      client: scroller.clientHeight,
      max: scroller.scrollHeight - scroller.clientHeight,
    },
    paras: {
      count: paras.length,
      onScreen: onScreenParas,
      first: paras[0] ? rect(paras[0]) : null,
      last: paras[paras.length - 1] ? rect(paras[paras.length - 1]) : null,
    },
    heading: heading
      ? { rect: rect(heading), onScreen: onScreen(rect(heading)), text: heading.textContent?.slice(0, 30) }
      : null,
    wrapper: wrapper ? styleOf(wrapper) : null,
    hitTest: hit
      ? { el: describe(hit), text: hit.textContent?.slice(0, 40) ?? "" }
      : null,
    chain,
  });
}

/** Session header, so the log is self-describing when read cold. */
export function logSessionStart(extra?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  // Drop anything buffered from a previous mount and empty the file BEFORE
  // this session's first event is queued, so the file holds exactly one run
  // and every `t` shares one origin.
  void truncateForSession().then(() => {
    started = Date.now();
    log("session", {
      at: new Date().toISOString(),
      ua: navigator.userAgent,
      tauri: hasTauri(),
      window: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      ...extra,
    });
  });
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__readerLog = () => events;
  (window as unknown as Record<string, unknown>).__readerLogFlush = flushNow;
}
