# Leaflet — Docs

This folder tracks the implementation of the **Leaflet** e-book reader, rebuilt from a Claude Design handoff bundle as a cross-platform Tauri v2 app (desktop + Android).

## Files

- [`progress.md`](./progress.md) — running log of what was done, in order.
- [`design-notes.md`](./design-notes.md) — design-system tokens, scope, and what was deliberately left out.
- [`architecture.md`](./architecture.md) — project layout, module boundaries, data flow.
- [`setup.md`](./setup.md) — how to run, build, and bundle for desktop + Android.

## Source design

The source handoff bundle is at `/tmp/design-extract/e-book-reader/` (from
`https://api.anthropic.com/v1/design/h/emiMjccCOYPCWsDrTlCCKw`). The bundle
contains HTML/JSX prototypes; this codebase is the real React + Tauri v2
implementation of the parts that make up the app (reader, panels, library).
