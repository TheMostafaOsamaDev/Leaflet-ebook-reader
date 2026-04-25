import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { BookCover } from "./BookCover";
import { Button } from "./Button";
import { paletteForId } from "../store/palette";
import type { BookIndexEntry } from "../store/library";
import { FONT_SERIF_DISPLAY, FONT_STACKS, type Theme } from "../styles/tokens";

interface Props {
  theme: Theme;
  book: BookIndexEntry;
  coverSrc?: string;
  onSave: (patch: {
    title: string;
    author: string;
    description: string;
  }) => Promise<void> | void;
  onClose: () => void;
  onDelete: () => Promise<void> | void;
  onSetCover: () => Promise<void> | void;
  onRescanCover: () => Promise<void> | void;
}

export function EditBookModal({
  theme,
  book,
  coverSrc,
  onSave,
  onClose,
  onDelete,
  onSetCover,
  onRescanCover,
}: Props) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [description, setDescription] = useState(book.description ?? "");
  const [saving, setSaving] = useState(false);

  // Refresh local state if the parent swaps which book is being edited
  // (e.g. after rescan/setCover where the parent resets the entry).
  useEffect(() => {
    setTitle(book.title);
    setAuthor(book.author);
    setDescription(book.description ?? "");
  }, [book.id, book.title, book.author, book.description]);

  // Esc to close — small UX nicety since the overlay is modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        title: title.trim() || book.title,
        author: author.trim(),
        description: description.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit book details"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: FONT_STACKS.sans,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "90vh",
          background: theme.bg,
          color: theme.ink,
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: `0.5px solid ${theme.rule}`,
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `0.5px solid ${theme.rule}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_SERIF_DISPLAY,
                fontStyle: "italic",
                fontSize: 18,
                color: theme.ink,
              }}
            >
              Edit book
            </div>
            <div style={{ fontSize: 11, color: theme.muted, marginTop: 2 }}>
              Title, author, description, and cover
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              border: "none",
              background: "transparent",
              color: theme.chromeInk,
              borderRadius: 6,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 20,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: 24,
            alignItems: "start",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <BookCover
              title={book.title}
              author={book.author}
              palette={paletteForId(book.id)}
              size="md"
              src={coverSrc}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Button
                theme={theme}
                variant="outline"
                size="sm"
                onClick={() => onSetCover()}
              >
                Replace cover…
              </Button>
              <Button
                theme={theme}
                variant="outline"
                size="sm"
                onClick={() => onRescanCover()}
              >
                Rescan from EPUB
              </Button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <FieldLabel theme={theme}>Title</FieldLabel>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={textInput(theme)}
            />

            <FieldLabel theme={theme}>Author</FieldLabel>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              style={textInput(theme)}
            />

            <FieldLabel theme={theme}>Description</FieldLabel>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              style={{
                ...textInput(theme),
                resize: "vertical",
                minHeight: 100,
                fontFamily: FONT_STACKS.sans,
              }}
            />
          </div>
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: `0.5px solid ${theme.rule}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Button
            theme={theme}
            variant="destructive"
            size="sm"
            onClick={() => void onDelete()}
          >
            Remove from library
          </Button>
          <div style={{ flex: 1 }} />
          <Button theme={theme} variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            theme={theme}
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({
  theme,
  children,
}: {
  theme: Theme;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        color: theme.muted,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function textInput(theme: Theme): React.CSSProperties {
  return {
    width: "100%",
    background: theme.chrome,
    color: theme.ink,
    border: `0.5px solid ${theme.rule}`,
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13,
    fontFamily: FONT_STACKS.sans,
    outline: "none",
  };
}

