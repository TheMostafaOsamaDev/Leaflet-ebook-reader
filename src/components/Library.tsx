import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { Icon } from "./Icon";
import { BookCover } from "./BookCover";
import { Toast, type ToastMessage } from "./Toast";
import { EditBookModal } from "./EditBookModal";
import {
  clearLibrary,
  coverSrcFor,
  listBooks,
  pickAndImportEpub,
  pickAndImportFolder,
  deleteBook,
  rescanCover,
  setCoverFromFile,
  updateBookMeta,
  type BookIndexEntry,
} from "../store/library";
import { paletteForId } from "../store/palette";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
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
        onImportFolder={onImportFolder}
        onClearAll={onClearAll}
        onDelete={onDelete}
        onEdit={(id) => setEditingId(id)}
        onRescanCover={onRescanCover}
        onSetCover={onSetCover}
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
        onImportFolder={onImportFolder}
        onClearAll={onClearAll}
        onDelete={onDelete}
        onEdit={(id) => setEditingId(id)}
        onRescanCover={onRescanCover}
        onSetCover={onSetCover}
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
          onSetCover={() => onSetCover(editingBook.id)}
          onRescanCover={() => onRescanCover(editingBook.id)}
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
  onImportFolder: () => void;
  onClearAll: () => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onRescanCover: (id: string) => void;
  onSetCover: (id: string) => void;
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
  onImportFolder,
  onClearAll,
  onDelete,
  onEdit,
  onRescanCover,
  onSetCover,
}: LayoutProps) {
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
          {["Library", "Reading", "Finished", "Wishlist"].map((l, i) => (
            <button
              key={l}
              style={{
                border: "none",
                background: i === 0 ? theme.hover : "transparent",
                color: i === 0 ? theme.ink : theme.muted,
                padding: "6px 12px",
                borderRadius: 7,
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {import.meta.env.DEV && (
          <button
            onClick={onClearAll}
            disabled={importing}
            title="Dev only — wipes every book from the library"
            style={{
              padding: "7px 14px",
              background: "transparent",
              color: "#c04a3a",
              border: "0.5px solid #c04a3a",
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 500,
              cursor: importing ? "progress" : "pointer",
              fontFamily: FONT_STACKS.sans,
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginRight: 8,
              opacity: importing ? 0.6 : 1,
            }}
          >
            <Icon name="close" size={13} />
            Clear all
          </button>
        )}
        <button
          onClick={onImportFolder}
          disabled={importing}
          style={{
            padding: "7px 14px",
            background: "transparent",
            color: theme.ink,
            border: `0.5px solid ${theme.rule}`,
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 500,
            cursor: importing ? "progress" : "pointer",
            fontFamily: FONT_STACKS.sans,
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginRight: 8,
            opacity: importing ? 0.6 : 1,
          }}
        >
          <Icon name="plus" size={13} />
          Import folder
        </button>
        <button
          onClick={onImport}
          disabled={importing}
          style={{
            padding: "7px 14px",
            background: theme.ink,
            color: theme.bg,
            border: "none",
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: importing ? "progress" : "pointer",
            fontFamily: FONT_STACKS.sans,
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: importing ? 0.6 : 1,
          }}
        >
          <Icon name="plus" size={13} />
          {importing ? "Importing…" : "Import EPUB"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "32px 40px 40px" }}>
        {error && <ErrorBanner theme={theme} message={error} />}

        {loading && books.length === 0 ? (
          <div style={{ color: theme.muted, padding: 40, textAlign: "center" }}>
            Loading your library…
          </div>
        ) : books.length === 0 ? (
          <EmptyState theme={theme} onImport={onImport} importing={importing} />
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
                onRescanCover={() => onRescanCover(hero.id)}
                onSetCover={() => onSetCover(hero.id)}
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
                  Your shelf
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
                  onDelete={() => onDelete(b.id)}
                  onEdit={() => onEdit(b.id)}
                  onRescanCover={() => onRescanCover(b.id)}
                  onSetCover={() => onSetCover(b.id)}
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
  onImportFolder,
  onClearAll,
}: LayoutProps) {
  // `onEdit`, `onDelete`, `onRescanCover`, `onSetCover` are accepted in
  // LayoutProps but mobile cards don't expose per-book actions yet (long-
  // press menu is a TODO). The desktop layout is the only consumer today.
  // `onRescanCover`/`onSetCover` arrive in LayoutProps but mobile's compact
  // cards don't expose them yet — long-press menu is a TODO.
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
                      fontFamily: FONT_SERIF_DISPLAY,
                      fontStyle: "italic",
                      fontSize: 18,
                      lineHeight: 1.15,
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
                      fontFamily: FONT_SERIF_DISPLAY,
                      fontSize: 12,
                      fontWeight: 500,
                      marginTop: 8,
                      lineHeight: 1.2,
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
  onRescanCover,
  onSetCover,
}: {
  theme: Theme;
  book: BookIndexEntry;
  coverSrc?: string;
  onOpen: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRescanCover: () => void;
  onSetCover: () => void;
}) {
  const palette = paletteForId(book.id);
  const hasRealCover = !!coverSrc;
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
      <div style={{ position: "relative" }}>
        <BookCover
          title={book.title}
          author={book.author}
          palette={palette}
          size="lg"
          src={coverSrc}
        />
        {!hasRealCover && (
          <CoverFixHint
            theme={theme}
            onRescan={() => onRescanCover()}
            onPick={() => onSetCover()}
          />
        )}
      </div>
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
            fontFamily: FONT_SERIF_DISPLAY,
            fontStyle: "italic",
            fontWeight: 400,
            fontSize: 44,
            // Generous line-height so Arabic descenders (dots below ب, ج, ي…)
            // aren't clipped by overflow: hidden. 1.05 was fine for Latin-only
            // but cut off the bottom of Arabic glyphs after the Readex Pro
            // switch.
            lineHeight: 1.3,
            paddingBottom: 4,
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
              gap: 12,
            }}
          >
            <button
              onClick={onOpen}
              style={{
                padding: "10px 20px",
                background: theme.ink,
                color: theme.bg,
                border: "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FONT_STACKS.sans,
                letterSpacing: "-0.01em",
              }}
            >
              {book.lastReadAt ? "Resume reading →" : "Start reading →"}
            </button>
            <button
              onClick={onEdit}
              style={{
                padding: "10px 14px",
                background: "transparent",
                color: theme.muted,
                border: "none",
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: FONT_STACKS.sans,
              }}
            >
              Edit details
            </button>
            <button
              onClick={() => {
                if (confirm(`Remove “${book.title}” from your library?`))
                  onDelete();
              }}
              style={{
                padding: "10px 14px",
                background: "transparent",
                color: theme.muted,
                border: "none",
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: FONT_STACKS.sans,
              }}
            >
              Remove from library
            </button>
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
  onDelete,
  onEdit,
  onRescanCover,
  onSetCover,
}: {
  theme: Theme;
  book: BookIndexEntry;
  coverSrc?: string;
  onOpen: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRescanCover: () => void;
  onSetCover: () => void;
}) {
  const hasRealCover = !!coverSrc;
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ cursor: "pointer" }} onClick={onOpen}>
        <BookCover
          title={book.title}
          author={book.author}
          palette={paletteForId(book.id)}
          size="md"
          src={coverSrc}
        />
        {!hasRealCover && (
          <CoverFixHint
            theme={theme}
            onRescan={(e) => {
              e.stopPropagation();
              onRescanCover();
            }}
            onPick={(e) => {
              e.stopPropagation();
              onSetCover();
            }}
          />
        )}
        <div
          style={{
            marginTop: 12,
            fontFamily: FONT_SERIF_DISPLAY,
            fontSize: 14,
            lineHeight: 1.25,
            color: theme.ink,
            letterSpacing: "-0.005em",
            fontWeight: 500,
            textWrap: "balance",
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
          ) : book.progress === 0 ? (
            <span
              style={{
                fontSize: 10,
                color: theme.ink,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "2px 7px",
                border: `0.5px solid ${theme.ink}`,
                borderRadius: 3,
              }}
            >
              New
            </span>
          ) : (
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
          )}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          display: "flex",
          gap: 4,
          opacity: hover ? 1 : 0,
          transition: "opacity .12s",
          pointerEvents: hover ? "auto" : "none",
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="Edit details"
          aria-label="Edit details"
          style={hoverIconBtn}
          onFocus={() => setHover(true)}
          onBlur={() => setHover(false)}
        >
          <Icon name="pencil" size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Remove “${book.title}” from your library?`))
              onDelete();
          }}
          title="Remove from library"
          aria-label="Remove from library"
          style={hoverIconBtn}
          onFocus={() => setHover(true)}
          onBlur={() => setHover(false)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}

const hoverIconBtn: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 12,
  border: "none",
  background: "rgba(0,0,0,0.5)",
  color: "#fff",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

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
      <button
        onClick={onImport}
        disabled={importing}
        style={{
          padding: "11px 22px",
          background: theme.ink,
          color: theme.bg,
          border: "none",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          cursor: importing ? "progress" : "pointer",
          fontFamily: FONT_STACKS.sans,
          letterSpacing: "-0.01em",
          opacity: importing ? 0.6 : 1,
        }}
      >
        {importing ? "Importing…" : "Import your first EPUB"}
      </button>
    </div>
  );
}

/**
 * A small, unobtrusive overlay anchored to the bottom of the cover art.
 * Only shown when no real cover image was extracted — offers a one-click
 * re-scan, and a "Set cover…" escape hatch to pick any image from disk.
 */
function CoverFixHint({
  theme,
  onRescan,
  onPick,
}: {
  theme: Theme;
  onRescan: (e: MouseEvent) => void;
  onPick: (e: MouseEvent) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 6,
        right: 6,
        bottom: 6,
        display: "flex",
        gap: 4,
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <button
        onClick={onRescan}
        title="Try extracting the cover from the EPUB again"
        aria-label="Rescan cover"
        style={{
          pointerEvents: "auto",
          flex: 1,
          padding: "5px 6px",
          border: "none",
          borderRadius: 5,
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          fontSize: 10,
          fontFamily: FONT_STACKS.sans,
          fontWeight: 600,
          letterSpacing: "0.04em",
          cursor: "pointer",
          backdropFilter: "blur(6px)",
        }}
      >
        Rescan
      </button>
      <button
        onClick={onPick}
        title="Pick any image from your computer to use as the cover"
        aria-label="Set cover from file"
        style={{
          pointerEvents: "auto",
          flex: 1,
          padding: "5px 6px",
          border: "none",
          borderRadius: 5,
          background: theme.ink,
          color: theme.bg,
          fontSize: 10,
          fontFamily: FONT_STACKS.sans,
          fontWeight: 600,
          letterSpacing: "0.04em",
          cursor: "pointer",
        }}
      >
        Set cover…
      </button>
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
