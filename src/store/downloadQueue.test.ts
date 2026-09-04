// Cover for the one race that makes a delete look like it did nothing:
// cancellation in this queue is cooperative, so a job that has already
// started keeps going until its current fetch resolves. If the worker
// writes after the user deleted, the chapter comes back.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../sources/registry", () => ({ getSource: () => null }));
vi.mock("./sourceLibrary", () => ({
  readSnapshot: async () => null,
  writeChapterContent: async () => {},
  markChapterDownloaded: async () => {},
}));

import {
  cancelJobsForChapters,
  clearTerminals,
  enqueue,
  getState,
} from "./downloadQueue";

beforeEach(() => {
  clearTerminals();
  for (const j of getState().jobs) j.status = "cancelled";
  clearTerminals();
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
