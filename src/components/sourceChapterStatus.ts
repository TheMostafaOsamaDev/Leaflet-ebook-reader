/**
 * What overlay, if any, the streaming reader should show over a chapter.
 *
 * The streaming reader fetches two chapters at once — the one being read and a
 * prefetch of the next — and it used to track "is a chapter loading" as a
 * single boolean shared by both. Whichever fetch finished first cleared it, so
 * a next-chapter prefetch that resolved quickly (already cached, or read off
 * disk) tore down the loading overlay while the chapter actually on screen was
 * still empty. What the reader saw was a blank page: no text, no spinner, and
 * nothing to suggest anything was still happening. Same for errors — a failed
 * prefetch of the NEXT chapter raised an error overlay over THIS one.
 *
 * So status is tracked per chapter index, and the answer is only ever about
 * the chapter being read.
 */
export type ChapterOverlay =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export function chapterOverlay(
  currentChapter: number,
  /** How many content items the chapter on screen has. */
  itemCount: number,
  /** Chapter indices with a fetch in flight. */
  inFlight: ReadonlySet<number>,
  /** Fetch failures, by chapter index. */
  errors: ReadonlyMap<number, string>,
): ChapterOverlay {
  // Content wins over both: once there is something to read, a background
  // refetch or a failed prefetch must not cover it.
  if (itemCount > 0) return { kind: "none" };
  const error = errors.get(currentChapter);
  // An in-flight retry outranks the error it is retrying.
  if (inFlight.has(currentChapter)) return { kind: "loading" };
  if (error !== undefined) return { kind: "error", message: error };
  return { kind: "none" };
}
