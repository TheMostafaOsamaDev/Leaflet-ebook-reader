import { useState } from "react";
import { Icon } from "../components/Icon";
import type { Highlight } from "../store/library";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  HIGHLIGHT_COLORS,
  hlBg,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
import { PanelShell } from "./PanelShell";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  onClose?: () => void;
  highlights: Highlight[];
  onJump?: (h: Highlight) => void;
  onDelete?: (id: string) => void;
  onUpdateNote?: (id: string, note: string) => void;
}

export function HighlightsPanel({
  theme,
  themeKey,
  onClose,
  highlights,
  onJump,
  onDelete,
  onUpdateNote,
}: Props) {
  // Most recent first — matches the order people expect when scanning
  // for "what did I just save?"
  const sorted = [...highlights].sort((a, b) => b.ts - a.ts);
  return (
    <PanelShell
      theme={theme}
      title="Highlights & Notes"
      subtitle={
        highlights.length === 0
          ? "None yet"
          : `${highlights.length} in this book`
      }
      onClose={onClose}
      icon={<Icon name="highlight" size={14} />}
    >
      {sorted.length === 0 ? (
        <Empty theme={theme} />
      ) : (
        <div style={{ padding: "10px" }}>
          {sorted.map((h) => (
            <HighlightRow
              key={h.id}
              theme={theme}
              themeKey={themeKey}
              highlight={h}
              onJump={onJump}
              onDelete={onDelete}
              onUpdateNote={onUpdateNote}
            />
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function HighlightRow({
  theme,
  themeKey,
  highlight: h,
  onJump,
  onDelete,
  onUpdateNote,
}: {
  theme: Theme;
  themeKey: ThemeKey;
  highlight: Highlight;
  onJump?: (h: Highlight) => void;
  onDelete?: (id: string) => void;
  onUpdateNote?: (id: string, note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(h.note ?? "");

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(h.note ?? "");
    setEditing(true);
  };
  const save = () => {
    if (onUpdateNote) onUpdateNote(h.id, draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(h.note ?? "");
    setEditing(false);
  };

  return (
    <div
      onClick={() => {
        if (editing) return;
        if (onJump) onJump(h);
      }}
      style={{
        padding: "12px 14px",
        borderRadius: 10,
        marginBottom: 4,
        borderLeft: `3px solid ${HIGHLIGHT_COLORS[h.color].dot}`,
        background: hlBg(h.color, themeKey),
        cursor: editing ? "default" : onJump ? "pointer" : "default",
        position: "relative",
      }}
    >
      <div
        style={{
          fontFamily: '"Literata", Georgia, serif',
          fontSize: 13.5,
          lineHeight: 1.55,
          color: theme.ink,
          paddingRight: 56,
        }}
      >
        {h.text}
      </div>

      {editing ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ marginTop: 8 }}
        >
          <textarea
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            placeholder="Note…"
            rows={3}
            style={{
              width: "100%",
              background: theme.chrome,
              color: theme.ink,
              border: `0.5px solid ${theme.rule}`,
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 11.5,
              fontFamily: FONT_STACKS.sans,
              outline: "none",
              resize: "vertical",
              minHeight: 50,
            }}
          />
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 6,
              justifyContent: "flex-end",
            }}
          >
            <button onClick={cancel} style={ghostBtn(theme)}>
              Cancel
            </button>
            <button onClick={save} style={primaryBtn(theme)}>
              Save
            </button>
          </div>
        </div>
      ) : h.note ? (
        <div
          style={{
            fontFamily: FONT_STACKS.sans,
            fontSize: 11.5,
            color: theme.ink,
            marginTop: 8,
            paddingLeft: 10,
            borderLeft: `1.5px solid ${theme.rule}`,
            fontStyle: "italic",
            lineHeight: 1.4,
          }}
        >
          {h.note}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: theme.muted,
            fontFamily: FONT_STACKS.sans,
          }}
        >
          Chapter {h.chapter + 1}
        </div>
        {!editing && (
          <div style={{ display: "flex", gap: 2 }}>
            {onUpdateNote && (
              <button
                onClick={startEdit}
                aria-label={h.note ? "Edit note" : "Add note"}
                title={h.note ? "Edit note" : "Add note"}
                style={iconBtn(theme)}
              >
                <Icon name="pencil" size={12} />
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(h.id);
                }}
                aria-label="Delete highlight"
                title="Delete highlight"
                style={iconBtn(theme)}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ theme }: { theme: Theme }) {
  return (
    <div style={{ padding: "40px 24px", textAlign: "center" }}>
      <div
        style={{
          fontFamily: FONT_SERIF_DISPLAY,
          fontStyle: "italic",
          fontSize: 16,
          color: theme.ink,
          marginBottom: 6,
        }}
      >
        No highlights yet
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: theme.muted,
          lineHeight: 1.5,
          maxWidth: 260,
          margin: "0 auto",
        }}
      >
        Select text while reading to highlight it, then add a note to remember
        why it mattered.
      </div>
    </div>
  );
}

function iconBtn(theme: Theme): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    border: "none",
    borderRadius: 5,
    background: "transparent",
    color: theme.muted,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function ghostBtn(theme: Theme): React.CSSProperties {
  return {
    padding: "4px 9px",
    border: `0.5px solid ${theme.rule}`,
    borderRadius: 6,
    background: "transparent",
    color: theme.ink,
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: FONT_STACKS.sans,
  };
}

function primaryBtn(theme: Theme): React.CSSProperties {
  return {
    padding: "4px 9px",
    border: "none",
    borderRadius: 6,
    background: theme.ink,
    color: theme.bg,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: FONT_STACKS.sans,
  };
}
