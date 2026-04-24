# Architecture

## Layout

```
Leaflet-ebook-reader/
├── index.html                      # Vite entry, loads Google Fonts
├── package.json                    # pnpm-managed; scripts: dev/build/tauri
├── vite.config.ts
├── tsconfig.json                   # strict TS
├── src/
│   ├── main.tsx                    # React root
│   ├── App.tsx                     # book load/unload + screen + shell switch
│   ├── epub/
│   │   ├── parser.ts               # parseEpub(bytes) → EpubBook
│   │   └── types.ts                # EpubBook, EpubChapter
│   ├── store/
│   │   ├── library.ts              # $APPDATA library: import/list/load/delete/progress/bookmarks
│   │   └── palette.ts              # deterministic OKLCH palette from book id
│   ├── styles/
│   │   ├── global.css              # reset, scrollbar, range input styling
│   │   └── tokens.ts               # THEMES, HIGHLIGHT_COLORS, FONT_STACKS, hlBg
│   ├── types/reader.ts             # ActivePanel, Tweaks
│   ├── hooks/
│   │   ├── useTweaks.ts            # persisted reader preferences
│   │   └── useMediaQuery.ts        # responsive breakpoint helper
│   ├── components/
│   │   ├── Icon.tsx                # stroke-based icon set
│   │   ├── BookBody.tsx            # chapter renderer (paragraphs)
│   │   ├── BookCover.tsx           # palette-driven cover spine
│   │   ├── Library.tsx             # hero + grid + import + empty state
│   │   ├── DesktopReader.tsx       # topbar + side panels, keyboard nav
│   │   ├── MobileReader.tsx        # tap-to-toggle chrome + bottom sheets
│   │   └── MobileSheet.tsx         # reusable bottom-sheet overlay
│   └── panels/
│       ├── PanelShell.tsx          # shared panel sidebar frame
│       ├── TOCPanel.tsx            # table of contents (real chapters)
│       ├── BookmarksPanel.tsx      # bookmark list + empty state
│       ├── HighlightsPanel.tsx     # highlights + empty state
│       ├── SettingsPanel.tsx       # theme / font / spacing / RTL
│       └── ProgressOverlay.tsx     # chapter-aware progress card
├── src-tauri/
│   ├── Cargo.toml                  # opener + dialog + fs plugins
│   ├── tauri.conf.json             # window size, identifier, bundle targets
│   ├── capabilities/default.json   # dialog:default + fs scopes for $APPDATA
│   └── src/lib.rs                  # Builder registers opener + dialog + fs
└── docs/                           # this folder
```

## Screens & state

`App.tsx` keeps five pieces of runtime state:

1. **`tweaks`** — reader preferences, persisted to `localStorage`
   (`useTweaks`). Source of truth for theme, font, RTL, etc.
2. **`loaded`** — when non-null, the library is hidden and the reader
   takes over. Shape: `{ book: EpubBook, state: BookState,
   currentChapter: number }`.
3. **`activePanel`** — which desktop side panel is open. Mobile sheets
   manage their own local equivalent.
4. **`loading`** / **`error`** — transient flags for book-load UX.

There's no router. The library renders when `loaded === null`, the
reader renders when it's set.

## Data flow: upload → read

```
user clicks Import
  └─→ pickAndImportEpub()         // store/library.ts
        ├─ dialog.open() → path
        ├─ fs.readFile(path) → Uint8Array
        ├─ parseEpub(bytes) → EpubBook         // epub/parser.ts
        │     ├─ JSZip.loadAsync
        │     ├─ META-INF/container.xml → OPF path
        │     ├─ OPF: dc:title/creator/language + manifest + spine
        │     ├─ EPUB 3 nav.xhtml OR EPUB 2 NCX → chapter titles
        │     └─ each spine item → XHTML → block-level paragraphs
        ├─ fs.writeTextFile($APPDATA/leaflet/books/<id>/book.json)
        ├─ fs.writeTextFile($APPDATA/leaflet/books/<id>/state.json)
        └─ append to $APPDATA/leaflet/library.json → BookIndexEntry

user clicks a library card
  └─→ loadBook(id) → { book, state }
        ├─ readTextFile(book.json)
        └─ readTextFile(state.json) with defaults if missing

chapter change / bookmark toggle
  └─→ updateReadingPosition / saveBookmark / deleteBookmark
        ├─ rewrite state.json
        └─ update progress field in library.json
```

## EPUB parsing model

The parser deliberately throws away inline formatting: each paragraph is
just `{ text }`. Doing that lets the reader apply user typography
consistently (font family, size, line height, alignment, theme) without
fighting the EPUB's stylesheet, and also keeps the persisted `book.json`
small. The trade-off — losing italics, links, inline images — is the
main thing on the follow-up list. See `docs/progress.md`.

For paragraph extraction we query block-level elements (`p`, `h1-h6`,
`blockquote`, `li`, `figcaption`) and skip any element whose ancestor is
also a block, to avoid duplicating text from nested structures.

TOC comes from either the EPUB 3 nav document (preferred) or the EPUB 2
NCX, with a fall-back to the chapter's first heading when neither
resolves. Titles are looked up by three candidate keys (raw href,
nav-relative, opf-relative) because real-world EPUBs are inconsistent
about relative paths.

## Storage layout ($APPDATA/leaflet/)

```
library.json                         {version:1, books:[BookIndexEntry]}
books/<book-id>/
  ├── book.json                      full EpubBook (chapters inline)
  └── state.json                     {bookId, currentChapter, bookmarks, highlights}
```

All IDs are `crypto.randomUUID()`; uniqueness is per-import, so the same
EPUB imported twice produces two distinct library entries. De-duping by
content hash is a possible refinement.

## Responsive shell selection

`App.tsx` reads `useMediaQuery('(max-width: 720px)')` and picks
`<MobileReader>` below 720px, `<DesktopReader>` above. The library has
its own `layout` prop driven by the same breakpoint.

## Theme switching

`THEMES` in `tokens.ts` is the single source of truth. The `theme`
object is passed down as a prop (not context) so overriding per-surface
stays easy if we later want (e.g.) a permanently sepia library with a
dark reader.

RTL is a reader-only concern — `BookBody` flips `dir="rtl"` and swaps in
the Amiri font stack when `tweaks.rtl` is on. The library stays LTR.

## What's still intentionally not there

- **No Rust commands.** The entire EPUB pipeline is TypeScript. If
  parsing becomes a bottleneck on large books we can move it behind a
  `#[tauri::command]`, but JSZip + DOMParser is well under 200ms for a
  typical novel.
- **No state library.** Tweaks persistence + local component state is
  all we do; Redux / Zustand would be overkill.
- **No routing library.** Two screens, switched by one bit of state.
