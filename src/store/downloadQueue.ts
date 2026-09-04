// Per-chapter download queue for source-backed library entries.
//
// Two public surfaces:
//
//   downloadChapter(entryId, chapterId)
//       Fetch one chapter's content + inline images, write to disk,
//       and mark it downloaded in source.json. Throws on error; the
//       caller is responsible for surfacing it. Used directly by
//       "Download chapter" buttons; used internally by the queue
//       worker for batched downloads.
//
//   enqueue / cancel / subscribe / getState
//       Module-scoped queue with workers. Jobs progress through
//       "queued → running → done | error | cancelled | interrupted".
//       UIs subscribe for state updates and pump the queue indirectly
//       by enqueuing.
//
// Workers run with bounded concurrency. Cancellation is cooperative:
// a job already started keeps going until its current fetch resolves
// (we can't yank a Tauri command mid-flight), but its result is
// discarded if the user cancelled before completion. Queued-but-not-
// started jobs are removed immediately.
//
// Persistence. The queue state is mirrored to
// $APPDATA/riwaq/downloadQueue.json on every transition (debounced)
// so jobs survive an app kill. On load, anything that was queued or
// running is reclassified as "interrupted" so the user can decide
// whether to resume (Retry button) — we don't auto-pump on load
// because a source that's gone offline would otherwise hammer the
// network as soon as the app launched.
//
// The state list is bounded — finished jobs evict from the tail once
// we cross a high-water mark so the queue page doesn't grow forever.
// The bookkeeping isn't a long-term audit log; it's an
// in-session view (plus enough to recover from a crash).

import {
  isSessionExpiredError,
  notifySessionExpired,
  resetSessionExpiredNotices,
} from "./sessionExpiry";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import {
  markChapterDownloaded,
  readSnapshot,
  writeChapterContent,
  type SourceSnapshot,
} from "./sourceLibrary";
import { createHost } from "../sources/host";
import { ROOT } from "./paths";
import { migrateLegacyRoot } from "./legacyRoot";
import { getSource } from "../sources/registry";
import type { SourceChapter, SourceLine } from "../sources/types";

const BASE = BaseDirectory.AppData;
const QUEUE_FILE = `${ROOT}/downloadQueue.json`;

// ── public job shape ───────────────────────────────────────────────────────

export type DownloadJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  /** Assigned at boot to jobs that were queued or running when the
   *  app last died. Visible in the queue UI with a Retry button —
   *  the user decides whether to resume. We don't auto-resume so a
   *  source that's gone offline can't loop on launch. */
  | "interrupted";

/** Fields every queue entry carries regardless of what kind of work
 *  it represents. Kept on a base interface so the discriminated union
 *  below stays tidy. */
interface JobBase {
  /** Synthetic job id; only meaningful inside the queue. */
  id: string;
  libraryEntryId: string;
  novelTitle: string;
  status: DownloadJobStatus;
  /** 0..1. For chapter downloads, this is fraction-of-one-chapter
   *  done; for conversions it's fraction-of-novel-converted. */
  progress: number;
  error?: string;
  enqueuedAt: number;
  updatedAt: number;
}

/** A single-chapter download: fetch content + inline images, persist
 *  to `chapters/<id>/`, flip `downloadedAt`. The original queue shape. */
export interface ChapterDownloadJob extends JobBase {
  kind: "chapter";
  chapterId: number;
  chapterTitle: string;
}

/** A "convert to offline book" job: pulls every chapter (downloaded or
 *  not), bakes one or more EPUBs, lands them in the library as regular
 *  entries. One job per user-initiated conversion regardless of how
 *  many EPUBs it produces. */
export interface ConversionJob extends JobBase {
  kind: "conversion";
  /** Whether to assemble one EPUB containing every volume as a
   *  section, or one EPUB per volume (each with chapters flat). */
  mode: "single" | "per-volume";
  /** Free-form label updated by the worker as it advances through
   *  fetch → build → save phases. Surfaced in the queue UI body so
   *  the user sees what's happening beyond a percentage. */
  phase: string;
  /** Library entry ids of the EPUBs produced so far. Single-mode
   *  lands one; per-volume lands many. */
  producedEntryIds: string[];
}

export type DownloadJob = ChapterDownloadJob | ConversionJob;

