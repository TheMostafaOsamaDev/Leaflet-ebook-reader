// Full-screen review surface for the "Manage before importing" docx flow.
//
// The user has just had a .docx converted to a staging session (HTML +
// extracted image blobs, kept entirely in memory). Here they:
//   1. Pick a cover from the doc's images (left panel)
//   2. Trim the doc by deleting unwanted content blocks (right panel)
//   3. Edit the display title before commit
// Hitting "Add to library" calls back to commit; "Cancel" discards the
// session and frees its blob URLs.
//
// Performance:
//   - Block list + image gallery are virtualized (VirtualList / VirtualGrid).
//     A 5,000-paragraph novel only mounts ~30 rows at a time.
//   - Image thumbnails use blob URLs created at conversion time and
//     <img loading="lazy">, so the browser only decodes images when their
//     row scrolls in.
//   - Selection state lives in a Set<number> (block IDs) and is updated
//     in O(rangeSize) on shift+click. Toggling a single row is O(1).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { VirtualList, VirtualGrid } from "./VirtualList";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  type Theme,
} from "../styles/tokens";
import type {
  StagedBlock,
  StagedDocx,
  StagingEdits,
} from "../docx/stage";

interface Props {
  theme: Theme;
  layout: "desktop" | "mobile";
  staged: StagedDocx;
  /** Resolves once the import has finished saving. The view shows a
   *  busy state while the promise is pending. */
  onCommit: (
    edits: StagingEdits,
    meta: { title: string; author: string },
  ) => Promise<void>;
  onCancel: () => void;
}

const BLOCK_ROW_HEIGHT = 96;
const GALLERY_ROW_HEIGHT = 168;
const GALLERY_GAP = 10;

