// Cover for the delete orchestration seam: the cancel -> await ->
// delete -> re-check ordering, and the two preset predicates the
// volume menu and selection mode both use.
import { beforeEach, describe, expect, it, vi } from "vitest";

let cancelCalls: Array<{ entryId: string; ids: number[] }> = [];
let deleteCalls: number[][] = [];
let readSnapshotCalls = 0;
/** Flipped on by a test to simulate a worker that finished mid-sweep
 *  and wrote downloadedAt back on. This can only show up in a LATER
 *  fresh readSnapshot() read — never in deleteChapterDownloads' own
 *  return value, which always reports the ids it was just asked to
 *  delete as cleared. */
let resurrect: number[] = [];
let wasRunning: number[] = [];

vi.mock("./downloadQueue", () => ({
  cancelJobsForChapters: (entryId: string, ids: number[]) => {
    cancelCalls.push({ entryId, ids });
    return { cancelled: [], wasRunning };
  },
}));
vi.mock("./sourceLibrary", () => ({
  // Matches the real deleteChapterDownloadsImpl contract: it strips
  // downloadedAt from every id it was just asked to delete BEFORE
  // returning that same snapshot, so this mock's return value can
  // never show a resurrected flag for `ids` — only a later, separate
  // readSnapshot() read of disk can.
  deleteChapterDownloads: async (_e: string, ids: number[]) => {
    deleteCalls.push(ids);
    return {
      removed: ids,
      snapshot: {
        volumes: [{ chapters: ids.map((id) => ({ id })) }],
      },
    };
  },
  readSnapshot: async (_e: string) => {
    readSnapshotCalls++;
    // Only the fresh read right after the first delete can observe a
    // resurrection; a re-delete of the resurrected id really does
    // clear it, so a second read (if one happened) would not.
    const stillDownloaded = readSnapshotCalls === 1 ? resurrect : [];
    return {
      volumes: [
        {
          chapters: stillDownloaded.map((id) => ({ id, downloadedAt: 1 })),
        },
      ],
    };
  },
}));

import {
  deleteChaptersWithQueue,
  downloadedChapterIds,
  readDownloadedChapterIds,
} from "./chapterDeletion";

beforeEach(() => {
  cancelCalls = [];
  deleteCalls = [];
  readSnapshotCalls = 0;
  resurrect = [];
  wasRunning = [];
});

describe("deleteChaptersWithQueue", () => {
  it("cancels before it deletes", async () => {
    await deleteChaptersWithQueue("e1", [1, 2]);
    expect(cancelCalls).toEqual([{ entryId: "e1", ids: [1, 2] }]);
    expect(deleteCalls[0]).toEqual([1, 2]);
  });

  it("re-deletes a chapter a late worker write resurrected", async () => {
    wasRunning = [2];
    resurrect = [2];
    const res = await deleteChaptersWithQueue("e1", [1, 2]);
    // Second sweep targets only the chapter that came back. Without
    // it the delete silently reverts and the row flips to downloaded.
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[1]).toEqual([2]);
    expect(res.cancelledRunning).toEqual([2]);
    // The reported removed list must reflect both sweeps, not just
    // the first (which already believed chapter 2 was cleared).
    expect(res.removed.slice().sort()).toEqual([1, 2]);
  });

  it("de-duplicates the ids before it touches disk", async () => {
    // Every delete affordance funnels through here, so this is the one
    // place a caller passing the same chapter twice can be caught. A
    // duplicate would double-call remove() and inflate onProgress'
    // total.
    await deleteChaptersWithQueue("e1", [1, 1, 2]);
    expect(deleteCalls[0]).toEqual([1, 2]);
  });

  it("re-sweeps a mid-flight chapter even when its flag stayed clear", async () => {
    wasRunning = [2];
    resurrect = [];
    await deleteChaptersWithQueue("e1", [1, 2]);
    // The state this guards is invisible in the snapshot: a worker
    // inside writeChapterContent when remove(dir) landed writes its
    // images before content.json, so it recreates files in the
    // just-removed directory and then throws before
    // markChapterDownloaded. Files on disk, flag clear — the row reads
    // "not downloaded" and nothing would ever reclaim that space. So
    // the second sweep can't be conditional on the flag coming back.
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[1]).toEqual([2]);
  });

  it("re-sweeps a resurrected id that was not itself mid-flight", async () => {
    // The flag check spans every id we deleted, not just the ones the
    // queue reported as running, so a late write we didn't predict is
    // still caught.
    wasRunning = [2];
    resurrect = [1];
    await deleteChaptersWithQueue("e1", [1, 2]);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[1].slice().sort()).toEqual([1, 2]);
  });

  it("does not sweep twice when nothing was running", async () => {
    wasRunning = [];
    await deleteChaptersWithQueue("e1", [1, 2]);
    expect(deleteCalls).toHaveLength(1);
    expect(readSnapshotCalls).toBe(0);
  });

  it("is a no-op for an empty id list", async () => {
    const res = await deleteChaptersWithQueue("e1", []);
    expect(res).toEqual({ removed: [], cancelledRunning: [] });
    expect(cancelCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });
});

describe("preset predicates", () => {
  const flags = new Map([
    [1, { downloadedAt: 10, readAt: 20 }], // downloaded + read
    [2, { downloadedAt: 10 }],             // downloaded, unread
    [3, { readAt: 20 }],                   // read, never downloaded
    [4, {}],                               // neither
  ]);

  it("downloadedChapterIds picks everything on disk", () => {
    expect(downloadedChapterIds([1, 2, 3, 4], flags)).toEqual([1, 2]);
  });

  it("readDownloadedChapterIds needs BOTH flags", () => {
    // 3 is read but has nothing on disk to free; 2 is on disk but the
    // user hasn't finished it.
    expect(readDownloadedChapterIds([1, 2, 3, 4], flags)).toEqual([1]);
  });

  it("ignores ids absent from the flag map", () => {
    expect(downloadedChapterIds([99], flags)).toEqual([]);
    expect(readDownloadedChapterIds([99], flags)).toEqual([]);
  });
});