interface QueueState {
  jobs: DownloadJob[];
}

type Listener = (state: QueueState) => void;

// ── module-scoped state ────────────────────────────────────────────────────

/** Number of chapter downloads that may run concurrently. Two strikes
 *  a balance: faster than serial, and on the typical "scrape a hundred
 *  chapters" path the bottleneck is each chapter's per-page fetch +
 *  image download, not the local I/O. Runtime-adjustable via
 *  setDownloadConcurrency (clamped 1-5); defaults to 2. */
let concurrency = 2;

/** Cap on how many "terminal" (done / error / cancelled) jobs we keep
 *  around for the queue UI. New terminals push older terminals off. */
const TERMINAL_LIMIT = 50;

/** Lifetime tally of resolved jobs by kind + outcome, incremented on each
 *  terminal transition and NEVER evicted. The jobs array caps terminals at
 *  TERMINAL_LIMIT, so scanning it undercounts large bursts (a 187-chapter
 *  download would appear stuck at "50"). The notifier reads these counters
 *  instead to show true progress. Not persisted — a fresh process starts
 *  at zero, which is fine since the notifier rebases per burst. */
const resolvedCounters = {
  chDone: 0,
  chFailed: 0,
  chCancelled: 0,
  cvDone: 0,
  cvFailed: 0,
};

/** Snapshot of the lifetime resolved counters (see `resolvedCounters`).
 *  Consumed by the download notifier for accurate, eviction-proof burst
 *  progress and completion summaries. */
export function getResolvedCounters(): {
  chDone: number;
  chFailed: number;
  chCancelled: number;
  cvDone: number;
  cvFailed: number;
} {
  return { ...resolvedCounters };
}

function isTerminalStatus(s: DownloadJobStatus): boolean {
  return s === "done" || s === "error" || s === "cancelled";
}

/** Adjust the lifetime counters for one job's terminal outcome by `delta`
 *  (+1 on entering a terminal state, -1 on leaving it). Conversions lump
 *  error/cancelled into cvFailed. */
function bumpResolved(job: DownloadJob, status: DownloadJobStatus, delta: number) {
  if (job.kind === "chapter") {
    if (status === "done") resolvedCounters.chDone += delta;
    else if (status === "error") resolvedCounters.chFailed += delta;
    else if (status === "cancelled") resolvedCounters.chCancelled += delta;
  } else {
    if (status === "done") resolvedCounters.cvDone += delta;
    else resolvedCounters.cvFailed += delta; // error or cancelled
  }
}

const state: QueueState = { jobs: [] };
const listeners = new Set<Listener>();
const cancelled = new Set<string>();
let runningCount = 0;
let nextId = 1;

/** When true, hold downloads while the link looks metered (cellular /
 *  Data Saver). Toggled at runtime via setWifiOnlyDownloads. */
let wifiOnly = false;

/** Should the pump hold rather than start new jobs right now? Off
 *  entirely unless the user opted into wifi-only. When on, we sniff
 *  navigator.connection defensively: hold on Data Saver or a cellular
 *  link; otherwise proceed. If the API is absent we fail open (don't
 *  hold) — better to download than to strand the queue on a browser
 *  that doesn't expose connection info. */
function meteredHold(): boolean {
  if (!wifiOnly) return false;
  const conn = (navigator as any).connection;
  if (!conn) return false; // fail open — no connection info to gate on
  if (conn.saveData === true) return true;
  if (conn.type === "cellular") return true;
  return false;
}

/** Debounce window for disk writes. Each emit() queues a save; if
 *  another emit lands within this window, the previous save is
 *  cancelled and the latest state wins. Avoids hammering the FS
 *  during a multi-step run. */
const PERSIST_DEBOUNCE_MS = 250;
let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped each time we kick off a save so a stale debounced
 *  callback doesn't overwrite a newer state if writes serialize
 *  out of order. */
let persistSequence = 0;
let persistLoaded = false;

function emit() {
  for (const l of listeners) l(state);
  schedulePersist();
}

