import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Theme } from "../styles/tokens";
import { FONT_STACKS } from "../styles/tokens";

interface Props {
  theme: Theme;
  /** Leaves the reader, so a broken chapter is never a dead end. */
  onBack?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Catches a render error inside the reader and says what happened.
 *
 * Without this, an exception thrown while rendering a chapter unmounts the
 * whole React tree, and what the reader is left looking at is an empty window
 * painted in the theme's paper colour — no text, no chapter title, and no
 * chrome either, since the top bar and scrubber go with it. It is
 * indistinguishable from a chapter that loaded blank, which makes it very
 * expensive to diagnose from a screenshot: the two look identical and point at
 * completely different causes.
 *
 * So the reader gets a boundary that keeps the window populated, names the
 * error, and offers a way out.
 */
export class ReaderErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? null });
    // Still log it — the webview console is where a `tauri dev` session can
    // read the full trace.
    console.error("[reader] render error", error, info.componentStack);
  }

  render() {
    const { error, stack } = this.state;
    const { theme, onBack, children } = this.props;
    if (!error) return children;

    const details = [error.message, stack ?? ""].join("\n\n").trim();
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 200,
          background: theme.bg,
          color: theme.ink,
          fontFamily: FONT_STACKS.sans,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          direction: "ltr",
        }}
      >
        <div style={{ maxWidth: 620, width: "100%" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
            This chapter could not be displayed
          </div>
          <div style={{ fontSize: 12.5, color: theme.muted, marginBottom: 16, lineHeight: 1.6 }}>
            The reader hit an error while rendering. Nothing was lost — going back
            and reopening the book is safe.
          </div>
          <pre
            style={{
              margin: 0,
              maxHeight: 260,
              overflow: "auto",
              padding: 12,
              borderRadius: 8,
              background: theme.chrome,
              border: `1px solid ${theme.rule}`,
              color: theme.chromeInk,
              font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
              whiteSpace: "pre-wrap",
            }}
          >
            {details || String(error)}
          </pre>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {onBack ? (
              <button
                onClick={onBack}
                style={{
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 13,
                  minHeight: 44,
                  padding: "0 18px",
                  borderRadius: 10,
                  border: "none",
                  background: theme.ink,
                  color: theme.bg,
                }}
              >
                Back to library
              </button>
            ) : null}
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(details);
              }}
              style={{
                cursor: "pointer",
                font: "inherit",
                fontSize: 13,
                minHeight: 44,
                padding: "0 18px",
                borderRadius: 10,
                background: "transparent",
                color: theme.ink,
                border: `1px solid ${theme.ruleStrong}`,
              }}
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
