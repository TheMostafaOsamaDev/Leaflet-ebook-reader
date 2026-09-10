// A read-only view of an EPUB zip, so the parser doesn't care whether the
// archive is a buffer in JS memory or a file the Rust side owns.
//
// The native variant is the one that matters. On Android every Tauri invoke
// is JSON-serialized into `window.ipc.postMessage` (the custom-protocol IPC
// is disabled there because the webview can't read a request body), and that
// serializer expands a `Uint8Array` payload with `Array.from(bytes)` — one
// array element per byte. Past V8's `FixedArray::kMaxLength` (134_217_725)
// that throws `RangeError: Invalid array length`, which is why a 206 MB EPUB
// could not be imported at all. Below the ceiling it still costs a ~4x JSON
// blow-up per file written.
//
// So: bulk bytes stay in Rust. JS pulls only the text entries it has to
// parse (OPF, nav/NCX, chapter XHTML — tens of KB each) and asks Rust to
// move everything else straight from the archive to disk.

import JSZip from "jszip";
import { invoke } from "@tauri-apps/api/core";

/** One entry to pull out of the archive and drop on disk. */
export interface ExtractRequest {
  /** Entry name inside the zip. */
  entry: string;
  /** Destination path, relative to the app-data dir. */
  dest: string;
}

export interface ZipSource {
  /** True when the archive holds a file (not a directory) at `path`. */
  has(path: string): boolean;
  /** Entry as UTF-8 text, or null when it's missing / unreadable. */
  readText(path: string): Promise<string | null>;
  /** Entry as raw bytes. Only for single small entries (covers) — bulk data
   *  should go through `extract` and never enter JS at all. */
  readBytes(path: string): Promise<Uint8Array | null>;
  /** Warm the text cache for several entries at once. The native source
   *  turns this into a single IPC round trip; the in-memory one is a no-op
   *  beyond filling its own cache. */
  prefetchText(paths: string[]): Promise<void>;
  /** Copy entries out to disk. Returns one flag per request, in order. */
  extract(items: ExtractRequest[]): Promise<boolean[]>;
  /** Release whatever the source is holding. */
  dispose(): void;
}

// ── native (file on disk, Rust owns the bytes) ─────────────────────────────

/** Entries per `zip_read_texts` call. Batching is the point — one IPC round
 *  trip instead of one per chapter — but an unbounded batch would ask Rust to
 *  hand back an arbitrarily large payload in a single response. */
const TEXT_BATCH = 64;

/**
 * Open an archive that already lives under the app-data dir. `path` is
 * app-data-relative, e.g. `riwaq/books/<id>/book.epub`.
 *
 * `token` correlates the Rust-side progress events with a specific import.
 */
export async function openNativeZip(
  path: string,
  token: string,
): Promise<ZipSource> {
  const names: string[] = await invoke("zip_entries", { path });
  const present = new Set(names);
  const textCache = new Map<string, string | null>();

  return {
    has: (p) => present.has(p),

    async readText(p) {
      if (textCache.has(p)) return textCache.get(p) ?? null;
      if (!present.has(p)) return null;
      const [text]: (string | null)[] = await invoke("zip_read_texts", {
        path,
        entries: [p],
      });
      textCache.set(p, text ?? null);
      return text ?? null;
    },

    async readBytes(p) {
      if (!present.has(p)) return null;
      try {
        const buf = await invoke<ArrayBuffer>("zip_read_bytes", {
          path,
          entry: p,
        });
        return new Uint8Array(buf);
      } catch {
        return null;
      }
    },

    async prefetchText(paths) {
      const wanted = paths.filter((p) => present.has(p) && !textCache.has(p));
      for (let i = 0; i < wanted.length; i += TEXT_BATCH) {
        const chunk = wanted.slice(i, i + TEXT_BATCH);
        const texts: (string | null)[] = await invoke("zip_read_texts", {
          path,
          entries: chunk,
        });
        chunk.forEach((p, j) => {
          // Only cache hits. A null here can mean "over this batch's size
          // budget" rather than "missing", so leave it uncached and let
          // readText fetch it on its own where the budget is per-entry.
          const text = texts[j];
          if (typeof text === "string") textCache.set(p, text);
        });
      }
    },

    async extract(items) {
      if (items.length === 0) return [];
      return invoke("zip_extract", { path, items, token });
    },

    dispose() {
      textCache.clear();
    },
  };
}

// ── in-memory (JSZip) ──────────────────────────────────────────────────────

/**
 * Wrap a zip that only exists as bytes in JS. Used by tests; the app's own
 * import paths stage to disk first so they can use `openNativeZip` instead.
 */
export async function openMemoryZip(
  bytes: ArrayBuffer | Uint8Array,
  writeBytes?: (dest: string, data: Uint8Array) => Promise<void>,
): Promise<ZipSource> {
  const zip = await JSZip.loadAsync(bytes);
  const present = new Set<string>();
  zip.forEach((relPath, file) => {
    if (!file.dir) present.add(relPath);
  });

  return {
    has: (p) => present.has(p),

    async readText(p) {
      const f = zip.file(p);
      if (!f) return null;
      try {
        return await f.async("string");
      } catch {
        return null;
      }
    },

    async readBytes(p) {
      const f = zip.file(p);
      if (!f) return null;
      try {
        return await f.async("uint8array");
      } catch {
        return null;
      }
    },

    async prefetchText() {
      // Entries are already decompressed on demand from a local buffer;
      // there's no round trip to batch away.
    },

    async extract(items) {
      if (!writeBytes) {
        throw new Error("in-memory zip source cannot extract without a writer");
      }
      const out: boolean[] = [];
      for (const item of items) {
        const f = zip.file(item.entry);
        if (!f) {
          out.push(false);
          continue;
        }
        try {
          // One at a time, and the reference is dropped straight after the
          // write, so peak memory stays at a single entry rather than the
          // whole image set.
          await writeBytes(item.dest, await f.async("uint8array"));
          out.push(true);
        } catch {
          out.push(false);
        }
      }
      return out;
    },

    dispose() {
      present.clear();
    },
  };
}
