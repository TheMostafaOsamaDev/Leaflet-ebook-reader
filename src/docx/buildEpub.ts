// Assembles a minimal but spec-compliant EPUB3 zip from a chapter list +
// optional cover + language/direction. The output is plain bytes that
// `parseEpub()` (the library's existing parser) can ingest unchanged — so
// the docx import path reuses every downstream code path: cover detection,
// chapter rendering, lastReadAt, etc.
//
// Layout produced:
//   mimetype                       (uncompressed, must be the first entry)
//   META-INF/container.xml
//   OEBPS/content.opf              (manifest + spine, language + dir, cover-image)
//   OEBPS/nav.xhtml                (EPUB3 nav doc)
//   OEBPS/style.css                (minimal stylesheet)
//   OEBPS/cover.<ext>              (cover image, if provided)
//   OEBPS/images/img-NNN.<ext>     (in-flow images extracted from the docx)
//   OEBPS/chapter-N.xhtml          (one per chapter)

import JSZip from "jszip";
import type { DocChapter } from "./splitChapters";
import type { Dir } from "./detectDirection";

export interface EpubMeta {
  title: string;
  author: string;
  language: string;
  dir: Dir;
}

export interface EpubCoverInput {
  bytes: Uint8Array;
  /** e.g. "image/jpeg", "image/png". */
  mimeType: string;
  /** lowercase, no dot. */
  extension: string;
}

/** An in-flow image extracted from the docx. The chapter HTML refers to
 *  this by `href` (relative to the chapter file); we mirror the file at
 *  `OEBPS/<href>` and add a manifest entry so the EPUB validates. */
export interface EpubBuildImage {
  /** Path relative to OEBPS, e.g. `images/img-001.png`. Matches what
   *  appears in `<img src="...">` inside chapter HTML. */
  href: string;
  bytes: Uint8Array;
  mimeType: string;
}