export function DocxManageView({
  theme,
  layout,
  staged,
  onCommit,
  onCancel,
}: Props) {
  const isMobile = layout === "mobile";

  // ── editable bits ──────────────────────────────────────────────────────
  const [title, setTitle] = useState<string>(staged.fallbackTitle);
  const [author, setAuthor] = useState<string>("Unknown author");

  // ── deletion state ────────────────────────────────────────────────────
  // Stored as a "kept" set so the default invariant ("everything is kept
  // unless explicitly removed") is just `keptIds.size === blocks.length`.
  const [keptIds, setKeptIds] = useState<Set<number>>(
    () => new Set(staged.blocks.map((b) => b.id)),
  );
  const [showDeleted, setShowDeleted] = useState<boolean>(false);

  // ── selection state ───────────────────────────────────────────────────
  // Selection is transient (used for the "Delete selected" action). Anchor
  // is the most recently directly-clicked row, used as the start of a
  // shift+click range.
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  // ── cover state ───────────────────────────────────────────────────────
  // Default to the first image (matches the legacy direct-import path).
  // null = "no cover" — also the default when the doc has no images.
  const [coverImageId, setCoverImageId] = useState<string | null>(
    () => staged.imageOrder[0] ?? null,
  );

  // ── commit state ──────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── derived ───────────────────────────────────────────────────────────
  const visibleBlocks = useMemo(() => {
    if (showDeleted) return staged.blocks;
    return staged.blocks.filter((b) => keptIds.has(b.id));
  }, [staged.blocks, keptIds, showDeleted]);

  const deletedCount = staged.blocks.length - keptIds.size;
  const selectedCount = selection.size;

  // Map block id → its index in visibleBlocks. Lets shift+click compute
  // the range in the *visible* order (so a shift across hidden-deleted
  // blocks behaves intuitively).
  const indexInVisible = useMemo(() => {
    const m = new Map<number, number>();
    visibleBlocks.forEach((b, i) => m.set(b.id, i));
    return m;
  }, [visibleBlocks]);

  // ── handlers ──────────────────────────────────────────────────────────
  const onRowClick = useCallback(
    (blockId: number, e: React.MouseEvent) => {
      if (e.shiftKey && anchor !== null) {
        const a = indexInVisible.get(anchor);
        const b = indexInVisible.get(blockId);
        if (a === undefined || b === undefined) {
          // Anchor isn't visible (probably toggled showDeleted off after
          // selecting a deleted block) — fall back to single-toggle.
          toggleOne(blockId);
          return;
        }
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const next = new Set<number>();
        for (let i = lo; i <= hi; i++) next.add(visibleBlocks[i].id);
        setSelection(next);
      } else if (e.ctrlKey || e.metaKey) {
        toggleOne(blockId);
        setAnchor(blockId);
      } else {
        toggleOne(blockId);
        setAnchor(blockId);
      }
    },
    [anchor, indexInVisible, visibleBlocks],
  );

  const toggleOne = useCallback((blockId: number) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);

  const deleteOne = useCallback((blockId: number) => {
    setKeptIds((prev) => {
      if (!prev.has(blockId)) return prev;
      const next = new Set(prev);
      next.delete(blockId);
      return next;
    });
    setSelection((prev) => {
      if (!prev.has(blockId)) return prev;
      const next = new Set(prev);
      next.delete(blockId);
      return next;
    });
  }, []);

  const restoreOne = useCallback((blockId: number) => {
    setKeptIds((prev) => {
      if (prev.has(blockId)) return prev;
      const next = new Set(prev);
      next.add(blockId);
      return next;
    });
  }, []);

  const deleteSelected = useCallback(() => {
    if (selection.size === 0) return;
    setKeptIds((prev) => {
      const next = new Set(prev);
      for (const id of selection) next.delete(id);
      return next;
    });
    setSelection(new Set());
    setAnchor(null);
  }, [selection]);

  const selectAllVisible = useCallback(() => {
    setSelection(new Set(visibleBlocks.map((b) => b.id)));
  }, [visibleBlocks]);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setAnchor(null);
  }, []);

  const restoreAll = useCallback(() => {
    setKeptIds(new Set(staged.blocks.map((b) => b.id)));
  }, [staged.blocks]);

  const onAdd = useCallback(async () => {
    if (busy) return;
    if (keptIds.size === 0) {
      setError("Nothing to import — restore at least one section.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCommit(
        { keptBlockIds: keptIds, coverImageId },
        { title: title.trim() || staged.fallbackTitle, author: author.trim() || "Unknown author" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [busy, keptIds, coverImageId, title, author, staged.fallbackTitle, onCommit]);

  // Esc cancels (when not busy).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  // ── render ────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="docx-manage-title"
      style={{
        position: "fixed",
        inset: 0,
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        zIndex: 9600,
        fontFamily: FONT_STACKS.sans,
      }}
    >
      <Header
        theme={theme}
        staged={staged}
        title={title}
        onTitleChange={setTitle}
        author={author}
        onAuthorChange={setAuthor}
        keptCount={keptIds.size}
        deletedCount={deletedCount}
        coverImageId={coverImageId}
        busy={busy}
        onCancel={onCancel}
        onAdd={onAdd}
      />

      {error && (
        <div
          style={{
            padding: "10px 24px",
            background: "rgba(180,60,60,0.08)",
            borderBottom: "0.5px solid rgba(180,60,60,0.3)",
            color: theme.ink,
            fontSize: 12.5,
          }}
        >
          <strong style={{ fontWeight: 600 }}>Couldn't add: </strong>
          {error}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
        }}
      >
        <CoverPanel
          theme={theme}
          layout={layout}
          staged={staged}
          coverImageId={coverImageId}
          onPickCover={setCoverImageId}
        />

        <BlockListPanel
          theme={theme}
          staged={staged}
          visibleBlocks={visibleBlocks}
          keptIds={keptIds}
          selection={selection}
          showDeleted={showDeleted}
          deletedCount={deletedCount}
          selectedCount={selectedCount}
          onToggleShowDeleted={() => setShowDeleted((v) => !v)}
          onRowClick={onRowClick}
          onDeleteOne={deleteOne}
          onRestoreOne={restoreOne}
          onDeleteSelected={deleteSelected}
          onSelectAllVisible={selectAllVisible}
          onClearSelection={clearSelection}
          onRestoreAll={restoreAll}
        />
      </div>
    </div>
  );
}

// ── header ────────────────────────────────────────────────────────────────

interface HeaderProps {
  theme: Theme;
  staged: StagedDocx;
  title: string;
  onTitleChange: (s: string) => void;
  author: string;
  onAuthorChange: (s: string) => void;
  keptCount: number;
  deletedCount: number;
  coverImageId: string | null;
  busy: boolean;
  onCancel: () => void;
  onAdd: () => void;
}

function Header({
  theme,
  staged,
  title,
  onTitleChange,
  author,
  onAuthorChange,
  keptCount,
  deletedCount,
  coverImageId,
  busy,
  onCancel,
  onAdd,
}: HeaderProps) {
  return (
    <div
      style={{
        padding: "16px 24px",
        borderBottom: `0.5px solid ${theme.rule}`,
        display: "flex",
        gap: 16,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 220 }}>
        <div
          id="docx-manage-title"
          style={{
            fontFamily: FONT_SERIF_DISPLAY,
            fontStyle: "italic",
            fontSize: 22,
            color: theme.ink,
            letterSpacing: "-0.01em",
            marginBottom: 4,
          }}
        >
          Manage import
        </div>
        <div style={{ fontSize: 12, color: theme.muted }}>
          {staged.sourceFilename} · {staged.language || "und"} ·{" "}
          {staged.dir === "rtl" ? "RTL" : "LTR"} · {keptCount} of{" "}
          {staged.blocks.length} sections kept
          {deletedCount > 0 ? ` · ${deletedCount} removed` : ""} ·{" "}
          {staged.imageOrder.length}{" "}
          {staged.imageOrder.length === 1 ? "image" : "images"}
          {coverImageId === null ? " · no cover" : " · cover selected"}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flex: "1 1 280px",
          minWidth: 220,
        }}
      >
        <LabeledInput
          theme={theme}
          label="Title"
          value={title}
          onChange={onTitleChange}
          flex={2}
        />
        <LabeledInput
          theme={theme}
          label="Author"
          value={author}
          onChange={onAuthorChange}
          flex={1}
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          theme={theme}
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          theme={theme}
          variant="primary"
          size="sm"
          onClick={onAdd}
          disabled={busy || keptCount === 0}
          leadingIcon={<Icon name="check" size={13} />}
        >
          {busy ? "Adding…" : "Add to library"}
        </Button>
      </div>
    </div>
  );
}

