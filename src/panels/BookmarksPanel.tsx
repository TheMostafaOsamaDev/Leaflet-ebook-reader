import { Icon } from "../components/Icon";
import type { Bookmark } from "../store/library";
import { FONT_SERIF_DISPLAY, FONT_STACKS, type Theme } from "../styles/tokens";
import { PanelShell } from "./PanelShell";

interface Props {
  theme: Theme;
  onClose?: () => void;
  bookmarks: Bookmark[];
  onJump?: (chapter: number) => void;
  onDelete?: (id: string) => void;
}

export function BookmarksPanel({
  theme,
  onClose,
  bookmarks,
  onJump,
  onDelete,
}: Props) {
  return (
    <PanelShell
      theme={theme}
      title="Bookmarks"
      subtitle={
        bookmarks.length === 0
          ? "None yet"
          : `${bookmarks.length} in this book`
      }
      onClose={onClose}
      icon={<Icon name="bookmark" size={14} />}
    >
      {bookmarks.length === 0 ? (
        <Empty theme={theme} />
      ) : (
        <div style={{ padding: "6px 10px" }}>
          {bookmarks.map((b) => (
            <div
              key={b.id}
              onClick={() => onJump?.(b.chapter)}
              style={{
                padding: "14px 12px",
                borderRadius: 10,
                cursor: "pointer",
                marginBottom: 2,
                position: "relative",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_STACKS.sans,
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: theme.muted,
                    letterSpacing: "0.04em",
                  }}
                >
                  Chapter {b.chapter + 1}
                </span>
                <span
                  style={{
                    fontFamily: FONT_STACKS.sans,
                    fontSize: 10,
                    color: theme.muted,
                  }}
                >
                  {relTime(b.ts)}
                </span>
              </div>
              <div
                style={{
                  fontFamily: '"Literata", Georgia, serif',
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  color: theme.ink,
                  fontStyle: "italic",
                }}
              >
                &ldquo;{b.excerpt}&rdquo;
              </div>
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(b.id);
                  }}
                  aria-label="Remove bookmark"
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 22,
                    height: 22,
                    border: "none",
                    background: "transparent",
                    color: theme.muted,
                    borderRadius: 4,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function Empty({ theme }: { theme: Theme }) {
  return (
    <div
      style={{
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: FONT_SERIF_DISPLAY,
          fontStyle: "italic",
          fontSize: 16,
          color: theme.ink,
          marginBottom: 6,
        }}
      >
        No bookmarks yet
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: theme.muted,
          lineHeight: 1.5,
          maxWidth: 240,
          margin: "0 auto",
        }}
      >
        Tap the bookmark icon in the toolbar to save your place.
      </div>
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
  return new Date(ts).toLocaleDateString();
}
