# Leaflet — Progress Log

A calm, minimal EPUB reader built with **Tauri v2 + React + TypeScript**. Desktop + Android.

---

## Sessions

### 2026-04-24 (second pass) — Self-healing covers

**Problem:** the parser fix from the earlier pass only helps **new** imports. The book already in the library (the Gu Zen Ren one in the screenshot) was written by the old code and its index entry has no `coverFile`, so no amount of parser improvement can retroactively help it.

**Fix:** three changes that make covers heal themselves from now on.

1. **`importEpubBytes` now saves `book.epub`.** The original zip lives at `$APPDATA/leaflet/books/<id>/book.epub` alongside `book.json`. Costs a few MB of disk per book but unlocks everything below.
2. **`rescanCover(id)`** — new public function. Reads the stored EPUB, re-runs the parser, writes the newly-found cover to disk, updates `coverFile` + `coverBust` on the index entry.
3. **`setCoverFromFile(id)`** — new public function. Opens the file picker for images, copies whichever one the user picks into the book dir as the cover.
4. **Auto-backfill** — `listBooks()` fires a background `backfillMissingCovers` that loops every entry without a cover and quietly calls `rescanCover` on it. No UI flash; the next `listBooks()` call shows populated covers.
5. **`coverBust` timestamp** — the index entry now stores a bump counter, and `coverSrcFor` uses it to cache-bust the asset URL. Without this, the webview would serve the stale placeholder even after we replaced the file on disk.
6. **UI affordance — `CoverFixHint`.** Only shown when a card is falling back to the placeholder; overlays two tiny pill buttons at the bottom of the cover: **Rescan** (re-runs extraction from saved EPUB) and **Set cover…** (opens the image picker). Both stop propagation so clicking them doesn't also open the book.

**For the book already in the library (pre-fix):** it has no saved `book.epub`, so `Rescan` will surface "Couldn't find a cover in the original EPUB." Use **Set cover…** to attach any image, or delete it and use Import EPUB again — the re-import will both save the zip *and* extract the cover with the new parser.

Every future book is covered either way: if the EPUB has a cover anywhere findable, the auto-backfill finds it on the next app launch; if not, **Set cover…** is a one-click escape hatch.

**Files touched in this pass:**

- `src/store/library.ts` — added `book.epub` persistence, `rescanCover`, `setCoverFromFile`, `backfillMissingCovers`, `coverBust` field.
- `src/components/Library.tsx` — added `CoverFixHint` overlay; threaded `onRescanCover` / `onSetCover` through Library → DesktopLibrary → HeroContinueCard + LibraryCard.

---

### 2026-04-24 — Cover extraction fix

**Problem reported:** the Continue Reading card rendered the book's title on a green gradient instead of the EPUB's actual cover image. The book in question is an Arabic fan-translated web novel (*المجلد الأول: طبيعة الشيطان لا تتغير* by Gu Zen Ren).

**Root cause:** `src/epub/parser.ts → readCover()` only accepted a manifest item as a cover when:

1. it carried `properties="cover-image"` (EPUB 3), or
2. a `<meta name="cover">` pointed at it (EPUB 2), or
3. its id/href contained `cover` AND its `media-type` started with `image/`.

That last `AND` is where the Gu Zen Ren EPUB slipped through. Many fan-translated EPUBs (and Calibre-exported ones) do one of:

- Wrap the cover image in a `cover.xhtml` page and mark that xhtml as the EPUB 2 `meta[name=cover]` target, instead of pointing directly at the image.
- Tag the cover image file with `application/octet-stream` — so `startsWith("image/")` returns false.
- Ship a `cover.xhtml` with `<svg><image xlink:href="…"></svg>` rather than a plain `<img>`.
- Declare no cover metadata at all, just put the cover image as the first manifest/spine entry.

**Fix:** `readCover()` now has five tiers, in order:

| Tier | Strategy |
| --- | --- |
| 1 | `properties="cover-image"` (EPUB 3) |
| 2 | `<meta name="cover">` (EPUB 2) |
| 3 | If tiers 1–2 landed on an XHTML, unwrap it — read the first `<img src>` or `<svg><image xlink:href>` inside, resolve against the wrapper's dir, match back to a manifest entry |
| 4 | Scan the first four spine items; unwrap any XHTML whose id/href looks like a cover page |
| 5 | Filename heuristic (`/cover/` in id or href) on any manifest item that *looks* like an image — judged by mime **or** by extension (`.jpg .jpeg .png .gif .webp .svg .avif`) |
| 6 | Last resort: the first image-like manifest entry |

Accepting by extension fixes the `application/octet-stream` case. Unwrapping XHTML fixes the Calibre/Sigil case.

**Blast radius:** zero — existing books that already have `coverFile` set keep working exactly as before. The new paths only run when the old ones fail.

**Note for the user:** the book already in your library was imported *before* this fix, so its index entry has no `coverFile`. To see the cover:

1. Hover the card in the shelf → click the small × in the top-right to delete it, or use the Continue Reading delete path.
2. Click **+ Import EPUB** and pick the same file again.

Going forward, every new import will find the cover if the EPUB has one at all.

---

## Current architecture (unchanged by this session)

- **Frontend**: React 19 + TypeScript + Vite in `src/`.
- **EPUB parser**: pure JS, in `src/epub/parser.ts`, using `jszip` + `DOMParser`. No epub.js — we chose a leaner custom parser that emits paragraph-level text.
- **Library persistence**: Tauri's `plugin-fs` writes under `$APPDATA/leaflet/books/<bookId>/`, with a top-level `library.json` index. Cover images live alongside `book.json` so the asset protocol can serve them directly.
- **Asset protocol**: `src-tauri/tauri.conf.json` exposes `$APPDATA/leaflet/**` and `$APPLOCALDATA/leaflet/**` to the webview via `convertFileSrc`. No cover ever has to be base64'd into the DOM — they load as native `<img src>`.
- **Mobile**: Tauri v2's mobile target uses the same webview bundle. The frontend branches between `DesktopReader` and `MobileReader` based on a media query in `useMediaQuery.ts`.

## File map

```
.
├── docs/                        ← this file + design/arch/setup/android notes
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   │   ├── Library.tsx          ← passes covers[id] → <BookCover src={…}>
│   │   ├── BookCover.tsx        ← renders <img> when src is truthy
│   │   ├── DesktopReader.tsx
│   │   ├── MobileReader.tsx
│   │   ├── BookBody.tsx
│   │   └── Icon.tsx / MobileSheet.tsx
│   ├── epub/
│   │   ├── parser.ts            ← PATCHED today
│   │   └── types.ts
│   ├── store/
│   │   ├── library.ts           ← coverSrcFor uses convertFileSrc
│   │   └── palette.ts
│   ├── panels/                  ← TOC / Bookmarks / Highlights / Settings
│   ├── hooks/
│   ├── styles/
│   └── types/
├── src-tauri/
│   ├── src/ (lib.rs, main.rs)
│   ├── capabilities/default.json
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── package.json
├── tsconfig*.json
└── vite.config.ts
```

## What to run locally

```bash
pnpm install             # or npm install
pnpm tauri dev           # desktop
pnpm tauri android init  # one time, then:
pnpm tauri android dev   # android emulator / device
```

## Open follow-ups (not done this session)

- Persist original EPUB bytes on import so we can retroactively re-scan covers when the parser improves — currently a parser fix like today's doesn't help books that were imported yesterday.
- Add a dev-only "Re-scan" action on the library card's hover menu for the same purpose, as a lighter alternative.
- Tauri `android` target has never been initialized here; `src-tauri/gen/android/` doesn't exist yet. Run `pnpm tauri android init` once you're in a shell.
