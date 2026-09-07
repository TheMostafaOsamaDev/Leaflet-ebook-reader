// Cover for the one race that makes a delete look like it did nothing:
// cancellation in this queue is cooperative, so a job that has already
// started keeps going until its current fetch resolves. If the worker
// writes after the user deleted, the chapter comes back.
//
// Two halves: cancelJobsForChapters' bookkeeping (which jobs it takes,
// and which of them were mid-flight), and the worker-side polls inside
// downloadChapter that make the cancellation actually stick.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable so the downloadChapter tests can install a real snapshot and
// source while the cancelJobsForChapters tests keep the nulls they
// were written against. Read at call time, never in the vi.mock
// factory, so the hoisting order doesn't matter.
let snapshot: unknown = null;
let source: unknown = null;
let writeCalls = 0;
let markCalls = 0;

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 13 },
  exists: async () => false,
  mkdir: async () => {},
  readTextFile: async () => "{}",
  writeTextFile: async () => {},
}));
vi.mock("./legacyRoot", () => ({
  ROOT: "riwaq",
  LEGACY_ROOT: "leaflet",
  migrateLegacyRoot: async () => {},
}));
vi.mock("./sessionExpiry", () => ({
  isSessionExpiredError: () => false,
  notifySessionExpired: async () => {},
  resetSessionExpiredNotices: () => {},
}));
vi.mock("../sources/host", () => ({ createHost: () => ({}) }));
vi.mock("../sources/registry", () => ({ getSource: () => source }));
vi.mock("./sourceLibrary", () => ({
  readSnapshot: async () => snapshot,
  writeChapterContent: async () => {
    writeCalls++;
  },
  markChapterDownloaded: async () => {
    markCalls++;
  },
}));

import {
  cancelJobsForChapters,
  clearTerminals,
  downloadChapter,
  enqueue,
  getState,
} from "./downloadQueue";

beforeEach(() => {
  clearTerminals();
  for (const j of getState().jobs) j.status = "cancelled";
  clearTerminals();
  snapshot = null;
  source = null;
  writeCalls = 0;
  markCalls = 0;
});

describe("cancelJobsForChapters", () => {
  it("cancels queued jobs for the named chapters only", () => {
    // Saturate the default concurrency (2) with filler jobs from an
    // unrelated entry first. enqueue() pumps synchronously, so with a
    // free worker slot a freshly-enqueued job is promoted to "running"
    // before this test body gets to inspect it — these fillers keep
    // the chapters under test genuinely "queued".
    enqueue({
      libraryEntryId: "filler", chapterId: 100,
      novelTitle: "N", chapterTitle: "F1",
    });
    enqueue({
      libraryEntryId: "filler", chapterId: 101,
      novelTitle: "N", chapterTitle: "F2",
    });
    enqueue({
      libraryEntryId: "e1", chapterId: 1,
      novelTitle: "N", chapterTitle: "C1",
    });
    enqueue({
      libraryEntryId: "e1", chapterId: 2,
      novelTitle: "N", chapterTitle: "C2",
    });

    const res = cancelJobsForChapters("e1", [1]);
    expect(res.cancelled).toEqual([1]);

    const forCh1 = getState().jobs.find(
      (j) => j.kind === "chapter" && j.chapterId === 1,
    );
    const forCh2 = getState().jobs.find(
      (j) => j.kind === "chapter" && j.chapterId === 2,
    );
    expect(forCh1?.status).toBe("cancelled");
    expect(forCh2?.status).not.toBe("cancelled");
  });

  it("ignores jobs belonging to another library entry", () => {
    enqueue({
      libraryEntryId: "other", chapterId: 1,
      novelTitle: "N", chapterTitle: "C1",
    });
    const res = cancelJobsForChapters("e1", [1]);
    expect(res.cancelled).toEqual([]);
  });

  it("reports a running job as wasRunning rather than cancelled outright", () => {
    enqueue({
      libraryEntryId: "e1", chapterId: 7,
      novelTitle: "N", chapterTitle: "C7",
    });
    const job = getState().jobs.find(
      (j) => j.kind === "chapter" && j.chapterId === 7,
    )!;
    job.status = "running";

    const res = cancelJobsForChapters("e1", [7]);
    // A started job can't be yanked mid-fetch — the worker flips the
    // status when its fetch resolves. The caller needs to know so it
    // can say "cancelled and deleted".
    expect(res.wasRunning).toEqual([7]);
  });

  it("is a no-op for an empty id list", () => {
    const res = cancelJobsForChapters("e1", []);
    expect(res).toEqual({ cancelled: [], wasRunning: [] });
  });
});

describe("downloadChapter's cooperative cancellation polls", () => {
  // A chapter with no image lines, so the worker's image loop makes no
  // host calls and the only onProgress ticks are the phase boundaries.
  const install = () => {
    snapshot = {
      sourceId: "s1",
      volumes: [
        { id: 1, chapters: [{ id: 5, title: "C5", url: "https://x/5" }] },
      ],
    };
    source = {
      getChapterContent: async () => [{ type: "text", content: "hello" }],
    };
  };

  it("does not write chapter content once cancellation is known", async () => {
    // This is the poll the `onProgress?.(0.9)` line in downloadChapter
    // exists to be — runChapterJob's onProgress throws CancelledError
    // for a cancelled job, so a throw at 0.9 stands in for one. Without
    // that line the worker recreates content.json and the images inside
    // the directory a concurrent delete just removed.
    install();
    await expect(
      downloadChapter("e1", 5, (p) => {
        if (p >= 0.9) throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(writeCalls).toBe(0);
    expect(markCalls).toBe(0);
  });

  it("still guards the downloaded flag when cancellation lands after the write", async () => {
    // The second poll's narrower job: the content is already on disk,
    // but downloadedAt must not flip on for a chapter the user deleted.
    // Asserting both polls separately is what keeps the earlier one
    // from being mistaken for a duplicate of this one.
    install();
    await expect(
      downloadChapter("e1", 5, (p) => {
        if (p >= 0.95) throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(writeCalls).toBe(1);
    expect(markCalls).toBe(0);
  });

  it("writes and marks when nothing cancels it", async () => {
    install();
    await downloadChapter("e1", 5);
    expect(writeCalls).toBe(1);
    expect(markCalls).toBe(1);
  });
});
