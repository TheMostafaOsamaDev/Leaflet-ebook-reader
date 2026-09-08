// Shared reader top chrome: back/home button · divider · nav cluster ·
// centered title + subtitle · trailing cluster, with a 2px progress fill pinned
// to the bottom edge. Used by both the reflow DesktopReader and the fixed-page
// FixedPageReader so the two readers share one top-bar implementation.
//
// The nav/trailing button clusters are passed as slots (each reader builds them
// with ReaderIconButton) — only the layout, title block, and progress fill live
// here.

import type { CSSProperties, ReactNode, RefObject } from "react";
import { FONT_STACKS, type Theme } from "../../styles/tokens";
import { fractionToWidth } from "../../components/readerProgress";
import { ReaderIconButton } from "./ReaderIconButton";
import { glassBar } from "./glass";
import type { IconProps } from "../../components/Icon";

interface Props {
  theme: Theme;
  onBack: () => void;
  backLabel: string;
  /** Leading icon — "home" for both readers by default. */
  backIcon?: IconProps["name"];
  title: string;
  subtitle?: string;
  /** Extra title styling (font family / italic) — the reflow reader varies the
   *  title font per chapter language; the fixed reader keeps the sans stack. */
  titleStyle?: CSSProperties;
  /** Nav cluster after the back button + divider (e.g. TOC, bookmarks). */
  navButtons?: ReactNode;
  /** Trailing cluster (e.g. progress, settings). */
  trailing?: ReactNode;
  /** Imperatively-updated fill (reflow reader writes width on scroll frames). */
  progressFillRef?: RefObject<HTMLDivElement | null>;
  /** Static fill fraction (fixed-page reader updates via state). 0..1. */
  progressFraction?: number;
  /** Fill grows from the reading-start edge: right in RTL, left in LTR. */
  fillRtl?: boolean;
}

export function ReaderTopBar({
  theme,
  onBack,
  backLabel,
  backIcon = "home",
  title,
  subtitle,
  titleStyle,
  navButtons,
  trailing,
  progressFillRef,
  progressFraction,
  fillRtl = false,
}: Props) {
  // The bar floats over the page in both readers, so it carries the frosted
  // fill (and the hairline that keeps it from dissolving into the paragraph
  // underneath) rather than an opaque one — see reader/chrome/glass.ts.
  //
  // The `backdrop-filter` lives on THIS element, not on a wrapper: an ancestor
  // with `opacity` < 1 becomes a backdrop root and the blur inside it has
  // nothing to sample, which is why focus mode's sliding layer no longer
  // fades.
  const glass = glassBar(theme, "top");
  return (
    <div
      className={glass.className}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 10,
        // Clear the status bar / notch on Android: the reader is drawn
        // edge-to-edge, so without the inset the back button and title sit
        // under the system clock and can't be tapped. Resolves to a plain
        // 14px on desktop, where the inset is 0.
        padding: "calc(14px + env(safe-area-inset-top, 0px)) 22px 14px",
        ...glass.style,
        color: theme.chromeInk,
        fontFamily: FONT_STACKS.sans,
        flexShrink: 0,
      }}
    >
      <ReaderIconButton theme={theme} icon={backIcon} label={backLabel} onClick={onBack} />
      <div style={{ width: 1, height: 18, background: theme.rule, margin: "0 4px" }} />
      {navButtons}

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          minWidth: 0,
        }}
      >
        <div
          title={title}
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            fontWeight: 500,
            color: theme.ink,
            letterSpacing: "-0.01em",
            width: "100%",
            textAlign: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            ...titleStyle,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 10.5, color: theme.muted }}>{subtitle}</div>
        )}
      </div>

      {trailing}

      {/* 2px progress fill pinned to the bottom edge (indicative only). */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 2,
          background: theme.rule,
          pointerEvents: "none",
        }}
      >
        <div
          ref={progressFillRef}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            ...(fillRtl ? { right: 0 } : { left: 0 }),
            width: fractionToWidth(progressFraction ?? 0),
            background: theme.ink,
          }}
        />
      </div>
    </div>
  );
}