export async function buildEpub(
  meta: EpubMeta,
  chapters: DocChapter[],
  cover: EpubCoverInput | null,
  images: EpubBuildImage[] = [],
): Promise<Uint8Array> {
  const zip = new JSZip();

  // mimetype must be first and stored uncompressed per EPUB spec.
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE",
  });

  zip.file("META-INF/container.xml", containerXml());

  const oebps = zip.folder("OEBPS");
  if (!oebps) throw new Error("zip folder creation failed");

  // Chapter files. Use 3-digit zero-padded numbers so spine ordering matches
  // the alphabetic file ordering you'd see if anyone unzips the EPUB.
  const chapterEntries = chapters.map((ch, i) => {
    const id = `ch${String(i + 1).padStart(3, "0")}`;
    const href = `${id}.xhtml`;
    return { id, href, ...ch };
  });

  for (const ch of chapterEntries) {
    oebps.file(ch.href, chapterXhtml(meta, ch.title, ch.html));
  }

  oebps.file("nav.xhtml", navXhtml(meta, chapterEntries));
  oebps.file("style.css", styleCss(meta.dir));

  if (cover) {
    oebps.file(`cover.${cover.extension}`, cover.bytes);
  }

  // Drop each in-flow image at OEBPS/<href>. Chapters reference them by
  // the same relative path, so resolution from chapter file to image file
  // is straightforward.
  for (const img of images) {
    oebps.file(img.href, img.bytes);
  }

  oebps.file("content.opf", opfXml(meta, chapterEntries, cover, images));

  const out = await zip.generateAsync({
    type: "uint8array",
    // We already set mimetype to STORE; everything else compresses fine.
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return out;
}

function containerXml(): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`,
    `  <rootfiles>`,
    `    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>`,
    `  </rootfiles>`,
    `</container>`,
  ].join("\n");
}

function opfXml(
  meta: EpubMeta,
  chapters: { id: string; href: string; title: string }[],
  cover: EpubCoverInput | null,
  images: EpubBuildImage[],
): string {
  const uuid = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : fallbackUuid();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const manifestItems: string[] = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="style" href="style.css" media-type="text/css"/>`,
  ];
  if (cover) {
    manifestItems.push(
      `    <item id="cover-image" href="cover.${escapeXml(cover.extension)}" media-type="${escapeXml(cover.mimeType)}" properties="cover-image"/>`,
    );
  }
  // Manifest entries for each in-flow image. EPUB3 requires every file
  // referenced by chapter content to be in the manifest, otherwise strict
  // readers refuse to load it.
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const id = `img-${String(i + 1).padStart(3, "0")}`;
    manifestItems.push(
      `    <item id="${escapeXml(id)}" href="${escapeXml(img.href)}" media-type="${escapeXml(img.mimeType)}"/>`,
    );
  }
  for (const ch of chapters) {
    manifestItems.push(
      `    <item id="${escapeXml(ch.id)}" href="${escapeXml(ch.href)}" media-type="application/xhtml+xml"/>`,
    );
  }

  const spineAttrs =
    meta.dir === "rtl" ? ' page-progression-direction="rtl"' : "";
  const spineItems = chapters
    .map((ch) => `    <itemref idref="${escapeXml(ch.id)}"/>`)
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(meta.language)}">`,
    `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    `    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>`,
    `    <dc:title>${escapeXml(meta.title)}</dc:title>`,
    `    <dc:creator>${escapeXml(meta.author)}</dc:creator>`,
    `    <dc:language>${escapeXml(meta.language)}</dc:language>`,
    `    <meta property="dcterms:modified">${escapeXml(modified)}</meta>`,
    `  </metadata>`,
    `  <manifest>`,
    manifestItems.join("\n"),
    `  </manifest>`,
    `  <spine${spineAttrs}>`,
    spineItems,
    `  </spine>`,
    `</package>`,
  ].join("\n");
}

function navXhtml(
  meta: EpubMeta,
  chapters: { id: string; href: string; title: string }[],
): string {
  const items = chapters
    .map(
      (ch) =>
        `      <li><a href="${escapeXml(ch.href)}">${escapeXml(ch.title)}</a></li>`,
    )
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE html>`,
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(meta.language)}" xml:lang="${escapeXml(meta.language)}" dir="${meta.dir}">`,
    `<head><meta charset="utf-8"/><title>${escapeXml(meta.title)}</title></head>`,
    `<body>`,
    `  <nav epub:type="toc" id="toc">`,
    `    <h1>Contents</h1>`,
    `    <ol>`,
    items,
    `    </ol>`,
    `  </nav>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}

function chapterXhtml(meta: EpubMeta, title: string, bodyHtml: string): string {
  // The body HTML coming from mammoth is already valid HTML, but it's not
  // strict XHTML — self-closing tags like <br> and <img> aren't well-formed.
  // Run it through a minimal normalizer so the result parses as XHTML; the
  // existing parser falls back to text/html on parse errors anyway, but
  // valid XHTML keeps things tidy and makes the EPUB validator-friendly.
  const xhtmlBody = toXhtml(bodyHtml);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE html>`,
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeXml(meta.language)}" xml:lang="${escapeXml(meta.language)}" dir="${meta.dir}">`,
    `<head>`,
    `  <meta charset="utf-8"/>`,
    `  <title>${escapeXml(title)}</title>`,
    `  <link rel="stylesheet" type="text/css" href="style.css"/>`,
    `</head>`,
    `<body>`,
    xhtmlBody,
    `</body>`,
    `</html>`,
  ].join("\n");
}

function styleCss(dir: Dir): string {
  return [
    `body { line-height: 1.6; margin: 0 1em; }`,
    `h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 1.4em 0 0.5em; }`,
    `p { margin: 0.6em 0; }`,
    `img { max-width: 100%; height: auto; display: block; margin: 0.8em auto; }`,
    `ul, ol { padding-${dir === "rtl" ? "right" : "left"}: 1.4em; }`,
    `blockquote { margin: 0.8em 1.2em; font-style: italic; opacity: 0.9; }`,
  ].join("\n");
}

// ── helpers ───────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Self-close common HTML void elements so the chapter parses as XHTML.
// Mammoth produces well-formed-ish HTML otherwise (escapes &, etc.).
const VOID_ELEMENTS = ["br", "hr", "img", "meta", "link", "input"];

function toXhtml(html: string): string {
  let out = html;
  for (const tag of VOID_ELEMENTS) {
    // <tag ... > or <tag>  →  <tag ... />
    const re = new RegExp(`<${tag}\\b([^>]*?)(?<!/)>`, "gi");
    out = out.replace(re, `<${tag}$1/>`);
  }
  return out;
}

function fallbackUuid(): string {
  // Tauri's webview always has crypto.randomUUID; this is a safety net for
  // contexts where it might be missing. RFC4122 v4 shape, low-quality.
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-4${r().slice(1)}-a${r().slice(1)}-${r()}${r()}${r()}`;
}
