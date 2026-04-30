import { Icon } from "../components/Icon";
import type { EpubChapter } from "../epub/types";
import { FONT_SERIF_DISPLAY, FONT_STACKS, type Theme } from "../styles/tokens";
import { PanelShell } from "./PanelShell";

interface Props {
  theme: Theme;
  onClose?: () => void;
  bookTitle: string;
  chapters: EpubChapter[];
  currentChapter: number;
  onJump?: (order: number) => void;
  width?: number | string;
  side?: "left" | "right";
}

export function TOCPanel({
  theme,
  onClose,
  bookTitle,
  chapters,
  currentChapter,
  onJump,
  width,
  side = "left",
}: Props) {
  return (
    <PanelShell
      theme={theme}
      title="Contents"
      subtitle={bookTitle}
      onClose={onClose}
      icon={<Icon name="list" size={15} />}
      width={width}
      side={side}
    >
      <div style={{ padding: "8px 6px" }}>
        {chapters.map((c) => {
          const active = c.order === currentChapter;
          const read = c.order < currentChapter;
          return (
            <button
              key={c.id}
              onClick={() => onJump?.(c.order)}
              style={{
                width: "100%",
                textAlign: "left",
                border: "none",
                background: active ? theme.hover : "transparent",
                padding: "11px 14px",
                borderRadius: 8,
                cursor: "pointer",
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                color: theme.ink,
                marginBottom: 1,
              }}
            >
              <span
                style={{
                  fontFamily: FONT_STACKS.sans,
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: active ? theme.ink : theme.muted,
                  minWidth: 36,
                  letterSpacing: "0.04em",
                  opacity: read ? 0.55 : 1,
                }}
              >
                {String(c.order + 1).padStart(2, "0")}
              </span>
              <span
                style={{
                  fontFamily: FONT_SERIF_DISPLAY,
                  fontSize: 14.5,
                  fontWeight: active ? 500 : 400,
                  fontStyle: active ? "italic" : "normal",
                  color: read ? theme.muted : theme.ink,
                  flex: 1,
                  lineHeight: 1.3,
                }}
              >
                {c.title}
              </span>
              {active && (
                <span
                  style={{
                    fontFamily: FONT_STACKS.sans,
                    fontSize: 9,
                    color: theme.muted,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  Now
                </span>
              )}
            </button>
          );
        })}
      </div>
    </PanelShell>
  );
}
