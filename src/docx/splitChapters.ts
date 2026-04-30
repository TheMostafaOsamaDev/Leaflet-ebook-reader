// Splits mammoth's HTML output into chapters keyed off heading elements.
//
// We auto-detect the chapter break level: pick the highest heading level
// (lowest number) that actually appears in the document. So an H2-only
// document still chapters cleanly, and a doc that mixes H1+H2 breaks at
// H1 with H2s living inside chapters as subheads.
//
// Content that appears before the first chapter heading becomes its own
// "Preface"-style chapter so we don't drop it on the floor.

export interface DocChapter {
  /** Chapter heading text, plain. Falls back to "Chapter N" for unnamed
   *  chapters and "Preface" for content before the first heading. */
  title: string;
  /** Inner HTML for the chapter body — already escaped/sanitized by mammoth.
   *  Includes the chapter heading itself (as <h1>) so the reader can render
   *  it inline. */
  html: string;
}

const HEADING_TAGS = ["H1", "H2", "H3", "H4", "H5", "H6"] as const;

export function splitHtmlIntoChapters(html: string): DocChapter[] {
  // mammoth returns body-content-only HTML; wrap so DOMParser builds a body.
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    "text/html",
  );
  const body = doc.body;
  const breakTag = pickBreakLevel(body);

  // No headings at all → single chapter, title = first non-empty paragraph
  // text or fallback. Important fallback: lots of plain-text-style docs
  // ship without any heading styles applied.
  if (!breakTag) {
    const title = firstParagraphText(body) ?? "Document";
    return [{ title: truncateTitle(title), html }];
  }

  const chapters: DocChapter[] = [];
  let buffer: string[] = [];
  let currentTitle: string | null = null;

  const flush = () => {
    const innerHtml = buffer.join("").trim();
    if (innerHtml.length === 0 && currentTitle === null) return;
    chapters.push({
      title: currentTitle ?? "Preface",
      html: innerHtml,
    });
    buffer = [];
  };

  for (const node of Array.from(body.children)) {
    if (node.tagName === breakTag) {
      flush();
      currentTitle = (node.textContent ?? "").trim() || `Chapter ${chapters.length + 1}`;
      // Keep the heading at the top of the chapter so the reader sees a
      // proper title in-flow as well.
      buffer.push(node.outerHTML);
    } else {
      buffer.push(node.outerHTML);
    }
  }
  flush();

  // Edge case: every chapter ended up empty — fall back to single-chapter.
  if (chapters.length === 0) {
    return [{ title: "Document", html }];
  }

  // Number unnamed chapters (the heading text was empty). We had filled in
  // "Chapter N" earlier; keep that. Truncate to keep nav titles tidy.
  return chapters.map((c) => ({ ...c, title: truncateTitle(c.title) }));
}

/** The highest-level heading actually present, or null if none. */
function pickBreakLevel(body: HTMLElement): (typeof HEADING_TAGS)[number] | null {
  for (const tag of HEADING_TAGS) {
    if (body.querySelector(tag.toLowerCase())) return tag;
  }
  return null;
}

function firstParagraphText(body: HTMLElement): string | null {
  const p = body.querySelector("p");
  const text = p?.textContent?.trim();
  return text && text.length > 0 ? text : null;
}

function truncateTitle(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return collapsed.slice(0, 77) + "…";
}
