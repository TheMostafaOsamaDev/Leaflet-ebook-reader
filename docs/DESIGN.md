# Design notes

Source: `E-Book Reader.html` from the Leaflet design spec. These notes mirror the tokens actually in `src/styles/tokens.ts` — when the two disagree, the code is the source of truth.

## Themes

Four themes, all defined in `THEMES` keyed by `light | sepia | dark | oled`. The Library screenshot uses `sepia`:

| Token | sepia | light | dark | oled |
| --- | --- | --- | --- | --- |
| `bg` | `#f4ecd8` | `#faf8f3` | `#1a1614` | `#000000` |
| `paper` | `#f4ecd8` | `#ffffff` | `#1a1614` | `#000000` |
| `ink` | `#3a2f1f` | `#1f1a14` | `#d8cbb0` | `#b8ad94` |
| `muted` | `#8b7355` | `#8b7e6a` | `#887a60` | `#6a6148` |
| `chrome` | `#ebe0c5` | `#f0ece2` | `#24201c` | `#0c0a08` |
| `rule` | `rgba(58,47,31,0.14)` | `rgba(31,26,20,0.10)` | `rgba(216,203,176,0.14)` | `rgba(184,173,148,0.10)` |

Accent (copper amber): `#c96442` — used sparingly for highlight affordances.

## Typography

- **Display / logo / book titles**: `Fraunces`, italic cut. Falls back to `Literata`, `Georgia`.
- **Body / reader prose**: `Literata` (default reader font) — switchable to `Atkinson Hyperlegible` via the Settings panel.
- **UI / nav / buttons**: `Inter`, with `-apple-system` and `system-ui` fallbacks.
- **Arabic**: `Amiri`, falling back to `Noto Naskh Arabic` and `Scheherazade New`. Used for book titles in RTL languages and reader body when `book.language` matches `ar|he|fa|ur`.

Display font name constant: `FONT_SERIF_DISPLAY = '"Fraunces", "Literata", Georgia, serif'`.

## Library screen layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Leaflet    Library  Reading  Finished  Wishlist              + Import    │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐   CONTINUE READING                                         │
│  │ [cover]  │   Book title (big italic serif)                            │
│  │          │   by Author · N chapters                                   │
│  │          │                                                            │
│  │          │   ┌────────────────────────────────────┐                   │
│  │          │   │ ▓▓▓░░░░░░░░░░░░░  1% · 10h ago    │                   │
│  │          │   │ [ Resume reading → ]               │                   │
│  └──────────┘   └────────────────────────────────────┘                   │
│                                                                          │
│  Your shelf                                                              │
│  0 books · sorted by recent                                              │
│                                                                          │
│  [ grid, minmax(140px, 1fr), gap 32 ]                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

## The cover question (what this session was about)

Originally, any EPUB that didn't declare a cover through one of the two standard mechanisms fell through to `BookCover`'s placeholder path — a palette gradient with the title in italic serif and the author in spaced small caps.

`BookCover.tsx` already supports an `src` prop and shows a real `<img>` when it's truthy. The pipeline simply wasn't supplying one for EPUBs that:

- wrap the cover in an XHTML page (Calibre/Sigil convention),
- declare the cover image with `application/octet-stream`, or
- declare no cover at all.

The parser (`src/epub/parser.ts`) was extended to handle those cases. See `PROGRESS.md` for the five-tier resolution logic.

The placeholder path is kept on purpose — for the rare EPUB with genuinely no image inside, we still want the card to look like a book, not like a blank rectangle.

## Motion / interaction

- Card hover: soft delete `×` fades in (opacity 0 → 1 over ~120ms) in the top-right.
- Nav pills: active pill uses `theme.hover` background, not a solid accent.
- Buttons: dark pill, `theme.ink` background on `theme.bg` text. Hover states are minimal by design.
- Reader page turn: handled by the reader itself (`BookBody.tsx`) — not the library.

## Responsive rules

- Desktop: `DesktopLibrary` renders via `Library.tsx`. Two-column hero (cover left, card right), `repeat(auto-fill, minmax(140px, 1fr))` shelf grid.
- Mobile: `MobileLibrary` — cover inlined next to a compact Continue card; shelf collapses to a 3-col grid. Uses `useMediaQuery` to decide which to render.
