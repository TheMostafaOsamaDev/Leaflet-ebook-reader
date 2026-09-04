// Overflow menu for a volume header: download the whole volume, or
// delete its downloads. Responsive shell — a bottom sheet on mobile, an
// anchored popover on desktop — mirroring DownloadRangeDialog.
//
// Not ContextMenu: that one is shaped around a library book (cover,
// author, reading status, edit/delete) and none of it applies here.

import { useEffect, useRef } from "react";
import { MobileSheet } from "./MobileSheet";
import { Icon } from "./Icon";
import { FONT_STACKS, type Theme } from "../styles/tokens";

export interface VolumeAction {
  id: "download-all" | "delete-read" | "delete-all";
  label: string;
  icon: "download" | "trash";
  destructive?: boolean;
  disabled?: boolean;
}

interface Props {
  theme: Theme;
  layout: "desktop" | "mobile";
  open: boolean;
  /** Viewport coords of the trigger. Desktop only; ignored on mobile. */
  anchor: { x: number; y: number } | null;
  title: string;
  subtitle: string;
  actions: VolumeAction[];
  onPick: (id: VolumeAction["id"]) => void;
  onClose: () => void;
}

const DANGER = "#b75050";

export function VolumeActionsMenu({
  theme, layout, open, anchor, title, subtitle, actions, onPick, onClose,
}: Props) {
  const rows = (
    <div style={{ fontFamily: FONT_STACKS.sans }}>
      {actions.map((a) => (
        <button
          key={a.id}
          disabled={a.disabled}
          onClick={() => {
            if (a.disabled) return;
            onPick(a.id);
            onClose();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            // 44px minimum touch target, and comfortable with a mouse.
            paddingBlock: 12,
            paddingInline: 12,
            border: "none",
            background: "transparent",
            borderRadius: 8,
            font: "inherit",
            fontSize: 13,
            textAlign: "start",
            cursor: a.disabled ? "default" : "pointer",
            opacity: a.disabled ? 0.42 : 1,
            color: a.destructive ? DANGER : theme.ink,
          }}
          onMouseEnter={(e) => {
            if (!a.disabled) e.currentTarget.style.background = theme.hover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <Icon name={a.icon} size={15} />
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );

  if (layout === "mobile") {
    return (
      <MobileSheet
        theme={theme}
        open={open}
        onClose={onClose}
        label={title}
        // Sized to its content: a header plus three rows. The
        // percentage still bounds it on short phones.
        height="min(46%, 320px)"
      >
        <div style={{ padding: "4px 8px 16px" }}>
          <div style={{ padding: "0 12px 12px" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 12, color: theme.muted }}>{subtitle}</div>
          </div>
          {rows}
        </div>
      </MobileSheet>
    );
  }

  return <DesktopPopover {...{ theme, open, anchor, onClose }}>{rows}</DesktopPopover>;
}

function DesktopPopover({
  theme, open, anchor, onClose, children,
}: {
  theme: Theme;
  open: boolean;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  if (!open || !anchor) return null;
  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        // Clamp so a volume header near the viewport edge doesn't push
        // the menu off-screen.
        top: Math.min(anchor.y + 6, window.innerHeight - 190),
        left: Math.min(anchor.x, window.innerWidth - 270),
        zIndex: 9800,
        minWidth: 250,
        padding: 5,
        background: theme.bg,
        border: `0.5px solid ${theme.rule}`,
        borderRadius: 12,
        boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
      }}
    >
      {children}
    </div>
  );
}
