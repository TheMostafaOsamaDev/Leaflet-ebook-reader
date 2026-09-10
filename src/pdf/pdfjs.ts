// Shared pdf.js glue for the PDF reading mode: a lazy-loaded worker plus a thin
// document facade (page count, metadata, outline, per-page size + canvas
// render). Mirrors the worker-load pattern already used by the web-novel PDF
// text extractor (src/sources/pdf/pdfChapter.ts) so the bundled offline worker
// is reused. pdf.js is heavy, so it is dynamically imported on first use.

import type { TocEntry } from "../types/reader";
import {
  createFileRangeTransport,
  RANGE_CHUNK,
  readFileRange,
} from "./rangeSource";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/** Lazy-load pdf.js and point it at the locally-bundled worker (offline-safe). */
export async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Vite returns the bundled worker URL via the ?url suffix (offline-safe).
      const workerUrl = (
        await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      ).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export interface PdfMeta {
  title?: string;
  author?: string;
}

/** A thin handle over one open PDF document. Pages are 0-based here (pdf.js is
 *  1-based internally — the facade converts). */
export interface PdfDoc {
  pageCount: number;
  meta: PdfMeta;
  outline: TocEntry[];
  /** True when page 1 carries an extractable text layer (selection/search). */
  hasTextLayer: boolean;
  /** Intrinsic CSS-pixel size of page `i` at the given scale. */
  pageViewport(i: number, scale: number): Promise<{ width: number; height: number }>;
  /** Render page `i` into `canvas` at `scale` (handles devicePixelRatio). */
  renderPage(i: number, canvas: HTMLCanvasElement, scale: number): Promise<void>;
  /** Render page `i`'s selectable text into `container` at `scale`.
   *
   *  A rendered PDF page is pixels, so selection and highlighting need pdf.js's
   *  text layer: transparent, absolutely-positioned spans laid over the canvas
   *  at the glyph positions the file declares. Styling lives in global.css
   *  (`.textLayer`) — pdf.js positions the spans against a `--scale-factor`
   *  custom property it expects the stylesheet to honour. */
  renderTextLayer(i: number, container: HTMLElement, scale: number): Promise<void>;
  destroy(): void;
}

/** Where a PDF's bytes come from.
 *
 *  The path form never materializes the file in JS — pdf.js pulls the ranges
 *  it needs through Rust (see rangeSource.ts), which is what keeps a 200 MB
 *  book from costing ~400 MB of webview heap. The bytes form is for tests,
 *  which hold a buffer and no Tauri. */
export type PdfSource = Uint8Array | { path: string; length: number };

export async function openPdfDocument(source: PdfSource): Promise<PdfDoc> {
  const pdfjs = await loadPdfjs();
  const doc = await loadDocument(pdfjs, source);

  const meta = await readMeta(doc);
  const outline = await buildOutline(doc);
  const hasTextLayer = await probeTextLayer(doc);

  // pdf.js forbids concurrent render() on the same canvas — cancel a canvas's
  // in-flight render before starting a new one (e.g. on fast scroll / rescale).
  const renderTasks = new WeakMap<
    HTMLCanvasElement,
    { cancel(): void; promise: Promise<void> }
  >();
  // Same idea for text layers: a container being re-laid-out at a new scale
  // must abandon the run already writing spans into it.
  const textTasks = new WeakMap<HTMLElement, { cancel(): void }>();

  return {
    pageCount: doc.numPages,
    meta,
    outline,
    hasTextLayer,
    async pageViewport(i, scale) {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale });
      return { width: vp.width, height: vp.height };
    },
    async renderPage(i, canvas, scale) {
      const prev = renderTasks.get(canvas);
      if (prev) {
        try {
          prev.cancel();
        } catch {
          // already settled
        }
      }
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale });
      // A 2D context's `direction` defaults to `inherit`, which resolves from
      // the canvas element's computed CSS. Mounted inside the reader's
      // `dir="rtl"` shell that makes it "rtl", and every `fillText` pdf.js
      // issues is then anchored from the opposite edge — glyph runs land in the
      // wrong places, words collide, and runs pushed past the edge disappear
      // entirely. A PDF carries its own text positions and must be drawn in a
      // direction-neutral context, so pin it regardless of where the canvas
      // hangs in the DOM.
      canvas.style.direction = "ltr";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.direction = "ltr";
      // Render at devicePixelRatio for crisp text, capped at 2× to bound memory.
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(vp.width * outputScale);
      canvas.height = Math.floor(vp.height * outputScale);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform:
          outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      });
      renderTasks.set(canvas, task);
      try {
        await task.promise;
      } catch {
        // cancelled / superseded by a newer render — ignore
      } finally {
        if (renderTasks.get(canvas) === task) renderTasks.delete(canvas);
      }
    },
    async renderTextLayer(i, container, scale) {
      textTasks.get(container)?.cancel();
      const page = await doc.getPage(i + 1);
      const viewport = page.getViewport({ scale });
      const textContentSource = await page.getTextContent();
      container.textContent = "";
      // pdf.js positions every span from this custom property; without it the
      // whole layer collapses into the top-left corner. The container's own box
      // is owned by whoever mounted it (PdfPageSource pins it over the canvas),
      // so nothing here sets width or height.
      container.style.setProperty("--scale-factor", String(scale));
      const layer = new pdfjs.TextLayer({
        textContentSource,
        container,
        viewport,
      });
      textTasks.set(container, layer);
      try {
        await layer.render();
      } catch {
        // cancelled / superseded — ignore
      } finally {
        if (textTasks.get(container) === layer) textTasks.delete(container);
      }
    },

    destroy() {
      void doc.destroy();
    },
  };
}

