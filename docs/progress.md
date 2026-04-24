# Progress Log

## 2026-04-24 — Day 1

### Done
- Fetched the design bundle, confirmed it is a Claude Design handoff tarball.
- Extracted it to `/tmp/design-extract/e-book-reader/` and read the README, chat
  transcript, and every JSX source file.
- Identified what to implement (the app: reader, panels, library, themes) vs.
  what to skip (design-canvas wrapper, iOS status bar frame, tweaks debug panel,
  sync-conflict splash — all prototype-only chrome).
- Scaffolded a Tauri v2 + React 19 + TypeScript + Vite project with
  `cargo create-tauri-app` (pnpm package manager, react-ts template).
- Pinned the Tauri window to sensible reader defaults in `tauri.conf.json`
  (1280×820, min 720×540, resizable, proper product name/title).

### Next
- ~~Implement the design system (tokens, fonts, global CSS).~~ **Done** —
  `src/styles/tokens.ts` + `src/styles/global.css`.
- ~~Port reader-data into a TypeScript module.~~ **Done** — `src/data/book.ts`.
- ~~Build ReaderCore.~~ **Done** — `src/components/BookBody.tsx` + `Icon.tsx`.
- ~~Build the 5 panels.~~ **Done** — `src/panels/*`.
- ~~Build the desktop shell, mobile shell, and library.~~ **Done** —
  `DesktopReader.tsx`, `MobileReader.tsx` (with tap-to-toggle chrome + bottom
  sheets via `MobileSheet.tsx`), `Library.tsx`.
- **Deferred** — `pnpm tauri android init`. This host doesn't have the Android
  SDK / NDK / rustup targets installed. `docs/setup.md` walks the user through
  installing them and then running `pnpm tauri android init` once. The app
  code itself is already Android-ready: no web-only APIs, no Electron-isms,
  responsive breakpoint at 720px, safe-area-inset padding on the mobile
  chrome, and `mobile_entry_point` wired in `src-tauri/src/lib.rs`.

### Verifications
- `pnpm build` — passes clean, 237 KB JS bundle (72 KB gzipped), 1.7 KB CSS.
- `cargo check` — passes clean on the Tauri crate.
- TypeScript is strict; no `any` leaks, no suppressions.

### Decisions
- **Keep the prototype's visual vocabulary verbatim** (the tokens, color
  palettes, typography scale) but rewrite the logic idiomatically in React +
  TypeScript instead of transplanting the `Object.assign(window, …)` pattern.
- **Skip the iOS device frame.** The prototype wrapped the mobile view in a
  fake iPhone chrome for presentation; in a real Tauri app the OS provides the
  chrome, so rendering an iOS frame on Android would be absurd. The mobile
  layout adapts via `@media (max-width)` instead.
- **No design canvas.** The prototype was a Figma-style zoomable canvas
  showing every state side-by-side. The real app just needs to *be* those
  states.

---

## 2026-04-24 — Day 2 · EPUB upload & reading

### Done
- Removed the dummy book module. Content now comes from imported EPUBs.
- Added `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`, `jszip`, and
  the matching Rust plugins (`tauri-plugin-dialog`, `tauri-plugin-fs`) plus
  `dialog:default` + `fs:*` permissions in `capabilities/default.json`.
- Wrote `src/epub/parser.ts` — a client-side EPUB 2/3 parser using JSZip +
  DOMParser. Handles: `META-INF/container.xml` → OPF resolution, OPF
  manifest + spine + DC metadata, EPUB 3 `nav.xhtml` TOC, EPUB 2 NCX TOC
  fallback, and per-chapter block-level paragraph extraction. Chapter
  titles come from the nav/NCX when available, first heading otherwise.
- Wrote `src/store/library.ts` — a file-backed library on top of Tauri's
  `$APPDATA/leaflet/` directory:
  - `books/<id>/book.json` — the parsed EpubBook
  - `books/<id>/state.json` — bookmarks + current chapter
  - `library.json` — index so the Library view can render without
    touching per-book files
  - Exports: `pickAndImportEpub`, `listBooks`, `loadBook`,
    `updateReadingPosition`, `saveBookmark`, `deleteBookmark`,
    `deleteBook`.
