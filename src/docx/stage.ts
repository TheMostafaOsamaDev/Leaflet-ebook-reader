// In-memory staging for "manage before importing" docx flow.
//
// After mammoth has converted the doc, we hold its HTML + image bytes in
// memory long enough for the user to:
//   - pick a cover from the doc's images (or skip)
//   - delete or keep individual content blocks
// On commit we re-run the chapter splitter + EPUB builder over the edited
// HTML; on cancel we just drop the session.
//
// "Block" = one top-level direct child of the doc body (a paragraph, heading,
// list, image-only paragraph, blockquote, table, etc.). Pages are not a
// thing in docx — pagination depends on the renderer's font/page metrics —
// so we let the user manage at this granularity instead. Headings remain
// visible in the list so they can navigate before deleting spans.
//
// Image refs inside HTML use a synthetic `staging://<imgId>` URI so we don't
// commit to any in-flow vs cover decision until commit. `finalizeStaging()`
// strips the chosen cover img and rewrites the rest to `images/img-NNN.<ext>`.

import type { Dir } from "./detectDirection";

export interface StagedImage {
  /** Stable id, e.g. "img-001". Embedded in HTML as `staging://<id>`. */
  id: string;
  bytes: Uint8Array;
  mimeType: string;
  /** lowercase, no dot. */
  extension: string;
  /**
   * Object URL for previewing in the manage view. Created at conversion
   * time so the manage UI can render thumbnails without re-encoding.
   * disposeStaging() revokes these.
   */
  blobUrl: string;
}

export type BlockType =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "img"
  | "list"
  | "blockquote"
  | "table"
  | "other";

export interface StagedBlock {
  /** Stable, sequential index assigned at parse time. Used as React key,
   *  selection identifier, and for the "Page N" label in the UI. */
  id: number;
  type: BlockType;
  /** Original tag name, e.g. "P", "H1", "UL" — kept around so the UI can
   *  show a precise badge without re-deriving from `type`. */
  tag: string;
  /** Plain text snippet, whitespace-collapsed and truncated to PREVIEW_CHARS.
   *  Empty for image-only or table-only blocks. */
  textPreview: string;
  /** Original outerHTML — preserved verbatim so the rebuild step can
   *  re-emit exactly the markup mammoth produced. */
  html: string;
  /** Staging image IDs referenced inside this block. Multiple are possible
   *  (a paragraph with several inline images). */
  imageIds: string[];
}

export interface StagedDocx {
  /** Filename portion of the picked path, used as the dialog header and as
   *  the title fallback. */
  sourceFilename: string;
  /** Best-guess display title — first heading text or the filename. The
   *  manage view exposes this as an editable field before commit. */
  fallbackTitle: string;
  language: string;
  dir: Dir;
  blocks: StagedBlock[];
  imagesById: Map<string, StagedImage>;
  /** Image IDs in document order — drives the gallery without needing to
   *  walk the Map iteration order. */
  imageOrder: string[];
}

export interface StagingEdits {
  /** IDs of blocks to KEEP in the final EPUB. Stored as a kept-set rather
   *  than a deleted-set so a hypothetical late-arriving block (re-render of
   *  the source) can't sneak in by being absent from a deleted-set. */
  keptBlockIds: Set<number>;
  /** Image to extract as cover. null = no cover (default if the doc has no
   *  images, or the user explicitly chose "no cover"). */
  coverImageId: string | null;
}

/** Plain-text preview length per block. Long enough to identify the block,
 *  short enough that 1000s of cards stay snappy. */
export const PREVIEW_CHARS = 220;

const STAGING_PREFIX = "staging://";

export function stagingSrc(imageId: string): string {
  return STAGING_PREFIX + imageId;
}

function parseStagingId(src: string | null): string | null {
  if (!src) return null;
  return src.startsWith(STAGING_PREFIX)
    ? src.slice(STAGING_PREFIX.length)
    : null;
}

/** Walk the body's direct children, capturing each as a StagedBlock. Done
 *  once at conversion time — manage view never re-parses. */
export function createBlocksFromHtml(html: string): StagedBlock[] {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    "text/html",
  );
  const out: StagedBlock[] = [];
  let nextId = 0;
  for (const el of Array.from(doc.body.children)) {
    out.push(makeBlock(nextId++, el));
  }
  return out;
}

function makeBlock(id: number, el: Element): StagedBlock {
  const tag = el.tagName.toUpperCase();
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const textPreview =
    text.length > PREVIEW_CHARS
      ? text.slice(0, PREVIEW_CHARS - 1) + "…"
      : text;
  const imgs = Array.from(el.querySelectorAll("img"));
  const imageIds = imgs
    .map((img) => parseStagingId(img.getAttribute("src")))
    .filter((s): s is string => s !== null);
  // An <img>-only paragraph (no text, only image children) reads as an
  // image block in the UI even though the tag is `<p>` — flag it so the
  // gallery / list can surface it correctly.
  const type: BlockType =
    text.length === 0 && imageIds.length > 0 ? "img" : blockTypeFor(tag);
  return { id, tag, type, textPreview, html: el.outerHTML, imageIds };
}

