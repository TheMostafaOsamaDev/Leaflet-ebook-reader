import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { BookCover, BOOK_COVER_DIMS } from "./BookCover";
import { Toast, type ToastMessage } from "./Toast";
import { EditBookModal } from "./EditBookModal";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./Button";
import { ImportChoiceModal } from "./ImportChoiceModal";
import { DocxManageView } from "./DocxManageView";
import {
  clearLibrary,
  commitStagedDocx,
  coverSrcFor,
  listBooks,
  pickAndImportDocx,
  pickAndImportEpub,
  pickAndImportFolder,
  pickAndStageDocx,
  deleteBook,
  rescanCover,
  setCoverFromFile,
  updateBookMeta,
  updateBookStatus,
  type BookIndexEntry,
  type BookStatus,
} from "../store/library";
import { disposeStaging, type StagedDocx } from "../docx/stage";
import { paletteForId } from "../store/palette";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  isArabicTitle,
  titleFontFor,
  type Theme,
} from "../styles/tokens";

interface Props {
  theme: Theme;
  layout: "desktop" | "mobile";
  onOpen: (bookId: string) => void;
}

function useBooks() {
  const [books, setBooks] = useState<BookIndexEntry[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listBooks();
      setBooks(list);
      // Resolve cover URLs in parallel — these are cheap (convertFileSrc is
      // synchronous after the one-time appDataDir lookup) but awaiting them
      // up front means no per-card flicker.
      const entries = await Promise.all(
        list
          .filter((b) => b.coverFile)
          .map(async (b) => [b.id, await coverSrcFor(b)] as const),
      );
      const next: Record<string, string> = {};
      for (const [id, url] of entries) if (url) next[id] = url;
      setCovers(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { books, covers, loading, error, refresh, setError };
}

export function Library({ theme, layout, onOpen }: Props) {
  const { books, covers, loading, error, refresh, setError } = useBooks();
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastIdRef = useRef(0);

  const showToast = useCallback((kind: ToastMessage["kind"], text: string) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, kind, text });
  }, []);

  const onImport = async () => {
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      const entry = await pickAndImportEpub();
      if (entry) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const onClearAll = async () => {
    if (importing) return;
    const n = books.length;
    if (n === 0) {
      showToast("info", "Library is already empty.");
      return;
    }
    if (!confirm(`[dev] Delete all ${n} book${n === 1 ? "" : "s"}? This cannot be undone.`))
      return;
    setImporting(true);
    setError(null);
    try {
      await clearLibrary();
      await refresh();
      showToast("info", `Cleared ${n} book${n === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  // Two-step .docx import flow:
  //   click "Import .docx" → ImportChoiceModal opens
  //     → "Add directly"      → onImportDocxDirect (legacy path)
  //     → "Manage before…"    → onImportDocxStage (opens DocxManageView)
  // `stagedDocx` is the in-memory session for the manage view; while it's
  // non-null the manage overlay renders.
  const [docxChoiceOpen, setDocxChoiceOpen] = useState(false);
  const [stagedDocx, setStagedDocx] = useState<StagedDocx | null>(null);

  const onImportDocx = () => {
    if (importing) return;
    setError(null);
    setDocxChoiceOpen(true);
  };

  const onImportDocxDirect = async () => {
    setDocxChoiceOpen(false);
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      const entry = await pickAndImportDocx();
      if (entry) {
        await refresh();
        // Toast on success so the user has a persistent confirmation that
        // outlives the import-progress modal's auto-dismiss. Without this,
        // a fast import looked like nothing happened.
        showToast(
          "info",
          `Imported “${entry.title}” — ${entry.chapterCount} chapter${entry.chapterCount === 1 ? "" : "s"}.`,
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Surface failures both inline (red banner) and as a toast — the
      // import-progress modal also shows the error, but it's easy to miss
      // if it's been minimized to the dock.
      console.error("docx import failed:", e);
      setError(message);
      showToast("error", `Import failed: ${message}`);
    } finally {
      setImporting(false);
    }
  };

  const onImportDocxStage = async () => {
    setDocxChoiceOpen(false);
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      const staged = await pickAndStageDocx();
      if (staged) setStagedDocx(staged);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("docx staging failed:", e);
      setError(message);
      showToast("error", `Couldn't read document: ${message}`);
    } finally {
      setImporting(false);
    }
  };

  const onStagingCancel = useCallback(() => {
    if (stagedDocx) disposeStaging(stagedDocx);
    setStagedDocx(null);
  }, [stagedDocx]);

  const onStagingCommit = useCallback(
    async (
      edits: Parameters<typeof commitStagedDocx>[1],
      meta: Parameters<typeof commitStagedDocx>[2],
    ) => {
      if (!stagedDocx) return;
      try {
        const entry = await commitStagedDocx(stagedDocx, edits, meta);
        // Free blob URLs and close the manage overlay before refreshing
        // the library so the staged-doc memory drops out of the heap
        // before the (potentially large) library list re-renders.
        disposeStaging(stagedDocx);
        setStagedDocx(null);
        await refresh();
        showToast(
          "info",
          `Imported “${entry.title}” — ${entry.chapterCount} chapter${entry.chapterCount === 1 ? "" : "s"}.`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("docx commit failed:", e);
        showToast("error", `Couldn't add to library: ${message}`);
        // Re-throw so the manage view can render its inline error and
        // re-enable the Add button.
        throw e;
      }
    },
    [refresh, showToast, stagedDocx],
  );

  // Last-ditch cleanup if the component unmounts while a staging session
  // is still alive (rare — usually only on hot-reload during development).
  useEffect(() => {
    return () => {
      if (stagedDocx) disposeStaging(stagedDocx);
    };
  }, [stagedDocx]);

  const onImportFolder = async () => {
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await pickAndImportFolder();
      if (!result) return;
      if (result.empty) {
        showToast(
          "warn",
          "That folder has no EPUB files at its top level — can't import an empty folder.",
        );
        return;
      }
      await refresh();
      const n = result.imported.length;
      const skipped = result.errors.length;
      if (skipped > 0) {
        showToast(
          "warn",
          `Imported ${n} book${n === 1 ? "" : "s"}, skipped ${skipped} that couldn't be parsed.`,
        );
      } else {
        showToast(
          "info",
          `Imported ${n} book${n === 1 ? "" : "s"}.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const onDelete = async (id: string) => {
    await deleteBook(id);
    await refresh();
  };

  const onRescanCover = async (id: string) => {
    try {
      const updated = await rescanCover(id);
      if (!updated) {
        setError(
          "Couldn't find a cover in the original EPUB. Try \u201CSet cover\u2026\u201D to pick an image yourself.",
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSetCover = async (id: string) => {
    try {
      await setCoverFromFile(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingBook =
    editingId !== null ? books.find((b) => b.id === editingId) : undefined;
  const onEditSave = async (
    id: string,
    patch: { title: string; author: string; description: string },
  ) => {
    try {
      await updateBookMeta(id, patch);
      await refresh();
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Right-click menu on shelf cards. The menu lives at the Library top
  // level so its actions can reach the modal + delete handlers without
  // threading more props through the layout components.
  const [menu, setMenu] = useState<{
    bookId: string;
    x: number;
    y: number;
  } | null>(null);
  const menuBook =
    menu !== null ? books.find((b) => b.id === menu.bookId) : undefined;
  const openContextMenu = (bookId: string, x: number, y: number) =>
    setMenu({ bookId, x, y });
  const closeContextMenu = () => setMenu(null);
  const onPickStatus = async (bookId: string, s: BookStatus) => {
    try {
      // Re-clicking the currently-set status clears it — acts as a toggle so
      // the user doesn't have to reach for a separate "Clear status" item.
      const current = books.find((b) => b.id === bookId)?.status;
      await updateBookStatus(bookId, current === s ? undefined : s);
      await refresh();
      closeContextMenu();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Single source of truth for the remove-confirmation popup. Every entry
  // point (hero card, context menu, edit modal) routes through here so we
  // don't end up with three inline confirms drifting apart.
  const [pendingDelete, setPendingDelete] = useState<{
    bookId: string;
    title: string;
    closeEditAfter?: boolean;
  } | null>(null);
  const requestDelete = (
    bookId: string,
    title: string,
    opts?: { closeEditAfter?: boolean },
  ) => setPendingDelete({ bookId, title, ...opts });
  const cancelDelete = () => setPendingDelete(null);
  const performDelete = async () => {
    if (!pendingDelete) return;
    const { bookId, closeEditAfter } = pendingDelete;
    setPendingDelete(null);
    if (closeEditAfter) setEditingId(null);
    await onDelete(bookId);
  };
  const onMenuDelete = (bookId: string, title: string) => {
    closeContextMenu();
    requestDelete(bookId, title);
  };

  const layoutEl =
    layout === "mobile" ? (
      <MobileLibrary
        theme={theme}
        books={books}
        covers={covers}
        loading={loading}
        error={error}
        importing={importing}
        onOpen={onOpen}
        onImport={onImport}
        onImportDocx={onImportDocx}
        onImportFolder={onImportFolder}
        onClearAll={onClearAll}
        onDelete={(id) => {
          const b = books.find((x) => x.id === id);
          if (b) requestDelete(b.id, b.title);
        }}
        onEdit={(id) => setEditingId(id)}
        onCardContextMenu={openContextMenu}
      />
    ) : (
      <DesktopLibrary
        theme={theme}
        books={books}
        covers={covers}
        loading={loading}
        error={error}
        importing={importing}
        onOpen={onOpen}
        onImport={onImport}
        onImportDocx={onImportDocx}
        onImportFolder={onImportFolder}
        onClearAll={onClearAll}
        onDelete={(id) => {
          const b = books.find((x) => x.id === id);
          if (b) requestDelete(b.id, b.title);
        }}
        onEdit={(id) => setEditingId(id)}
        onCardContextMenu={openContextMenu}
      />
    );

  return (
    <>
      {layoutEl}
      <Toast theme={theme} toast={toast} onDismiss={() => setToast(null)} />
      {editingBook && (
        <EditBookModal
          theme={theme}
          book={editingBook}
          coverSrc={covers[editingBook.id]}
          onClose={() => setEditingId(null)}
          onSave={(patch) => onEditSave(editingBook.id, patch)}
          onDelete={() =>
            requestDelete(editingBook.id, editingBook.title, {
              closeEditAfter: true,
            })
          }
          onSetCover={() => onSetCover(editingBook.id)}
          onRescanCover={() => onRescanCover(editingBook.id)}
        />
      )}
      {menu && menuBook && (
        <ContextMenu
          theme={theme}
          x={menu.x}
          y={menu.y}
          status={menuBook.status}
          onPickStatus={(s) => onPickStatus(menuBook.id, s)}
          onEdit={() => {
            closeContextMenu();
            setEditingId(menuBook.id);
          }}
          onDelete={() => onMenuDelete(menuBook.id, menuBook.title)}
          onClose={closeContextMenu}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          theme={theme}
          title="Remove from library?"
          message={
            <>
              <strong style={{ color: theme.ink }}>
                “{pendingDelete.title}”
              </strong>{" "}
              will be removed from your library, including its reading
              progress. This can't be undone.
            </>
          }
          confirmLabel="Remove"
          cancelLabel="Cancel"
          confirmVariant="destructive"
          onConfirm={performDelete}
          onCancel={cancelDelete}
        />
      )}
      {docxChoiceOpen && (
        <ImportChoiceModal
          theme={theme}
          onDirect={onImportDocxDirect}
          onManage={onImportDocxStage}
          onCancel={() => setDocxChoiceOpen(false)}
        />
      )}
      {stagedDocx && (
        <DocxManageView
          theme={theme}
          layout={layout}
          staged={stagedDocx}
          onCommit={onStagingCommit}
          onCancel={onStagingCancel}
        />
      )}
    </>
  );
}

interface LayoutProps {
  theme: Theme;
  books: BookIndexEntry[];
  covers: Record<string, string>;
  loading: boolean;
  error: string | null;
  importing: boolean;
  onOpen: (id: string) => void;
  onImport: () => void;
  onImportDocx: () => void;
  onImportFolder: () => void;
  onClearAll: () => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onCardContextMenu: (id: string, x: number, y: number) => void;
}

type LibraryTab = "all" | BookStatus;

const TABS: { key: LibraryTab; label: string }[] = [
  { key: "all", label: "Library" },
  { key: "reading", label: "Reading" },
  { key: "finished", label: "Finished" },
  { key: "wishlist", label: "Wishlist" },
];

// "Reading" is partly derived: a book the user has actually started but not
// finished counts as in-progress even if they never explicitly tagged it.
// Explicit finished/wishlist still wins — those are user intent and override
// whatever the progress number says.
function isReading(b: BookIndexEntry): boolean {
  if (b.status === "reading") return true;
  if (b.status === "finished" || b.status === "wishlist") return false;
  return b.progress > 0 && b.progress < 1;
}

function matchesTab(b: BookIndexEntry, tab: LibraryTab): boolean {
  if (tab === "all") return true;
  if (tab === "reading") return isReading(b);
  return b.status === tab;
}

function DesktopLibrary({
  theme,
  books,
  covers,
  loading,
  error,
  importing,
  onOpen,
  onImport,
  onImportDocx,
  onImportFolder,
  onClearAll,
  onDelete,
  onEdit,
  onCardContextMenu,
}: LayoutProps) {
  const [tab, setTab] = useState<LibraryTab>("all");
  const visible = books.filter((b) => matchesTab(b, tab));
  // Hero is the "continue reading" affordance — only meaningful on the full
  // library view. On a filtered tab we render a flat shelf so every match is
  // equally weighted.
  const hero =
    tab === "all"
      ? visible.find((b) => b.lastReadAt !== undefined)
      : undefined;
  const others = hero ? visible.filter((b) => b.id !== hero.id) : visible;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        fontFamily: FONT_STACKS.sans,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "20px 40px",
          borderBottom: `0.5px solid ${theme.rule}`,
        }}
      >
        <div
          style={{
            fontFamily: FONT_SERIF_DISPLAY,
            fontSize: 20,
            fontStyle: "italic",
            fontWeight: 500,
            letterSpacing: "-0.01em",
          }}
        >
          Leaflet
        </div>
        <div style={{ display: "flex", gap: 4, marginLeft: 12 }}>
          {TABS.map(({ key, label }) => {
            const active = key === tab;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  border: "none",
                  background: active ? theme.hover : "transparent",
                  color: active ? theme.ink : theme.muted,
                  padding: "6px 12px",
                  borderRadius: 7,
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        {import.meta.env.DEV && (
          <Button
            theme={theme}
            variant="destructive"
            size="sm"
            onClick={onClearAll}
            disabled={importing}
            title="Dev only — wipes every book from the library"
            leadingIcon={<Icon name="close" size={13} />}
            style={{ marginRight: 8 }}
          >
            Clear all
          </Button>
        )}
        <Button
          theme={theme}
          variant="outline"
          size="sm"
          onClick={onImportFolder}
          disabled={importing}
          leadingIcon={<Icon name="folder" size={13} />}
          style={{ marginRight: 8 }}
        >
          Import folder
        </Button>
        <Button
          theme={theme}
          variant="outline"
          size="sm"
          onClick={onImportDocx}
          disabled={importing}
          leadingIcon={<Icon name="doc" size={13} />}
          title="Convert a Word document to EPUB on import"
          style={{ marginRight: 8 }}
        >
          Import .docx
        </Button>
        <Button
          theme={theme}
          variant="primary"
          size="sm"
          onClick={onImport}
          disabled={importing}
          leadingIcon={<Icon name="plus" size={13} />}
        >
          {importing ? "Importing…" : "Import EPUB"}
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "32px 40px 40px" }}>
        {error && <ErrorBanner theme={theme} message={error} />}

        {loading && books.length === 0 ? (
          <div style={{ color: theme.muted, padding: 40, textAlign: "center" }}>
            Loading your library…
          </div>
        ) : books.length === 0 ? (
          <EmptyState theme={theme} onImport={onImport} importing={importing} />
        ) : visible.length === 0 ? (
          <FilteredEmptyState theme={theme} tab={tab} />
        ) : (
          <>
            {hero && (
              <HeroContinueCard
                theme={theme}
                book={hero}
                coverSrc={covers[hero.id]}
                onOpen={() => onOpen(hero.id)}
                onDelete={() => onDelete(hero.id)}
                onEdit={() => onEdit(hero.id)}
              />
            )}

            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <div>
                <h2
                  style={{
                    fontFamily: FONT_SERIF_DISPLAY,
                    fontStyle: "italic",
                    fontWeight: 400,
                    fontSize: 24,
                    margin: 0,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {tab === "all" ? "Your shelf" : shelfHeadingFor(tab)}
                </h2>
                <div
                  style={{ fontSize: 12, color: theme.muted, marginTop: 2 }}
                >
                  {others.length} {others.length === 1 ? "book" : "books"} · sorted by recent
                </div>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: 32,
                rowGap: 40,
              }}
            >
              {others.map((b) => (
                <LibraryCard
                  key={b.id}
                  theme={theme}
                  book={b}
                  coverSrc={covers[b.id]}
                  onOpen={() => onOpen(b.id)}
                  onContextMenu={(x: number, y: number) =>
                    onCardContextMenu(b.id, x, y)
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MobileLibrary({
  theme,
  books,
  covers,
  loading,
  error,
  importing,
  onOpen,
  onImport,
  onImportDocx,
  onImportFolder,
  onClearAll,
}: LayoutProps) {
  // `onEdit` and `onDelete` are accepted in LayoutProps but mobile cards
  // don't expose per-book actions yet — long-press menu is a TODO. The
  // desktop layout is the only consumer today.
  // Hero is the actually-last-read book, not the one most-recently-added.
  // `listBooks()` already sorts read books above unread by lastReadAt, so
  // the first entry with lastReadAt defined is the right pick. If no book
  // has been opened yet, there's no hero — everything lands on the shelf.
  const hero = books.find((b) => b.lastReadAt !== undefined);
  const others = hero ? books.filter((b) => b.id !== hero.id) : books;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: FONT_STACKS.sans,
        // Android status bar / iOS notch: enableEdgeToEdge() lays the
        // WebView under the system bars, so without these insets the
        // Library title collides with the clock and signal icons.
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      <div
        style={{
          padding: "16px 22px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h1
          style={{
            fontFamily: FONT_SERIF_DISPLAY,
            fontStyle: "italic",
            fontWeight: 400,
            fontSize: 28,
            margin: 0,
            letterSpacing: "-0.02em",
            color: theme.ink,
          }}
        >
          Library
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          {import.meta.env.DEV && (
            <button
              onClick={onClearAll}
              disabled={importing}
              aria-label="Clear library (dev)"
              title="Dev only — wipes every book"
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                border: "0.5px solid #c04a3a",
                background: "transparent",
                color: "#c04a3a",
                cursor: importing ? "progress" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: importing ? 0.6 : 1,
              }}
            >
              <Icon name="close" size={16} />
            </button>
          )}
          <button
            onClick={onImportFolder}
            disabled={importing}
            aria-label="Import folder of EPUBs"
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              border: `0.5px solid ${theme.rule}`,
              background: "transparent",
              color: theme.ink,
              cursor: importing ? "progress" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: importing ? 0.6 : 1,
            }}
          >
            <Icon name="folder" size={16} />
          </button>
          <button
            onClick={onImportDocx}
            disabled={importing}
            aria-label="Import Word document"
            title="Convert a Word document to EPUB on import"
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              border: `0.5px solid ${theme.rule}`,
              background: "transparent",
              color: theme.ink,
              cursor: importing ? "progress" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: importing ? 0.6 : 1,
            }}
          >
            <Icon name="doc" size={16} />
          </button>
          <button
            onClick={onImport}
            disabled={importing}
            aria-label="Import EPUB"
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              border: "none",
              background: theme.ink,
              color: theme.bg,
              cursor: importing ? "progress" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: importing ? 0.6 : 1,
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 22px 40px" }}>
        {error && <ErrorBanner theme={theme} message={error} />}

        {loading && books.length === 0 ? (
          <div style={{ color: theme.muted, padding: 30, textAlign: "center" }}>
            Loading…
          </div>
        ) : books.length === 0 ? (
          <EmptyState theme={theme} onImport={onImport} importing={importing} />
        ) : (
          <>
            {hero && (
              <div
                onClick={() => onOpen(hero.id)}
                role="button"
                tabIndex={0}
                style={{
                  padding: 16,
                  borderRadius: 14,
                  background: theme.chrome,
                  display: "flex",
                  gap: 14,
                  marginBottom: 28,
                  alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <BookCover
                  title={hero.title}
                  author={hero.author}
                  palette={paletteForId(hero.id)}
                  size="sm"
                  src={covers[hero.id]}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: theme.muted,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      marginBottom: 4,
                    }}
                  >
                    {hero.lastReadAt ? "Continue" : "Start reading"}
                  </div>
                  <div
                    style={{
                      fontFamily: titleFontFor(hero.title),
                      fontStyle: isArabicTitle(hero.title) ? "normal" : "italic",
                      fontSize: 18,
                      lineHeight: isArabicTitle(hero.title) ? 1.4 : 1.15,
                      color: theme.ink,
                      letterSpacing: "-0.01em",
                      marginBottom: 4,
                    }}
                  >
                    {hero.title}
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: theme.muted,
                      marginBottom: 10,
                    }}
                  >
                    {hero.chapterCount} chapters · {relTime(hero.lastReadAt ?? hero.addedAt)}
                  </div>
                  <div
                    style={{
                      height: 3,
                      background: theme.rule,
                      borderRadius: 2,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.round(hero.progress * 100)}%`,
                        height: "100%",
                        background: theme.ink,
                        borderRadius: 2,
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            <div
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: theme.muted,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: 14,
              }}
            >
              Your shelf
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 16,
                rowGap: 22,
              }}
            >
              {others.map((b) => (
                <div key={b.id} onClick={() => onOpen(b.id)}>
                  <BookCover
                    title={b.title}
                    author={b.author}
                    palette={paletteForId(b.id)}
                    size="sm"
                    src={covers[b.id]}
                  />
                  <div
                    style={{
                      fontFamily: titleFontFor(b.title),
                      fontSize: 12,
                      fontWeight: 500,
                      marginTop: 8,
                      lineHeight: 1.3,
                      color: theme.ink,
                      letterSpacing: "-0.005em",
                    }}
                  >
                    {b.title}
                  </div>
                  <div
                    style={{ fontSize: 9.5, color: theme.muted, marginTop: 2 }}
                  >
                    {b.author}
                  </div>
                  {b.progress > 0 && b.progress < 1 && (
                    <div
                      style={{
                        height: 2,
                        background: theme.rule,
                        borderRadius: 1,
                        marginTop: 6,
                      }}
                    >
                      <div
                        style={{
                          width: `${b.progress * 100}%`,
                          height: "100%",
                          background: theme.muted,
                          borderRadius: 1,
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HeroContinueCard({
  theme,
  book,
  coverSrc,
  onOpen,
  onDelete,
  onEdit,
}: {
  theme: Theme;
  book: BookIndexEntry;
  coverSrc?: string;
  onOpen: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const palette = paletteForId(book.id);
  return (
    <div
      style={{
        display: "flex",
        gap: 40,
        marginBottom: 50,
        alignItems: "flex-start",
        flexWrap: "wrap",
      }}
    >
      <BookCover
        title={book.title}
        author={book.author}
        palette={palette}
        size="lg"
        src={coverSrc}
      />
      {/* minWidth: 0 so the title's nowrap+ellipsis clips at the flex
          child's assigned width instead of letting the child grow to
          accommodate the full title. */}
      <div style={{ flex: 1, paddingTop: 10, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: theme.muted,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          {book.lastReadAt ? "Continue reading" : "Start reading"}
        </div>
        <h1
          title={book.title}
          style={{
            // Arabic / mixed titles use the Readex Pro stack so digits and
            // Latin punctuation interleaved in the title don't fall through
            // to Fraunces and stand out as a different typeface.
            fontFamily: titleFontFor(book.title),
            // Italic only makes sense on Fraunces — suppress it for the
            // Readex Pro path to avoid synthetic italic on Arabic.
            fontStyle: isArabicTitle(book.title) ? "normal" : "italic",
            fontWeight: 400,
            fontSize: 44,
            // Even more vertical room than 1.3 — the previous tweak still
            // clipped the bottom dot on letters like ج at this font size.
            lineHeight: 1.45,
            paddingBottom: 8,
            margin: "0 0 4px",
            letterSpacing: "-0.02em",
            color: theme.ink,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {book.title}
        </h1>
        <div style={{ fontSize: 13, color: theme.muted, marginBottom: 22 }}>
          by {book.author} · {book.chapterCount} chapters
        </div>
        <div
          style={{
            padding: 18,
            background: theme.chrome,
            borderRadius: 10,
            border: `0.5px solid ${theme.rule}`,
            maxWidth: 480,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                flex: 1,
                height: 4,
                background: theme.rule,
                borderRadius: 2,
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${book.progress * 100}%`,
                  background: theme.ink,
                  borderRadius: 2,
                }}
              />
            </div>
            <div
              style={{
                fontSize: 11,
                color: theme.muted,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {Math.round(book.progress * 100)}% · {relTime(book.lastReadAt ?? book.addedAt)}
            </div>
          </div>
          <div
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Button theme={theme} variant="primary" size="md" onClick={onOpen}>
              {book.lastReadAt ? "Resume reading →" : "Start reading →"}
            </Button>
            <Button theme={theme} variant="ghost" size="md" onClick={onEdit}>
              Edit details
            </Button>
            <Button
              theme={theme}
              variant="destructiveGhost"
              size="md"
              onClick={onDelete}
            >
              Remove from library
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LibraryCard({
  theme,
  book,
  coverSrc,
  onOpen,
  onContextMenu,
}: {
  theme: Theme;
  book: BookIndexEntry;
  coverSrc?: string;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      // Pin the whole card to the cover width so the title row's
      // ellipsis truncates at the cover edge and the progress meter
      // never extends past it. The grid track is `minmax(140, 1fr)` so
      // cells stretch on wide viewports — without this, everything
      // below the cover stretched with the cell.
      style={{ position: "relative", width: BOOK_COVER_DIMS.md.w }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <div style={{ cursor: "pointer" }} onClick={onOpen}>
        <div style={{ position: "relative" }}>
          <BookCover
            title={book.title}
            author={book.author}
            palette={paletteForId(book.id)}
            size="md"
            src={coverSrc}
          />
          {book.progress === 0 && (
            <span
              aria-label="New — not started yet"
              style={{
                position: "absolute",
                top: 8,
                left: 8,
                padding: "3px 7px",
                borderRadius: 4,
                // Dark blurred pill reads on any cover art without
                // dominating it. Same idiom we use elsewhere for cover-
                // surface overlays.
                background: "rgba(0,0,0,0.55)",
                color: "#fff",
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontFamily: FONT_STACKS.sans,
                backdropFilter: "blur(6px)",
                pointerEvents: "none",
              }}
            >
              New
            </span>
          )}
        </div>
        <div
          title={book.title}
          style={{
            marginTop: 12,
            fontFamily: titleFontFor(book.title),
            fontSize: 14,
            lineHeight: isArabicTitle(book.title) ? 1.4 : 1.25,
            color: theme.ink,
            letterSpacing: "-0.005em",
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {book.title}
        </div>
        <div style={{ fontSize: 11, color: theme.muted, marginTop: 2 }}>
          {book.author}
        </div>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 14,
          }}
        >
          {book.progress >= 1 ? (
            <span
              style={{
                fontSize: 10,
                color: theme.muted,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Icon name="check" size={11} /> Finished
            </span>
          ) : book.progress > 0 ? (
            <>
              <div
                style={{
                  flex: 1,
                  height: 2,
                  background: theme.rule,
                  borderRadius: 1,
                }}
              >
                <div
                  style={{
                    width: `${book.progress * 100}%`,
                    height: "100%",
                    background: theme.muted,
                    borderRadius: 1,
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 10,
                  color: theme.muted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {Math.round(book.progress * 100)}%
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  theme,
  onImport,
  importing,
}: {
  theme: Theme;
  onImport: () => void;
  importing: boolean;
}) {
  return (
    <div
      style={{
        maxWidth: 440,
        margin: "64px auto",
        padding: 32,
        borderRadius: 14,
        background: theme.chrome,
        border: `0.5px solid ${theme.rule}`,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: FONT_SERIF_DISPLAY,
          fontStyle: "italic",
          fontSize: 28,
          color: theme.ink,
          letterSpacing: "-0.02em",
          marginBottom: 8,
        }}
      >
        Your shelf is empty
      </div>
      <div
        style={{
          fontSize: 13,
          color: theme.muted,
          lineHeight: 1.55,
          marginBottom: 22,
        }}
      >
        Import an EPUB to start reading. Leaflet parses it locally — no
        uploads, no accounts.
      </div>
      <Button
        theme={theme}
        variant="primary"
        size="md"
        onClick={onImport}
        disabled={importing}
        leadingIcon={<Icon name="plus" size={14} />}
      >
        {importing ? "Importing…" : "Import your first EPUB"}
      </Button>
    </div>
  );
}

function shelfHeadingFor(tab: BookStatus): string {
  return tab === "reading"
    ? "Currently reading"
    : tab === "finished"
    ? "Finished"
    : "Wishlist";
}

function FilteredEmptyState({
  theme,
  tab,
}: {
  theme: Theme;
  tab: LibraryTab;
}) {
  const message =
    tab === "reading"
      ? "No books marked as reading yet."
      : tab === "finished"
      ? "No finished books yet."
      : tab === "wishlist"
      ? "Nothing on your wishlist yet."
      : "Nothing here.";
  return (
    <div
      style={{
        margin: "64px auto",
        maxWidth: 380,
        padding: 24,
        textAlign: "center",
        color: theme.muted,
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      {message}
      <div style={{ marginTop: 8, fontSize: 12 }}>
        Right-click a book to set its status.
      </div>
    </div>
  );
}

function ErrorBanner({
  theme,
  message,
}: {
  theme: Theme;
  message: string;
}) {
  return (
    <div
      style={{
        padding: "10px 14px",
        background: "rgba(180,60,60,0.08)",
        border: "0.5px solid rgba(180,60,60,0.3)",
        borderRadius: 8,
        color: theme.ink,
        fontSize: 12,
        marginBottom: 20,
      }}
    >
      <strong style={{ fontWeight: 600 }}>Import failed:</strong> {message}
    </div>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