// ── internals (pdf.js's outline/metadata shapes are loosely typed) ──────────

/** Open the document, streaming it when we were handed a path. */
async function loadDocument(
  pdfjs: Awaited<ReturnType<typeof loadPdfjs>>,
  source: PdfSource,
) {
  if (source instanceof Uint8Array) {
    // Hand pdf.js its own copy — it may transfer/detach the buffer.
    return pdfjs.getDocument({ data: source.slice() }).promise;
  }
  try {
    const head = await readFileRange(
      source.path,
      0,
      Math.min(RANGE_CHUNK, source.length),
    );
    const range = createFileRangeTransport(
      pdfjs,
      source.path,
      source.length,
      head,
    );
    return await pdfjs.getDocument({
      range,
      rangeChunkSize: RANGE_CHUNK,
      // Fetch what the rendered pages need and nothing more — pulling the
      // whole file is the thing we are avoiding.
      disableAutoFetch: true,
      disableStream: true,
    }).promise;
  } catch (e) {
    // Correctness beats memory: if ranges don't work on this platform, fall
    // back to the old whole-file path rather than failing the import.
    // eslint-disable-next-line no-console
    console.warn("[pdf] range transport failed, falling back to whole file:", e);
    const { BaseDirectory, readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(source.path, { baseDir: BaseDirectory.AppData });
    return pdfjs.getDocument({ data: bytes.slice() }).promise;
  }
}

async function readMeta(doc: unknown): Promise<PdfMeta> {
  try {
    const { info } = (await (doc as any).getMetadata()) as {
      info?: { Title?: string; Author?: string };
    };
    return { title: info?.Title || undefined, author: info?.Author || undefined };
  } catch {
    return {};
  }
}

async function probeTextLayer(doc: unknown): Promise<boolean> {
  try {
    const page = await (doc as any).getPage(1);
    const tc = await page.getTextContent();
    return Array.isArray(tc.items) && tc.items.length > 0;
  } catch {
    return false;
  }
}

async function buildOutline(doc: unknown): Promise<TocEntry[]> {
  let raw: any[] | null = null;
  try {
    raw = await (doc as any).getOutline();
  } catch {
    raw = null;
  }
  if (!raw || raw.length === 0) return [];
  const out: TocEntry[] = [];
  const walk = async (items: any[], level: number) => {
    for (const it of items) {
      let page = 0;
      try {
        page = await destToPageIndex(doc, it.dest);
      } catch {
        page = 0;
      }
      out.push({
        title: String(it.title ?? "").trim(),
        dest: { fmt: "page", page },
        level,
      });
      if (Array.isArray(it.items) && it.items.length > 0) {
        await walk(it.items, level + 1);
      }
    }
  };
  await walk(raw, 0);
  return out;
}

async function destToPageIndex(doc: unknown, dest: unknown): Promise<number> {
  const explicit =
    typeof dest === "string" ? await (doc as any).getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit.length === 0) return 0;
  const idx = await (doc as any).getPageIndex(explicit[0]); // 0-based
  return typeof idx === "number" ? idx : 0;
}
