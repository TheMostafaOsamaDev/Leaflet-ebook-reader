// The one place that knows how to delete downloaded chapters safely.
//
// Ordering matters and is easy to get wrong: the download queue's
// cancellation is cooperative, so a job that already started keeps
// running until its current fetch resolves. Deleting first and
// cancelling second (or not awaiting between them) lets the worker
// write content.json and flip downloadedAt back on after the user
// deleted — from their side, the delete silently did nothing.
//
// Every delete affordance in the UI goes through here rather than
// calling deleteChapterDownloads directly.

import { cancelJobsForChapters } from "./downloadQueue";
import { deleteChapterDownloads, readSnapshot } from "./sourceLibrary";

export interface DeleteChaptersResult {
  /** Chapters whose downloadedAt flag is now clear. */
  removed: number[];
  /** Chapters that had a download actually in flight when the user
   *  deleted. The UI says "cancelled and deleted" for these. */
  cancelledRunning: number[];
}

export async function deleteChaptersWithQueue(
  libraryEntryId: string,
  chapterIds: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<DeleteChaptersResult> {
  if (chapterIds.length === 0) {
    return { removed: [], cancelledRunning: [] };
  }

  // De-duplicate up front: every UI surface funnels through this seam,
  // so this is the one place that needs to guard against a caller
  // passing the same chapter id twice. A duplicate would otherwise
  // double-call remove() downstream and inflate the onProgress total.
  const ids = [...new Set(chapterIds)];

  // 1. Cancel first, so nothing new starts for these chapters.
  const { wasRunning } = cancelJobsForChapters(libraryEntryId, ids);

  // 2. Let any worker that was mid-fetch reach its next cooperative
  //    cancellation poll before we touch the disk. A microtask isn't
  //    enough — the poll sits behind an awaited fetch.
  if (wasRunning.length > 0) {
    await new Promise((r) => setTimeout(r, 0));
  }

  // 3. Delete.
  const first = await deleteChapterDownloads(
    libraryEntryId,
    ids,
    onProgress,
  );

  // 4. Re-check. Two different resurrections need catching here, and
  //    only one of them is visible in the snapshot.
  //
  //    (a) Files on disk with the flag already clear — the state that
  //        actually occurs. A worker sitting inside writeChapterContent
  //        when our remove(dir) lands writes its images BEFORE
  //        content.json, so it recreates files inside the directory we
  //        just removed. Its next progress poll then throws
  //        CancelledError and markChapterDownloaded never runs: files
  //        on disk, flag clear. The row reads "not downloaded", so the
  //        user has no reason to delete it again and nothing will ever
  //        reclaim that space — in a feature whose entire purpose is
  //        reclaiming space. Nothing in the snapshot reveals this, so
  //        every id that was mid-flight is swept again unconditionally.
  //        That set is bounded by the queue's concurrency (<= 5), so it
  //        is at most five extra remove() calls.
  //
  //    (b) The flag itself flipped back on — a worker that got all the
  //        way through markChapterDownloaded during the sweep. This one
  //        MUST be read fresh from disk, not from `first.snapshot`:
  //        deleteChapterDownloads strips downloadedAt for every id it
  //        was just asked to delete before returning that same
  //        snapshot, so `first.snapshot` always shows the flag clear
  //        for all of `ids` and checking it could never find a
  //        resurrection. Checked across every id we deleted rather than
  //        only the mid-flight ones, so a late write we did not predict
  //        is still caught.
  let removed = first.removed;
  if (wasRunning.length > 0) {
    const wanted = new Set(ids);
    const resweep = new Set(wasRunning);
    const freshSnap = await readSnapshot(libraryEntryId);
    for (const v of freshSnap?.volumes ?? []) {
      for (const c of v.chapters) {
        if (c.downloadedAt && wanted.has(c.id)) resweep.add(c.id);
      }
    }
    const second = await deleteChapterDownloads(libraryEntryId, [...resweep]);
    removed = [...new Set([...removed, ...second.removed])];
  }

  return { removed, cancelledRunning: wasRunning };
}

/** The per-chapter flags the novel view keeps in its lookup map. */
export interface ChapterFlags {
  downloadedAt?: number;
  readAt?: number;
}

/** Chapters in `chapterIds` that have content on disk. The target of
 *  "delete all downloads in volume". */
export function downloadedChapterIds(
  chapterIds: number[],
  flags: Map<number, ChapterFlags>,
): number[] {
  return chapterIds.filter((id) => flags.get(id)?.downloadedAt);
}

/** Chapters that are BOTH downloaded and read — the target of "delete
 *  read downloads". Read-but-not-downloaded has nothing to free, and
 *  downloaded-but-unread is the content the user still wants. */
export function readDownloadedChapterIds(
  chapterIds: number[],
  flags: Map<number, ChapterFlags>,
): number[] {
  return chapterIds.filter((id) => {
    const f = flags.get(id);
    return !!f?.downloadedAt && !!f?.readAt;
  });
}