- Added `src/store/palette.ts` — deterministic OKLCH-derived 3-color
  palette from a book id so covers stay distinct without extracted
  images. (Extracting real EPUB cover art is a follow-up.)
- Rewrote `BookBody` to render a single `EpubChapter` + `chapterCount`,
  auto-stripping a duplicate chapter-title paragraph when the EPUB's
  XHTML already contains the heading.
- `Library` now loads real entries, renders an empty state ("Import your
  first EPUB"), has an Import button in both desktop and mobile layouts,
  per-card hover delete on desktop, and friendly error banners.
- `DesktopReader` + `MobileReader` take a real `book + state +
  currentChapter`, with prev/next chapter navigation (desktop also wires
  ←/→ keyboard shortcuts), a progress bar scaled to `currentChapter /
  chapterCount`, and a bookmark toggle that writes through the store.
- `TOCPanel` takes real chapters and jumps to `chapter.order`.
- `BookmarksPanel` + `HighlightsPanel` got empty states; bookmarks gain
  jump-to-chapter + delete affordances.
- `ProgressOverlay` pulls its numbers from the live book state instead
  of hardcoded strings.

### Verifications
- `pnpm build` → clean, 345 KB JS (106 KB gzipped) including JSZip.
- `cargo check` → clean with the new `tauri-plugin-dialog` +
  `tauri-plugin-fs` crates pulled in.

### Deferred (real follow-ups, not skipped-forever)
- **Inline highlights.** The paragraph model is `{ text }[]` — plain
  text only. To persist user highlights we'll need a stable offset
  scheme (paragraph index + character range, already the shape the
  `InlineHighlight` prototype used). Highlights are defined in the
  `Highlight` type and stored under `state.highlights`, but the reader
  UI doesn't yet render them inline.
- **Text selection → highlight / note creation.** Needs a small
  selection-popover component; out of scope for this pass.
- **Rich inline formatting.** We throw away `<em>`, `<strong>`, `<a>`,
  etc. during paragraph extraction. Preserving these would mean keeping
  a sanitized HTML string per paragraph (or a small AST) rather than
  plain text. Defer until highlights need it.
- **Search inside a book.** Chapter text is all in memory after load,
  so a simple `includes()` sweep will work — just no UI for it yet.

---

## 2026-04-24 — Day 2 · Cover extraction

### Done
- `parseEpub` now also returns any cover image. Detection order:
  1. EPUB 3 manifest item with `properties="cover-image"`.
  2. EPUB 2 `<meta name="cover" content="<idref>"/>` in the OPF.
  3. Filename/id heuristic (`*cover*` in a manifest item that's `image/*`).
  Cover bytes + MIME type + extension come back as `EpubCover`.
- On import, the store writes the cover to `books/<id>/cover.<ext>` and
  records `coverFile` on the index entry.
- Enabled Tauri's `assetProtocol` in `tauri.conf.json` with a scope of
  `$APPDATA/leaflet/**` (and `$APPLOCALDATA` for good measure), so the
  webview can read cover files directly via `convertFileSrc`.
- `coverSrcFor(entry)` in `store/library.ts` builds the asset URL on
  demand (with a cache-buster tied to `addedAt`).
- `Library` resolves all cover URLs up front in parallel and passes
  them through to `BookCover`.
- `BookCover` got an optional `src` prop: when set it renders the
  real image; on `onError` or when `src` is missing, it falls back to
  the existing palette + title design. The spine-shadow gradient is
  kept in both modes so the cover still reads as a book spine.

### File map
```
src/
├── App.tsx                        # book load/unload, state wiring
├── epub/
│   ├── parser.ts                  # JSZip + DOMParser EPUB 2/3 parser
│   └── types.ts                   # EpubBook, EpubChapter
├── store/
│   ├── library.ts                 # $APPDATA-backed import/list/load
│   └── palette.ts                 # deterministic cover palette
├── components/{Icon,BookBody,BookCover,Library,DesktopReader,MobileReader,MobileSheet}
├── panels/{PanelShell,TOCPanel,BookmarksPanel,HighlightsPanel,SettingsPanel,ProgressOverlay}
├── hooks/{useTweaks,useMediaQuery}
├── styles/{tokens.ts, global.css}
└── types/reader.ts                # ActivePanel, Tweaks
```
