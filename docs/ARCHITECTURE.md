# Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Tauri v2 shell                             │
│  Desktop: Wry webview (Windows/macOS/Linux)                        │
│  Android: WebView + Tauri mobile runtime                           │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
              ┌────────────────┴─────────────────┐
              │   React 19 + Vite bundle         │
              │  ┌─────────────────────────────┐ │
              │  │ App.tsx (view = library|    │ │
              │  │          reader state)      │ │
              │  │   ├── Library               │ │
              │  │   │    ├── DesktopLibrary   │ │
              │  │   │    └── MobileLibrary    │ │
              │  │   └── Reader                │ │
              │  │        ├── DesktopReader    │ │
              │  │        └── MobileReader     │ │
              │  │                              │ │
              │  │  epub/parser.ts  ← jszip    │ │
              │  │  store/library.ts           │ │
              │  └──────────────┬──────────────┘ │
              │                 │                │
              │                 ▼                │
              └─────────────────┼────────────────┘
                                │ plugin-fs / plugin-dialog
                                ▼
              ┌──────────────────────────────────┐
              │  Tauri plugins (Rust)            │
              │   • plugin-dialog — file picker  │
              │   • plugin-fs — AppData R/W      │
              │   • plugin-opener                │
              │                                  │
              │   asset:// → AppData/leaflet/** │
              │     (serves cover images to     │
              │      the webview via            │
              │      convertFileSrc)            │
              └──────────────────────────────────┘
```

## Why this shape

- **Pure-JS EPUB parser, not epub.js.** `src/epub/parser.ts` uses `jszip` to unzip the book and the standard `DOMParser` to parse OPF / nav / NCX / XHTML. This keeps the reader layer independent of epub.js's iframe-based rendering — we emit paragraph-level text that `BookBody.tsx` renders itself, which means typography, RTL, and highlights are all native React.
- **Tauri owns the filesystem, the webview owns everything else.** Rust only needs to host the webview, surface the system file picker, and serve `$APPDATA/leaflet/**` over `asset://`. No custom Rust commands needed.
- **State**: no Redux, no zustand. Local `useState` in `Library.tsx` and `Reader.tsx`, persisted via `store/library.ts` whenever the user causes a durable change (import, delete, progress tick, bookmark).
- **Routing**: a single `view` state in `App.tsx` (`"library" | "reader"`). Mobile-friendly and avoids a router dep.

## Cover extraction pipeline

```
pickAndImportEpub()
  └─ open() → path
  └─ readFile(path) → Uint8Array
  └─ importEpubBytes(bytes)
       └─ parseEpub(buffer)
            ├─ readOpfPath(zip)      # META-INF/container.xml
            ├─ readSpine(opf)        # <itemref> order
            ├─ readNavTitles(zip, …) # EPUB3 nav or EPUB2 NCX
            └─ readCover(zip, …)     ← 5-tier resolver (see PROGRESS.md)
       └─ write:
            $APPDATA/leaflet/books/<id>/book.json
            $APPDATA/leaflet/books/<id>/state.json
            $APPDATA/leaflet/books/<id>/cover.<ext>   (if cover found)
       └─ push index entry to library.json with coverFile set

coverSrcFor(entry)
  └─ join(appDataDir, "leaflet", "books", entry.id, entry.coverFile)
  └─ convertFileSrc(abs)  → asset://localhost/<encoded>
  └─ append ?v=<addedAt> so replacing a book bypasses the webview cache
```

## Storage layout

Everything lives under the per-app AppData dir:

```
$APPDATA/leaflet/
├── library.json                 # { version: 1, books: BookIndexEntry[] }
└── books/
    └── <bookId>/
        ├── book.json            # parsed EpubBook (title, author, chapters, paragraphs)
        ├── state.json           # { currentChapter, bookmarks, highlights }
        └── cover.<jpg|png|…>    # optional; absent when parseEpub found no cover
```

`BookIndexEntry.coverFile` is the filename of the cover on disk. `coverSrcFor` turns it into a `convertFileSrc` URL the webview can load directly.

## Mobile-specific notes

- Tauri v2 mobile uses the same bundle — no separate code path beyond the responsive layout split inside `Library.tsx` / `Reader.tsx`.
- `plugin-dialog.open` works on Android via the system document picker (`ACTION_OPEN_DOCUMENT`), which grants scoped read on the picked file. That's why we never ask for `READ_EXTERNAL_STORAGE`.
- `plugin-fs` under Android writes to app-private storage — the same `AppData` dir pattern resolves to the app's internal files dir, inaccessible to other apps, which is what we want for a private reading library.

## Capabilities

`src-tauri/capabilities/default.json` grants:

- `core:default`, `opener:default` — baseline + shell open.
- `dialog:default` — the file picker.
- `fs:*` with `$APPDATA/**` and `$APPLOCALDATA/**` scope — read/write under the app dir. No access outside it.

The asset protocol scope in `tauri.conf.json` narrows that further for webview-loadable URLs: only `$APPDATA/leaflet/**` and `$APPLOCALDATA/leaflet/**` can be served over `asset://`.