function LabeledInput({
  theme,
  label,
  value,
  onChange,
  flex,
}: {
  theme: Theme;
  label: string;
  value: string;
  onChange: (s: string) => void;
  flex?: number;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", flex }}>
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          color: theme.muted,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          marginBottom: 3,
        }}
      >
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: "inherit",
          fontSize: 13,
          padding: "6px 10px",
          background: theme.chrome,
          color: theme.ink,
          border: `0.5px solid ${theme.rule}`,
          borderRadius: 6,
          outline: "none",
        }}
      />
    </label>
  );
}

// ── cover panel ───────────────────────────────────────────────────────────

interface CoverPanelProps {
  theme: Theme;
  layout: "desktop" | "mobile";
  staged: StagedDocx;
  coverImageId: string | null;
  onPickCover: (id: string | null) => void;
}

function CoverPanel({
  theme,
  layout,
  staged,
  coverImageId,
  onPickCover,
}: CoverPanelProps) {
  const isMobile = layout === "mobile";
  const hasImages = staged.imageOrder.length > 0;

  // Two-column grid on desktop, three on mobile (the panel is wider on
  // mobile because it stacks above instead of beside).
  const columns = isMobile ? 3 : 2;

  return (
    <aside
      aria-label="Cover gallery"
      style={{
        // Desktop: pinned left rail. Mobile: top strip ~280px tall so the
        // user can still see the block list below without scrolling.
        width: isMobile ? "100%" : 320,
        height: isMobile ? 280 : "auto",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: isMobile ? "none" : `0.5px solid ${theme.rule}`,
        borderBottom: isMobile ? `0.5px solid ${theme.rule}` : "none",
        background: theme.chrome,
      }}
    >
      <div
        style={{
          padding: "14px 18px 8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              color: theme.muted,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Cover
          </div>
          <div
            style={{
              fontFamily: FONT_SERIF_DISPLAY,
              fontStyle: "italic",
              fontSize: 16,
              color: theme.ink,
              marginTop: 2,
            }}
          >
            {hasImages
              ? coverImageId
                ? "1 image selected"
                : "Pick an image"
              : "No images"}
          </div>
        </div>
        {hasImages && (
          <button
            onClick={() => onPickCover(null)}
            disabled={coverImageId === null}
            title="Use no cover (auto-generated placeholder)"
            style={{
              border: `0.5px solid ${theme.rule}`,
              background: "transparent",
              color: theme.ink,
              fontSize: 11,
              padding: "4px 9px",
              borderRadius: 999,
              cursor: coverImageId === null ? "default" : "pointer",
              opacity: coverImageId === null ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            No cover
          </button>
        )}
      </div>

      {!hasImages ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
          }}
        >
          <div
            style={{
              maxWidth: 240,
              color: theme.muted,
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            <Icon name="doc" size={28} style={{ opacity: 0.45 }} />
            <div style={{ marginTop: 8 }}>
              The gallery of the doc is empty.
            </div>
            <div style={{ marginTop: 4, fontSize: 11.5 }}>
              An auto-generated cover will be used.
            </div>
          </div>
        </div>
      ) : (
        <VirtualGrid
          ariaLabel="Cover candidates"
          items={staged.imageOrder}
          columns={columns}
          rowHeight={GALLERY_ROW_HEIGHT}
          columnGap={GALLERY_GAP}
          renderItem={(imageId, idx) => (
            <CoverThumb
              theme={theme}
              imageId={imageId}
              index={idx}
              src={staged.imagesById.get(imageId)?.blobUrl ?? ""}
              selected={coverImageId === imageId}
              onClick={() => onPickCover(imageId)}
            />
          )}
          itemKey={(imageId) => imageId}
          style={{
            flex: 1,
            padding: `0 ${GALLERY_GAP}px ${GALLERY_GAP}px`,
          }}
        />
      )}
    </aside>
  );
}

function CoverThumb({
  theme,
  imageId,
  index,
  src,
  selected,
  onClick,
}: {
  theme: Theme;
  imageId: string;
  index: number;
  src: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      title={imageId}
      style={{
        width: "100%",
        height: GALLERY_ROW_HEIGHT - GALLERY_GAP,
        padding: 0,
        cursor: "pointer",
        border: selected
          ? `2px solid ${theme.ink}`
          : `0.5px solid ${theme.rule}`,
        background: theme.bg,
        borderRadius: 8,
        overflow: "hidden",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <span
        style={{
          flex: 1,
          minHeight: 0,
          background: theme.chrome,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          // contain so we don't crop arbitrary art; flex centering above
          // gives proper letterboxing on landscape/portrait images.
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
          }}
        />
      </span>
      <span
        style={{
          padding: "4px 6px",
          fontSize: 10,
          color: theme.muted,
          background: theme.bg,
          fontVariantNumeric: "tabular-nums",
          textAlign: "center",
        }}
      >
        {selected ? "Selected" : `Image ${index + 1}`}
      </span>
    </button>
  );
}

// ── block list panel ──────────────────────────────────────────────────────

interface BlockListPanelProps {
  theme: Theme;
  staged: StagedDocx;
  visibleBlocks: StagedBlock[];
  keptIds: Set<number>;
  selection: Set<number>;
  showDeleted: boolean;
  deletedCount: number;
  selectedCount: number;
  onToggleShowDeleted: () => void;
  onRowClick: (id: number, e: React.MouseEvent) => void;
  onDeleteOne: (id: number) => void;
  onRestoreOne: (id: number) => void;
  onDeleteSelected: () => void;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onRestoreAll: () => void;
}

function BlockListPanel({
  theme,
  staged,
  visibleBlocks,
  keptIds,
  selection,
  showDeleted,
  deletedCount,
  selectedCount,
  onToggleShowDeleted,
  onRowClick,
  onDeleteOne,
  onRestoreOne,
  onDeleteSelected,
  onSelectAllVisible,
  onClearSelection,
  onRestoreAll,
}: BlockListPanelProps) {
  return (
    <section
      aria-label="Document content"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: theme.bg,
      }}
    >
      <div
        style={{
          padding: "10px 18px",
          borderBottom: `0.5px solid ${theme.rule}`,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, color: theme.muted, marginRight: 4 }}>
          {visibleBlocks.length}{" "}
          {visibleBlocks.length === 1 ? "section" : "sections"}
          {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
        </div>
        <div style={{ flex: 1 }} />
        {selectedCount > 0 ? (
          <>
            <PillButton theme={theme} onClick={onClearSelection}>
              Clear
            </PillButton>
            <PillButton
              theme={theme}
              tone="destructive"
              onClick={onDeleteSelected}
              leadingIcon={<Icon name="close" size={11} />}
            >
              Delete {selectedCount}
            </PillButton>
          </>
        ) : (
          <PillButton
            theme={theme}
            onClick={onSelectAllVisible}
            disabled={visibleBlocks.length === 0}
          >
            Select all
          </PillButton>
        )}
        {deletedCount > 0 && (
          <>
            <PillButton theme={theme} onClick={onToggleShowDeleted}>
              {showDeleted ? "Hide deleted" : `Show deleted (${deletedCount})`}
            </PillButton>
            <PillButton theme={theme} onClick={onRestoreAll}>
              Restore all
            </PillButton>
          </>
        )}
      </div>

      {visibleBlocks.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.muted,
            fontSize: 13,
            padding: 32,
            textAlign: "center",
          }}
        >
          {staged.blocks.length === 0
            ? "This document has no readable content."
            : "Every section has been removed. Restore at least one to import."}
        </div>
      ) : (
        <VirtualList
          ariaLabel="Document sections"
          items={visibleBlocks}
          itemHeight={BLOCK_ROW_HEIGHT}
          renderItem={(block) => (
            <BlockRow
              theme={theme}
              block={block}
              kept={keptIds.has(block.id)}
              selected={selection.has(block.id)}
              imagesById={staged.imagesById}
              onClick={(e) => onRowClick(block.id, e)}
              onDelete={() => onDeleteOne(block.id)}
              onRestore={() => onRestoreOne(block.id)}
            />
          )}
          itemKey={(block) => block.id}
          style={{ flex: 1, padding: "8px 12px 16px" }}
        />
      )}
    </section>
  );
}

interface PillButtonProps {
  theme: Theme;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "destructive";
  leadingIcon?: React.ReactNode;
  children: React.ReactNode;
}

function PillButton({
  theme,
  onClick,
  disabled,
  tone = "default",
  leadingIcon,
  children,
}: PillButtonProps) {
  const isDestructive = tone === "destructive";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: isDestructive
          ? "0.5px solid #c04a3a"
          : `0.5px solid ${theme.rule}`,
        background: isDestructive ? "rgba(192,74,58,0.08)" : "transparent",
        color: isDestructive ? "#c04a3a" : theme.ink,
        fontSize: 11.5,
        padding: "5px 10px",
        borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        opacity: disabled ? 0.5 : 1,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      {leadingIcon}
      {children}
    </button>
  );
}