function blockTypeFor(tag: string): BlockType {
  switch (tag) {
    case "H1":
      return "h1";
    case "H2":
      return "h2";
    case "H3":
      return "h3";
    case "H4":
      return "h4";
    case "H5":
      return "h5";
    case "H6":
      return "h6";
    case "P":
      return "p";
    case "UL":
    case "OL":
      return "list";
    case "BLOCKQUOTE":
      return "blockquote";
    case "TABLE":
      return "table";
    default:
      return "other";
  }
}

export interface FinalizedStaging {
  /** Re-assembled HTML, ready for splitHtmlIntoChapters. Cover image refs
   *  removed; in-flow image refs rewritten to `images/img-NNN.<ext>`. */
  html: string;
  /** In-flow images that survived the edit pass, in the order they're first
   *  referenced in the assembled HTML. Feed straight to buildEpub(). */
  images: { href: string; bytes: Uint8Array; mimeType: string }[];
  /** Cover image (if a cover was selected and still exists). */
  cover: { bytes: Uint8Array; mimeType: string; extension: string } | null;
}

/**
 * Produce buildEpub() inputs from a staging session + the user's edits.
 *
 * Steps:
 *   1. Drop excluded blocks.
 *   2. Strip any <img staging://${coverId}…> tags so the chosen cover
 *      doesn't also appear in the body.
 *   3. Walk what's left to find every still-referenced image id, rewrite
 *      the staging:// markers to the final in-flow href, and emit
 *      manifest entries in encounter order.
 *   4. Sweep stragglers — img tags with a staging:// src that no longer
 *      point at any present image (deleted along with their block, or the
 *      block was removed but re-quoted somewhere odd). Removes the empty
 *      tag so the EPUB doesn't ship broken-image placeholders.
 */
export function finalizeStaging(
  staged: StagedDocx,
  edits: StagingEdits,
): FinalizedStaging {
  const keptBlocks = staged.blocks.filter((b) =>
    edits.keptBlockIds.has(b.id),
  );
  let html = keptBlocks.map((b) => b.html).join("\n");

  if (edits.coverImageId !== null) {
    html = stripImgTagsFor(html, edits.coverImageId);
  }

  const usedIds = collectUsedIds(html);
  const finalImages: FinalizedStaging["images"] = [];
  let counter = 1;
  for (const imgId of usedIds) {
    const img = staged.imagesById.get(imgId);
    if (!img) continue;
    const href = `images/img-${String(counter).padStart(3, "0")}.${img.extension}`;
    counter++;
    finalImages.push({ href, bytes: img.bytes, mimeType: img.mimeType });
    html = html.split(stagingSrc(imgId)).join(href);
  }
  // Any remaining staging:// img tags point at images that no longer exist
  // (deleted by the edit pass) — drop the empty tags rather than ship
  // broken refs.
  html = html.replace(
    /<img\b[^>]*\bsrc=["']staging:\/\/[^"']+["'][^>]*\/?>/gi,
    "",
  );

  let cover: FinalizedStaging["cover"] = null;
  if (edits.coverImageId !== null) {
    const coverImg = staged.imagesById.get(edits.coverImageId);
    if (coverImg) {
      cover = {
        bytes: coverImg.bytes,
        mimeType: coverImg.mimeType,
        extension: coverImg.extension,
      };
    }
  }
  return { html, images: finalImages, cover };
}

function stripImgTagsFor(html: string, imageId: string): string {
  const target = stagingSrc(imageId);
  // Escape regex specials in the URI (slash, colon, etc. — ID chars are
  // safe but defensively escape anyway).
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<img\\b[^>]*\\bsrc=["']${escaped}["'][^>]*\\/?>`,
    "gi",
  );
  return html.replace(re, "");
}

function collectUsedIds(html: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /staging:\/\/([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

/** Revoke every blob URL held by a staging session. Call after a successful
 *  commit or when the user cancels the manage view. */
export function disposeStaging(staged: StagedDocx): void {
  for (const img of staged.imagesById.values()) {
    URL.revokeObjectURL(img.blobUrl);
  }
}

/** Default keep-all + first-image-as-cover edits. Mirrors the legacy
 *  behavior the direct-import path used to bake into the conversion step. */
export function defaultEdits(staged: StagedDocx): StagingEdits {
  return {
    keptBlockIds: new Set(staged.blocks.map((b) => b.id)),
    coverImageId: staged.imageOrder[0] ?? null,
  };
}
