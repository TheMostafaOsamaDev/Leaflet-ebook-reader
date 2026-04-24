# Design notes

## Source

The design came as a handoff bundle from Claude Design, extracted to
`/tmp/design-extract/e-book-reader/`. Key source files read before
implementing:

- `README.md` — instructions ("read the chat first, implement pixel-perfect,
  don't copy the prototype's internal structure unless it fits").
- `chats/chat1.md` — the design conversation. Most important info:
  - **Aesthetic**: warm, sepia-leaning defaults, rounded corners, friendly.
  - **Content**: web-novel tone (Reverend Insanity, Lord of the Mysteries
    vibes — cultivation/mystery fiction).
  - **Mobile gestures**: tap center to show/hide chrome.
  - **Library**: mixed — hero "continue reading" then grid.
  - **Tweaks**: theme (light/sepia/dark/OLED), font family
    (serif/sans/dyslexic), font size, alignment, line-height + letter-
    spacing, RTL toggle.
  - **RTL**: Arabic should be first-class, not a bolt-on.
- `project/reader-core.jsx` — theme tokens, highlight color primitives,
  paragraph renderer, icon set.
- `project/reader-data.jsx` — chapter list, paragraphs (with the inline
  highlight ranges), library, bookmarks, highlights, RTL excerpt.
- `project/reader-panels.jsx` — TOC, Bookmarks, Highlights, Settings panels.
- `project/reader-desktop.jsx` — desktop reader shell.
- `project/reader-mobile.jsx` — mobile reader + library.
- `project/reader-library.jsx` — desktop library hero + grid.

## Tokens (ported verbatim)

| | bg | ink | muted | chrome |
|---|---|---|---|---|
| sepia | `#f4ecd8` | `#3a2f1f` | `#8b7355` | `#ebe0c5` |
| light | `#faf8f3` | `#1f1a14` | `#8b7e6a` | `#f0ece2` |
| dark | `#1a1614` | `#d8cbb0` | `#887a60` | `#24201c` |
| oled | `#000000` | `#b8ad94` | `#6a6148` | `#0c0a08` |

Accent: `#c96442` (warm copper amber, used for focus rings).

Highlight colors (semantically used as filters in `HighlightsPanel`):
- yellow → "Quotes"
- blue → "Facts"
- pink → "Questions"
- green → "Definitions"

## Typography

- **Fraunces** — display serif, italic by default on headings. Variable
  font, weights 400–700, optical size 9–144.
- **Literata** — body serif, book-optimized.
- **Inter** — UI chrome.
- **Atkinson Hyperlegible** — dyslexic-friendly option in the font picker.
- **Amiri** — Arabic body/heading font.

All are Google-Fonts-hosted and preconnected in `index.html`; no self-
hosting, no font bundling, no `@font-face` rules.

## Deliberately skipped from the prototype

- `ios-frame.jsx` — fake iPhone chrome used for the design canvas. A real
  app on Android doesn't need it.
- `tweaks-panel.jsx` — floating debug panel wired to the design-canvas
  host's edit protocol. Real reader settings live in `SettingsPanel`.
- `reader-sync.jsx` — a dedicated sync / conflict-resolution splash screen.
  We show cloud-synced status in the topbar but did not port the full
  conflict UI yet (it's a pillar-showcase feature).
- `design-canvas.jsx` — the Figma-style pan/zoom wrapper that presented
  every artboard side by side. The real app is just the artboards.
- The RTL mirrored *chrome* (not content): the prototype mirrored the
  topbar layout when `rtl` was on. We keep the chrome LTR and only flip
  the reading surface — standard for reading apps, avoids re-mirroring the
  settings UI.

## Pixel-perfectness

Where a value was in the prototype, it was ported verbatim: paddings,
border widths, shadow tuples, `boxShadow` strings on book covers, corner
radii. The only numeric changes:

- Desktop minimum window size set to 720×540 (prototype had no native
  window; 720 matches the mobile breakpoint).
- Mobile ribbon top position bumped slightly so it doesn't collide with
  safe-area insets (the prototype used a fixed iOS frame offset).
