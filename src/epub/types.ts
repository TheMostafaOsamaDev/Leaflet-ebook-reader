export interface EpubChapter {
  /** Unique id within the book — matches the manifest idref from the spine. */
  id: string;
  /** Relative href from the manifest, used as a cache key when following links. */
  href: string;
  /** Best-effort chapter title (from nav TOC if available, else first heading). */
  title: string;
  /** Paragraph-level text, already stripped of inline HTML. */
  paragraphs: { text: string }[];
  /** 0-based position in the spine. */
  order: number;
}

export interface EpubBook {
  /** Generated id for local storage. */
  id: string;
  title: string;
  author: string;
  /** BCP-47 tag from OPF `<dc:language>`. Used to auto-enable RTL for ar/he/fa/ur. */
  language: string;
  chapters: EpubChapter[];
}

export interface EpubCover {
  bytes: Uint8Array;
  /** Canonical MIME type from the OPF manifest (e.g. `image/jpeg`). */
  mimeType: string;
  /** File extension to use on disk, lowercase, without the dot. */
  extension: string;
}

/** What `parseEpub` returns — the book plus any extracted cover. */
export interface ParsedEpub {
  book: EpubBook;
  cover?: EpubCover;
}
