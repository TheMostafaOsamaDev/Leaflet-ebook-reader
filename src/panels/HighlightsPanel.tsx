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
}

export function HighlightsPanel({
  theme,
  themeKey,
  onClose,
  highlights,
}: Props) {
  return (
    <PanelShell
      theme={theme}
      title="Highlights & Notes"
      subtitle={
        highlights.length === 0 ? "None yet" : `${highlights.length} in this book`
      }
      onClose={onClose}
      icon={<Icon name="highlight" size={14} />}
    >
      {highlights.length === 0 ? (
        <Empty theme={theme} />
      ) : (
        <div style={{ padding: "10px" }}>
          {highlights.map((h) => (
            <div
              key={h.id}
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                marginBottom: 4,
                borderLeft: `3px solid ${HIGHLIGHT_COLORS[h.color].dot}`,
                background: hlBg(h.color, themeKey),
              }}
            >
              <div
                style={{
                  fontFamily: '"Literata", Georgia, serif',
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  color: theme.ink,
                }}
              >
                {h.text}
              </div>
              {h.note && (
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
              )}
              <div
                style={{
                  marginTop: 8,
                  fontSize: 10,
                  color: theme.muted,
                  fontFamily: FONT_STACKS.sans,
                }}
              >
                Chapter {h.chapter + 1}
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
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
