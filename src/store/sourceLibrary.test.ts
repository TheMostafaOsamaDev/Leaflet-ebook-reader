// Cover for the batch chapter-delete primitive. The interesting
// properties aren't "the file is gone" (trivially true against a fake
// fs) but the three invariants a bulk delete can silently break:
// readAt must survive, source.json must be written exactly once no
// matter how many chapters are deleted, and a chapter whose directory
// is already missing must still get its flag cleared.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Paths that "exist" in the fake fs, and the text of each file. */
let files = new Map<string, string>();
let dirs = new Set<string>();
let writeCount = 0;
let removed: Array<{ path: string; recursive: boolean }> = [];

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 13 },
  exists: async (p: string) => files.has(p) || dirs.has(p),
  mkdir: async (p: string) => {
    dirs.add(p);
  },
  readTextFile: async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeTextFile: async (p: string, s: string) => {
    writeCount++;
    files.set(p, s);
  },
  writeFile: async () => {},
  remove: async (p: string, o?: { recursive?: boolean }) => {
    removed.push({ path: p, recursive: !!o?.recursive });
    if (!files.has(p) && !dirs.has(p)) throw new Error(`ENOENT: ${p}`);
    dirs.delete(p);
    files.delete(p);
    for (const k of [...files.keys()]) if (k.startsWith(p + "/")) files.delete(k);
    for (const k of [...dirs]) if (k.startsWith(p + "/")) dirs.delete(k);
  },
  readDir: async () => [],
  rename: async () => {},
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/appdata",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("./legacyRoot", () => ({
  ROOT: "riwaq",
  LEGACY_ROOT: "leaflet",
  migrateLegacyRoot: async () => {},
}));

import {
  deleteChapterDownload,
  deleteChapterDownloads,
  readSnapshot,
  type SourceSnapshot,
} from "./sourceLibrary";

const ENTRY = "entry-1";
const SNAP_PATH = `riwaq/books/${ENTRY}/source.json`;
const chapterDirOf = (id: number) =>
  `riwaq/books/${ENTRY}/chapters/${String(id).padStart(5, "0")}`;

/** A snapshot with `n` downloaded chapters in one volume. Chapters with
 *  an even id are also marked read, so every assertion about readAt has
 *  both a read and an unread case in the same fixture. */
function seed(n: number): SourceSnapshot {
  const snap: SourceSnapshot = {
    version: 1,
    sourceId: "test-source",
    novelUrl: "https://example.test/novel",
    title: "Test Novel",
    author: "Author",
    language: "ar",
    direction: "rtl",
    tags: [],
    meta: [],
    fetchedAt: 1000,
    volumes: [
      {
        id: 1,
        title: "Volume 1",
        chaptersLoaded: true,
        chapters: Array.from({ length: n }, (_, i) => ({
          id: i + 1,
          title: `Chapter ${i + 1}`,
          url: `https://example.test/c/${i + 1}`,
          downloadedAt: 5000 + i,
          ...((i + 1) % 2 === 0 ? { readAt: 9000 + i } : {}),
        })),
      },
    ],
  };
  files.set(SNAP_PATH, JSON.stringify(snap));
  for (let i = 1; i <= n; i++) {
    dirs.add(chapterDirOf(i));
    files.set(`${chapterDirOf(i)}/content.json`, "{}");
  }
  return snap;
}

beforeEach(() => {
  files = new Map();
  dirs = new Set();
  writeCount = 0;
  removed = [];
});

describe("deleteChapterDownloads", () => {
  it("clears downloadedAt on exactly the requested chapters", async () => {
    seed(5);
    const { removed: gone } = await deleteChapterDownloads(ENTRY, [2, 4]);
    expect(gone.sort()).toEqual([2, 4]);

    const after = await readSnapshot(ENTRY);
    const byId = new Map(after!.volumes[0].chapters.map((c) => [c.id, c]));
    expect(byId.get(2)!.downloadedAt).toBeUndefined();
    expect(byId.get(4)!.downloadedAt).toBeUndefined();
    expect(byId.get(1)!.downloadedAt).toBeDefined();
    expect(byId.get(3)!.downloadedAt).toBeDefined();
    expect(byId.get(5)!.downloadedAt).toBeDefined();
  });

  it("preserves readAt on deleted chapters", async () => {
    seed(5);
    await deleteChapterDownloads(ENTRY, [2, 4]);

    const after = await readSnapshot(ENTRY);
    const byId = new Map(after!.volumes[0].chapters.map((c) => [c.id, c]));
    // 2 and 4 are even, so the fixture marked them read. Freeing disk
    // must not reset progress.
    expect(byId.get(2)!.readAt).toBe(9001);
    expect(byId.get(4)!.readAt).toBe(9003);
  });

  it("writes source.json exactly once regardless of chapter count", async () => {
    seed(40);
    writeCount = 0;
    await deleteChapterDownloads(
      ENTRY,
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    // The regression guard. Looping the single-chapter version would
    // make this 40.
    expect(writeCount).toBe(1);
  });

  it("removes each chapter directory recursively", async () => {
    seed(3);
    await deleteChapterDownloads(ENTRY, [1, 2, 3]);
    expect(removed).toHaveLength(3);
    // Non-recursive removal silently fails on a chapter folder that
    // ever gains a subdirectory, while the flag still flips.
    expect(removed.every((r) => r.recursive)).toBe(true);
  });

  it("clears the flag even when the directory is already gone", async () => {
    seed(3);
    dirs.delete(chapterDirOf(2));
    files.delete(`${chapterDirOf(2)}/content.json`);

    const { removed: gone } = await deleteChapterDownloads(ENTRY, [2]);
    expect(gone).toEqual([2]);

    const after = await readSnapshot(ENTRY);
    const c2 = after!.volumes[0].chapters.find((c) => c.id === 2)!;
    expect(c2.downloadedAt).toBeUndefined();
  });

  it("reports progress for the caller's counter", async () => {
    seed(3);
    const seen: Array<[number, number]> = [];
    await deleteChapterDownloads(ENTRY, [1, 2, 3], (done, total) =>
      seen.push([done, total]),
    );
    expect(seen[seen.length - 1]).toEqual([3, 3]);
  });

  it("returns a null snapshot when the entry has none", async () => {
    const { removed: gone, snapshot } = await deleteChapterDownloads(
      "missing-entry",
      [1],
    );
    expect(gone).toEqual([]);
    expect(snapshot).toBeNull();
  });

  it("skips the snapshot write when no requested id is in the listing", async () => {
    seed(3);
    writeCount = 0;
    const { removed: gone } = await deleteChapterDownloads(ENTRY, [99]);
    expect(gone).toEqual([]);
    // Rewriting a snapshot that didn't change is a multi-MB serialize
    // and write on a 950-chapter novel, for nothing.
    expect(writeCount).toBe(0);
  });

  it("is a no-op for an empty id list", async () => {
    seed(3);
    writeCount = 0;
    const { removed: gone } = await deleteChapterDownloads(ENTRY, []);
    expect(gone).toEqual([]);
    expect(writeCount).toBe(0);
  });
});

describe("deleteChapterDownload", () => {
  it("delegates to the batch version for one chapter", async () => {
    seed(3);
    const snap = await deleteChapterDownload(ENTRY, 2);
    const c2 = snap!.volumes[0].chapters.find((c) => c.id === 2)!;
    expect(c2.downloadedAt).toBeUndefined();
    expect(c2.readAt).toBe(9001);
    expect(removed).toEqual([{ path: chapterDirOf(2), recursive: true }]);
  });
});