function schedulePersist() {
  if (!persistLoaded) return; // never overwrite the disk before load
  if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
  pendingPersistTimer = setTimeout(() => {
    pendingPersistTimer = null;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
}

async function persist(): Promise<void> {
  const mySeq = ++persistSequence;
  // Take a structural snapshot so a concurrent setStatus mutation
  // doesn't corrupt mid-stringify. We drop `running` jobs back to
  // `queued` for the persisted view because a process that died
  // mid-write leaves disk in a state where "running" doesn't make
  // sense — the worker is gone.
  const persisted = {
    version: 1 as const,
    jobs: state.jobs.map((j) => ({
      ...j,
      status: j.status === "running" ? "queued" : j.status,
    })),
  };
  const text = JSON.stringify(persisted);
  try {
    await migrateLegacyRoot();
    if (!(await exists(ROOT, { baseDir: BASE }))) {
      await mkdir(ROOT, { baseDir: BASE, recursive: true });
    }
    if (mySeq !== persistSequence) return; // a newer save started
    await writeTextFile(QUEUE_FILE, text, { baseDir: BASE });
  } catch (e) {
    // Persistence failure shouldn't crash the queue — the user
    // just loses crash-recovery for the current job set.
    // eslint-disable-next-line no-console
    console.warn("[downloadQueue] persist failed:", e);
  }
}

/** Read the persisted queue (if any) and merge it into the in-memory
 *  state. Should be called once on app start before any subscribers
 *  attach. Jobs that were `queued` or `running` at last shutdown are
 *  reclassified as `interrupted` so the user explicitly opts back in
 *  via Retry. Idempotent. */
export async function loadPersistedQueue(): Promise<void> {
  // Same ordering trap as shelves: reading before the move gives an empty
  // queue, and the next persist() would write that over the real file.
  await migrateLegacyRoot();
  if (persistLoaded) return;
  persistLoaded = true;
  try {
    if (!(await exists(QUEUE_FILE, { baseDir: BASE }))) return;
    const raw = await readTextFile(QUEUE_FILE, { baseDir: BASE });
    const parsed = JSON.parse(raw) as { version: number; jobs: DownloadJob[] };
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return;
    for (const j of parsed.jobs) {
      // Reclassify in-flight statuses as interrupted. Terminal
      // statuses (done / error / cancelled) carry forward as-is so
      // the user keeps their burst history.
      if (j.status === "queued" || j.status === "running") {
        j.status = "interrupted";
        // Wipe any stale error from a prior interrupted load.
        delete (j as { error?: string }).error;
      }
      state.jobs.push(j);
      // Bump the id counter past anything we loaded so new jobs
      // don't collide with restored ones.
      const m = j.id.match(/^dl-(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n >= nextId) nextId = n + 1;
      }
    }
    emit();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[downloadQueue] load failed:", e);
  }
}

function genId(): string {
  // Cheap monotonic ids — the queue lifetime is one session, no
  // collision risk worth carrying a crypto.randomUUID call for.
  return `dl-${nextId++}-${Date.now().toString(36)}`;
}

function findJob(id: string): DownloadJob | undefined {
  return state.jobs.find((j) => j.id === id);
}

function evictTerminals() {
  // Keep all non-terminal jobs + the most recent TERMINAL_LIMIT
  // terminals.
  const live: DownloadJob[] = [];
  const terms: DownloadJob[] = [];
  for (const j of state.jobs) {
    if (j.status === "queued" || j.status === "running") live.push(j);
    else terms.push(j);
  }
  terms.sort((a, b) => b.updatedAt - a.updatedAt);
  state.jobs = [...live, ...terms.slice(0, TERMINAL_LIMIT)];
}

function setStatus(
  job: DownloadJob,
  status: DownloadJobStatus,
  patch?: Partial<DownloadJob>,
) {
  const prev = job.status;
  job.status = status;
  job.updatedAt = Date.now();
  if (patch) Object.assign(job, patch);
  // Keep the lifetime counters reconciled to each job's CURRENT terminal
  // outcome: increment when a job enters a terminal state, decrement when
  // it leaves one (e.g. retry re-arms a failed job back to "queued").
  // Without the decrement a fail-then-retry-succeed would be counted as
  // BOTH a failure and a success. Guarded on an actual status change so
  // repeated running-progress updates don't touch the counters.
  if (prev !== status) {
    if (isTerminalStatus(prev)) bumpResolved(job, prev, -1);
    if (isTerminalStatus(status)) bumpResolved(job, status, 1);
  }
  if (isTerminalStatus(status)) evictTerminals();
  emit();
}

// ── enqueue / cancel / subscribe ───────────────────────────────────────────

export interface EnqueueDescriptor {
  libraryEntryId: string;
  chapterId: number;
  novelTitle: string;
  chapterTitle: string;
}

/** Add one chapter to the queue. Returns the job id (useful for
 *  targeted cancel). If the same (entryId, chapterId) is already
 *  queued or running, returns the existing job id without creating
 *  a duplicate. Already-completed jobs DO get a fresh entry — the
 *  caller might want to re-download. */
export function enqueue(desc: EnqueueDescriptor): string {
  const dup = state.jobs.find(
    (j) =>
      j.kind === "chapter" &&
      j.libraryEntryId === desc.libraryEntryId &&
      j.chapterId === desc.chapterId &&
      (j.status === "queued" || j.status === "running"),
  );
  if (dup) return dup.id;
  const job: ChapterDownloadJob = {
    id: genId(),
    kind: "chapter",
    libraryEntryId: desc.libraryEntryId,
    chapterId: desc.chapterId,
    novelTitle: desc.novelTitle,
    chapterTitle: desc.chapterTitle,
    status: "queued",
    progress: 0,
    enqueuedAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.jobs.push(job);
  emit();
  pump();
  return job.id;
}

export interface EnqueueConversionDescriptor {
  libraryEntryId: string;
  novelTitle: string;
  mode: "single" | "per-volume";
}

/** Enqueue a "save as offline book" conversion. One job is emitted
 *  regardless of how many EPUBs it ends up producing (per-volume mode
 *  may land many library entries from a single job). Duplicate of
 *  same (entryId, mode) is rejected while another is running so the
 *  user can't accidentally fire two conversions at once. */
export function enqueueConversion(
  desc: EnqueueConversionDescriptor,
): string {
  const dup = state.jobs.find(
    (j) =>
      j.kind === "conversion" &&
      j.libraryEntryId === desc.libraryEntryId &&
      j.mode === desc.mode &&
      (j.status === "queued" || j.status === "running"),
  );
  if (dup) return dup.id;
  const job: ConversionJob = {
    id: genId(),
    kind: "conversion",
    libraryEntryId: desc.libraryEntryId,
    novelTitle: desc.novelTitle,
    mode: desc.mode,
    phase: "Queued",
    producedEntryIds: [],
    status: "queued",
    progress: 0,
    enqueuedAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.jobs.push(job);
  emit();
  pump();
  return job.id;
}

/** Cancel a job. If queued, removes it; if running, marks it
 *  cancelled and the worker drops the result once the in-flight
 *  fetch resolves. Idempotent. */
export function cancel(jobId: string) {
  const job = findJob(jobId);
  if (!job) return;
  if (job.status === "queued") {
    setStatus(job, "cancelled");
    return;
  }
  if (job.status === "running") {
    cancelled.add(jobId);
    // Don't flip the status yet — the worker will when its fetch
    // resolves. Surfacing "cancelling…" until then would be honest
    // but requires another transient state; for now leave it
    // "running" and let the user see the spinner stop.
  }
}

/** Cancel any queued/running chapter job targeting these chapters of
 *  one library entry, and report which were mid-flight.
 *
 *  Cancellation here is cooperative: a job that has already started
 *  runs until its current fetch resolves and only then has its result
 *  discarded. So a caller deleting these chapters MUST await this,
 *  delete, and then re-check — otherwise the worker's write lands
 *  after the delete and the chapter reappears as downloaded.
 *
 *  `wasRunning` exists so the UI can say "Cancelled and deleted"
 *  instead of a bare "Deleted" for a download the user could see
 *  spinning. */
export function cancelJobsForChapters(
  libraryEntryId: string,
  chapterIds: number[],
): { cancelled: number[]; wasRunning: number[] } {
  if (chapterIds.length === 0) return { cancelled: [], wasRunning: [] };
  const wanted = new Set(chapterIds);
  const cancelledIds: number[] = [];
  const wasRunning: number[] = [];
  // Snapshot first: cancel() mutates job status, and mutating while
  // iterating state.jobs risks skipping entries.
  const targets = state.jobs.filter(
    (j) =>
      j.kind === "chapter" &&
      j.libraryEntryId === libraryEntryId &&
      wanted.has(j.chapterId) &&
      (j.status === "queued" || j.status === "running"),
  ) as ChapterDownloadJob[];
  for (const j of targets) {
    if (j.status === "running") wasRunning.push(j.chapterId);
    else cancelledIds.push(j.chapterId);
    cancel(j.id);
  }
  return { cancelled: cancelledIds, wasRunning };
}

export function clearTerminals() {
  state.jobs = state.jobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  );
  emit();
}

/** Re-queue an interrupted job. The worker decides what to skip via
 *  the kind-specific resume hooks (e.g. ConversionJob's
 *  producedEntryIds tells the conversion worker which volumes are
 *  already on disk). Idempotent — calling on a non-interrupted job
 *  is a no-op. */
export function retry(jobId: string): void {
  const job = findJob(jobId);
  if (!job) return;
  if (job.status !== "interrupted" && job.status !== "error") return;
  // Reset error message; the worker will set a fresh one if it
  // fails again.
  delete (job as { error?: string }).error;
  // Don't reset progress to 0 — conversion jobs use producedEntryIds
  // to skip work, so the bar should resume near where it was.
  // Chapter jobs are atomic, so progress will start fresh once
  // setStatus → running fires inside pump.
  setStatus(job, "queued");
  pump();
}

/** Re-queue every job that's currently interrupted or errored.
 *  Used by the queue page's "Retry all" affordance. */
export function retryAll(): void {
  // Snapshot first: setStatus mutates job.status, and re-arming an errored
  // job must go through setStatus so the lifetime resolvedCounters get
  // decremented (a bulk-retried failure that later succeeds must not be
  // counted as both failed and done).
  const toRearm = state.jobs.filter(
    (j) => j.status === "interrupted" || j.status === "error",
  );
  for (const j of toRearm) {
    delete (j as { error?: string }).error;
    setStatus(j, "queued");
  }
  pump();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): QueueState {
  return state;
}

/** Snapshot of (entryId, chapterId) pairs whose job is currently
 *  active (queued or running). Used by the chapter-row icon to
 *  render a "queued"/"downloading" indicator alongside the
 *  persisted downloadedAt flag. Conversion jobs are excluded — they
 *  aren't per-chapter even though they read every chapter. */
export function activeChapterSet(
  libraryEntryId: string,
): Map<number, ChapterDownloadJob> {
  const out = new Map<number, ChapterDownloadJob>();
  for (const j of state.jobs) {
    if (j.kind !== "chapter") continue;
    if (j.libraryEntryId !== libraryEntryId) continue;
    if (j.status === "queued" || j.status === "running") {
      out.set(j.chapterId, j);
    }
  }
  return out;
}

// ── worker pump ────────────────────────────────────────────────────────────

/** Set how many chapter downloads may run at once. Clamped to 1-5 and
 *  floored to an int. Pumps immediately so a bump takes effect without
 *  waiting for the next enqueue. No-op if unchanged. */
export function setDownloadConcurrency(n: number): void {
  // Guard against a non-finite value (e.g. NaN from a corrupt imported
  // setting): Math.floor(NaN) is NaN, which would make the pump's
  // `runningCount < concurrency` always false and stall every download.
  if (!Number.isFinite(n)) return;
  const next = Math.max(1, Math.min(5, Math.floor(n)));
  if (next === concurrency) return;
  concurrency = next;
  pump();
}

/** Toggle the wifi-only download gate. Turning it off pumps so any
 *  jobs that were held on a metered link resume right away. */
export function setWifiOnlyDownloads(on: boolean): void {
  wifiOnly = on;
  if (!on) pump();
}

function pump() {
  while (runningCount < concurrency) {
    const job = state.jobs.find((j) => j.status === "queued");
    if (!job) return;
    // Hold on a metered link when wifi-only is on. Return (not
    // continue) so the while loop doesn't spin on the same queued job.
    if (meteredHold()) return;
    runningCount++;
    setStatus(job, "running", { progress: 0.02 });
    runJob(job)
      .catch(() => {
        // runJob already mapped its error to job.status. Swallow.
      })
      .finally(() => {
        runningCount--;
        pump();
      });
  }
}

async function runJob(job: DownloadJob): Promise<void> {
  try {
    if (cancelled.has(job.id)) {
      cancelled.delete(job.id);
      setStatus(job, "cancelled");
      return;
    }
    if (job.kind === "chapter") {
      await runChapterJob(job);
    } else {
      await runConversionJob(job);
    }
    if (cancelled.has(job.id)) {
      cancelled.delete(job.id);
      setStatus(job, "cancelled");
      return;
    }
    // A job got through, so the session is healthy again — let a later
    // lapse raise a fresh notification.
    resetSessionExpiredNotices();
    setStatus(job, "done", { progress: 1 });
  } catch (e) {
    if (e instanceof CancelledError) {
      cancelled.delete(job.id);
      setStatus(job, "cancelled");
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    // A lapsed browser session isn't a normal failure: nothing retries
    // its way out of it, the user has to complete the check. Tell them,
    // since downloads usually run with the app in the background.
    if (isSessionExpiredError(message)) {
      void notifySessionExpired(message);
    }
    setStatus(job, "error", { error: message });
  }
}

async function runChapterJob(job: ChapterDownloadJob): Promise<void> {
  await downloadChapter(
    job.libraryEntryId,
    job.chapterId,
    (p) => {
      // Cooperatively poll for cancellation between phases. If the
      // user cancelled, abandon — the persisted side effects
      // already-written stay on disk (writes are mid-step), but
      // the snapshot's downloadedAt only flips after success, so
      // a cancelled chapter is consistently "not downloaded".
      if (cancelled.has(job.id)) {
        throw new CancelledError();
      }
      if (typeof p === "number") {
        job.progress = p;
        job.updatedAt = Date.now();
        emit();
      }
    },
  );
}

async function runConversionJob(job: ConversionJob): Promise<void> {
  // Dynamic import keeps the conversion module (which pulls in the
  // EPUB builder + a fair chunk of importer code) off the main
  // bundle's hot path. Queue users that only download chapters never
  // load it.
  const { runConversion } = await import("./storeConversion");
  await runConversion(
    job,
    () => cancelled.has(job.id),
    (p, phase) => {
      if (cancelled.has(job.id)) {
        throw new CancelledError();
      }
      if (typeof p === "number") {
        job.progress = p;
      }
      if (typeof phase === "string") {
        job.phase = phase;
      }
      job.updatedAt = Date.now();
      emit();
    },
  );
}

class CancelledError extends Error {
  constructor() {
    super("download cancelled");
    this.name = "CancelledError";
  }
}

// ── one-shot download (public) ─────────────────────────────────────────────

/**
 * Fetch one chapter's content + inline images, persist to disk, and
 * mark it downloaded in source.json. Throws on error.
 *
 * Image rewrite. Source extensions emit chapter lines as
 * `{type: "image", content: <ABSOLUTE_URL>}`. We download every
 * unique image URL, save it as `img-NNN.<ext>` inside the chapter's
 * directory, then rewrite the line's `content` to the bare basename.
 * The reader resolves basenames to asset:// URLs at render time via
 * `chapterImageSrc`. This keeps the persisted shape device-independent
 * (no absolute paths burned into JSON) and survives Tauri's per-OS
 * AppData differences.
 */
export async function downloadChapter(
  libraryEntryId: string,
  chapterId: number,
  onProgress?: (p: number) => void,
): Promise<void> {
  const snap = await readSnapshot(libraryEntryId);
  if (!snap) {
    throw new Error(
      "Library entry isn't a source-backed novel (no source.json on disk).",
    );
  }
  const chapter = findChapterInSnapshot(snap, chapterId);
  if (!chapter) {
    throw new Error(`Chapter ${chapterId} isn't in this novel's listing.`);
  }
  const source = getSource(snap.sourceId);
  if (!source) {
    throw new Error(
      `Source "${snap.sourceId}" isn't installed — can't download this chapter.`,
    );
  }
  onProgress?.(0.05);

  // Fetch the chapter body. Pass a SourceChapter shape; the host is
  // only consulted for the URL, but the type annotation needs the
  // empty lines + id.
  const stub: SourceChapter = {
    id: chapterId,
    title: chapter.title,
    url: chapter.url,
    lines: [],
  };
  const lines = await source.getChapterContent(stub);
  onProgress?.(0.35);

  // Collect unique image URLs in document order — we want stable
  // basenames so re-downloading doesn't shuffle indexes.
  const imageUrls: string[] = [];
  const seen = new Set<string>();
  for (const ln of lines) {
    if (ln.type !== "image") continue;
    if (seen.has(ln.content)) continue;
    seen.add(ln.content);
    imageUrls.push(ln.content);
  }

  const host = createHost(snap.sourceId);
  const imageFiles: Array<{ basename: string; bytes: Uint8Array }> = [];
  const urlToBasename = new Map<string, string>();
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const idx = String(i + 1).padStart(3, "0");
    try {
      // Source-resolved images (e.g. extracted from a PDF) come back as
      // bytes; everything else is a real URL the host fetches.
      const resolved = await source.resolveImage?.(url);
      const bytes = resolved ? resolved.bytes : await host.fetchBytes(url);
      const ext = resolved ? resolved.extension : extensionFromImageUrl(url);
      const basename = `img-${idx}.${ext}`;
      urlToBasename.set(url, basename);
      imageFiles.push({ basename, bytes });
    } catch (e) {
      host.log(
        "warn",
        `chapter ${chapterId}: image fetch failed (${url}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      // Skip this image — the line keeps its original URL so the
      // reader can still try to fetch it on display.
    }
    onProgress?.(0.35 + 0.55 * ((i + 1) / Math.max(1, imageUrls.length)));
  }

  // Rewrite image lines to local basenames where we have one.
  const rewritten: SourceLine[] = lines.map((ln) => {
    if (ln.type !== "image") return ln;
    const local = urlToBasename.get(ln.content);
    return local ? { type: "image", content: local } : ln;
  });

  // Cancellation check before writing chapter content to disk. The
  // existing poll right after writeChapterContent (below) is what
  // guards markChapterDownloaded — this one is narrower: it stops
  // writeChapterContent itself from recreating content.json and image
  // files once cancellation is already known, which would otherwise
  // leave orphaned files behind in a chapter directory a concurrent
  // delete just removed.
  onProgress?.(0.9);
  await writeChapterContent(libraryEntryId, chapterId, rewritten, imageFiles);
  onProgress?.(0.95);
  await markChapterDownloaded(libraryEntryId, chapterId);
  onProgress?.(1);
}

function findChapterInSnapshot(snapshot: SourceSnapshot, chapterId: number) {
  for (const v of snapshot.volumes) {
    for (const c of v.chapters) {
      if (c.id === chapterId) return c;
    }
  }
  return null;
}

/** Best-effort extension picker — mirrors the importer's logic. */
function extensionFromImageUrl(url: string): string {
  const lower = url.toLowerCase().split("?")[0].split("#")[0];
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".gif")) return "gif";
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".jpeg")) return "jpg";
  if (lower.endsWith(".jpg")) return "jpg";
  // Defaulting to .jpg is OK — the reader resolves images by manifest
  // path, not content sniffing, so the actual MIME of the bytes
  // doesn't have to match the extension for the picture to render.
  return "jpg";
}

// ── batch enqueue helpers ──────────────────────────────────────────────────

/**
 * Enqueue every chapter in (inclusive) [start, end] from the novel
 * the snapshot describes. Used by "Download range" — replaces the
 * legacy build-a-separate-EPUB flow with the new queue-driven
 * approach. Returns the list of job ids that were created (existing
 * queued/running jobs for the same chapter are reused; their ids are
 * still included).
 */
export function enqueueRange(
  snapshot: SourceSnapshot,
  start: number,
  end: number,
  libraryEntryId: string,
): string[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const ids: string[] = [];
  for (const v of snapshot.volumes) {
    for (const c of v.chapters) {
      if (c.id < lo || c.id > hi) continue;
      if (c.downloadedAt) continue; // already on disk
      ids.push(
        enqueue({
          libraryEntryId,
          chapterId: c.id,
          novelTitle: snapshot.title,
          chapterTitle: c.title,
        }),
      );
    }
  }
  return ids;
}

// Auto-resume when the link changes back to Wi-Fi (or any non-metered
// state). Defensive: navigator.connection isn't universal, so guard
// with optional chaining + try/catch so a missing API can't throw at
// module init.
try {
  (navigator as any).connection?.addEventListener?.("change", () => pump());
} catch {
  // No connection API — nothing to listen on. Wifi-only jobs simply
  // won't auto-resume; a manual retry or setWifiOnlyDownloads(false)
  // still pumps.
}