// ── block row card ────────────────────────────────────────────────────────

interface BlockRowProps {
  theme: Theme;
  block: StagedBlock;
  kept: boolean;
  selected: boolean;
  imagesById: Map<string, { blobUrl: string }>;
  onClick: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onRestore: () => void;
}

function BlockRow({
  theme,
  block,
  kept,
  selected,
  imagesById,
  onClick,
  onDelete,
  onRestore,
}: BlockRowProps) {
  const firstImage =
    block.imageIds.length > 0
      ? imagesById.get(block.imageIds[0])?.blobUrl ?? null
      : null;
  const extraImages = block.imageIds.length > 1 ? block.imageIds.length - 1 : 0;

  const baseColor = kept ? theme.ink : theme.muted;
  const previewText =
    block.textPreview.length > 200
      ? block.textPreview.slice(0, 199) + "…"
      : block.textPreview;

  return (
    <div
      onClick={onClick}
      role="button"
      aria-pressed={selected}
      style={{
        height: BLOCK_ROW_HEIGHT - 8,
        margin: "4px 0",
        padding: "10px 12px",
        background: selected
          ? withAlpha(theme.ink, 0.06)
          : kept
            ? theme.bg
            : theme.chrome,
        border: selected
          ? `0.5px solid ${theme.ink}`
          : `0.5px solid ${theme.rule}`,
        borderRadius: 8,
        display: "flex",
        gap: 12,
        alignItems: "stretch",
        cursor: "pointer",
        // user-select:none keeps shift+click from also extending a text
        // selection across rows — we want it to extend the *row* selection.
        userSelect: "none",
        opacity: kept ? 1 : 0.6,
      }}
    >
      <SelectionDot theme={theme} selected={selected} kept={kept} />
      <TypeBadge theme={theme} block={block} />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 2,
          color: baseColor,
        }}
      >
        <div
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            color: theme.muted,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span>Page {block.id + 1}</span>
          {!kept && <span style={{ color: "#c04a3a" }}>· removed</span>}
        </div>
        <div
          style={{
            // 2-line clamp keeps the row at a fixed height — virtualization
            // depends on every row being exactly BLOCK_ROW_HEIGHT.
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            fontSize:
              block.type === "h1"
                ? 15
                : block.type === "h2" || block.type === "h3"
                  ? 14
                  : 13,
            fontWeight:
              block.type === "h1" || block.type === "h2" ? 600 : 400,
            lineHeight: 1.35,
            textDecoration: kept ? "none" : "line-through",
            textDecorationColor: kept ? undefined : "#c04a3a",
            color: baseColor,
          }}
          title={block.textPreview}
        >
          {previewText.length > 0
            ? previewText
            : block.type === "img"
              ? "(image)"
              : block.type === "table"
                ? "(table)"
                : "(empty)"}
        </div>
      </div>

      {firstImage && (
        <div
          style={{
            position: "relative",
            width: 64,
            height: 64,
            alignSelf: "center",
            background: theme.chrome,
            border: `0.5px solid ${theme.rule}`,
            borderRadius: 6,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <img
            src={firstImage}
            alt=""
            loading="lazy"
            decoding="async"
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
            }}
          />
          {extraImages > 0 && (
            <span
              style={{
                position: "absolute",
                bottom: 2,
                right: 2,
                fontSize: 9,
                fontWeight: 600,
                background: "rgba(0,0,0,0.65)",
                color: "#fff",
                padding: "1px 4px",
                borderRadius: 999,
              }}
            >
              +{extraImages}
            </span>
          )}
        </div>
      )}

      <div
        style={{
          alignSelf: "center",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {kept ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Delete this section"
            title="Delete this section"
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              border: "0.5px solid #c04a3a",
              background: "transparent",
              color: "#c04a3a",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="close" size={12} />
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            aria-label="Restore this section"
            title="Restore this section"
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              border: `0.5px solid ${theme.rule}`,
              background: "transparent",
              color: theme.ink,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="check" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function SelectionDot({
  theme,
  selected,
  kept,
}: {
  theme: Theme;
  selected: boolean;
  kept: boolean;
}) {
  const dim = !kept;
  return (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        alignSelf: "center",
        borderRadius: 4,
        border: `1px solid ${selected ? theme.ink : theme.rule}`,
        background: selected ? theme.ink : "transparent",
        color: theme.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: dim ? 0.5 : 1,
      }}
    >
      {selected && (
        <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2 5l2 2 4-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

function TypeBadge({ theme, block }: { theme: Theme; block: StagedBlock }) {
  const label = labelFor(block);
  return (
    <span
      style={{
        alignSelf: "center",
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: theme.muted,
        background: theme.chrome,
        border: `0.5px solid ${theme.rule}`,
        flexShrink: 0,
        minWidth: 36,
        textAlign: "center",
      }}
    >
      {label}
    </span>
  );
}

function labelFor(block: StagedBlock): string {
  switch (block.type) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return block.type.toUpperCase();
    case "img":
      return "IMG";
    case "list":
      return "LIST";
    case "blockquote":
      return "QUOTE";
    case "table":
      return "TABLE";
    case "p":
      return "P";
    default:
      return block.tag;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Mix a hex/css color with an alpha. Used to overlay a faint tint on
 * selected rows without picking a per-theme hard-coded value.
 */
function withAlpha(color: string, alpha: number): string {
  // Quick hex parse — works for #RGB and #RRGGBB. Falls back to rgba()
  // wrapping for anything else, which works fine for "rgb(...)" too.
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return color;
}

