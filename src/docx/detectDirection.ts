// Pulls a language tag and reading direction out of a .docx zip.
//
// Strategy:
//   1. Inspect word/styles.xml + word/settings.xml for a default
//      `<w:lang w:val="..."/>` — that's the document's authored language.
//   2. Look for any `<w:bidi/>` or `<w:rtl/>` element in document.xml — a
//      strong RTL signal regardless of language tag.
//   3. Fallback: count characters in RTL Unicode ranges within document.xml's
//      visible text. If RTL chars dominate, treat the doc as RTL.
//
// We avoid full XML parsing — these are quick string scans against the
// extracted XML, which is plenty for this heuristic.

import JSZip from "jszip";

export type Dir = "ltr" | "rtl";

export interface DocDirection {
  /** BCP-47 tag, lowercased. Best-effort — falls back to "en". */
  lang: string;
  dir: Dir;
}

const RTL_LANG_PREFIXES = ["ar", "he", "fa", "ur", "ps", "sd", "ckb", "yi", "ku"];

// Arabic, Hebrew, Syriac, Thaana, NKo plus presentation forms.
const RTL_CHAR_RANGE =
  /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g;

export async function detectDocDirection(
  zip: JSZip,
): Promise<DocDirection> {
  const documentXml = await readMaybe(zip, "word/document.xml");
  const stylesXml = await readMaybe(zip, "word/styles.xml");
  const settingsXml = await readMaybe(zip, "word/settings.xml");

  // 1. Authored language from styles/settings, then the first `w:lang` we
  //    see anywhere in the document body.
  const lang =
    extractLang(stylesXml) ??
    extractLang(settingsXml) ??
    extractLang(documentXml) ??
    null;

  // 2. Explicit bidi markers in the body.
  const explicitlyRtl =
    !!documentXml &&
    (/<w:bidi(\s|\/>)/.test(documentXml) || /<w:rtl(\s|\/>)/.test(documentXml));

  // 3. RTL char count fallback — only consulted when neither of the above
  //    gives us a confident answer.
  const charBasedRtl = documentXml ? rtlByCharCount(documentXml) : false;

  let dir: Dir = "ltr";
  if (explicitlyRtl) dir = "rtl";
  else if (lang && isRtlLang(lang)) dir = "rtl";
  else if (charBasedRtl) dir = "rtl";

  // If we got dir=rtl from char-counting but no lang, infer one — the EPUB
  // OPF requires a `<dc:language>` and the reader picks default fonts off
  // it. "ar" is the highest-frequency RTL language, so it's the safer default.
  let resolvedLang = lang ?? (dir === "rtl" ? "ar" : "en");
  resolvedLang = resolvedLang.toLowerCase();

  return { lang: resolvedLang, dir };
}

async function readMaybe(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  try {
    return await file.async("string");
  } catch {
    return null;
  }
}

function extractLang(xml: string | null): string | null {
  if (!xml) return null;
  // First w:lang we encounter — covers both `w:val=` and `w:bidi=` (the
  // bidi attribute is the RTL-script lang). Prefer w:val if present.
  const valMatch = xml.match(/<w:lang\b[^/>]*\bw:val\s*=\s*["']([^"']+)["']/);
  if (valMatch) return valMatch[1];
  const bidiMatch = xml.match(
    /<w:lang\b[^/>]*\bw:bidi\s*=\s*["']([^"']+)["']/,
  );
  if (bidiMatch) return bidiMatch[1];
  return null;
}

function isRtlLang(tag: string): boolean {
  const lower = tag.toLowerCase();
  return RTL_LANG_PREFIXES.some(
    (p) => lower === p || lower.startsWith(p + "-"),
  );
}

function rtlByCharCount(xml: string): boolean {
  // Strip tags so we count text content, not attribute values.
  const text = xml.replace(/<[^>]*>/g, " ");
  const total = text.replace(/\s+/g, "").length;
  if (total < 20) return false;
  const matches = text.match(RTL_CHAR_RANGE);
  const rtlChars = matches ? matches.length : 0;
  return rtlChars / total > 0.25;
}
