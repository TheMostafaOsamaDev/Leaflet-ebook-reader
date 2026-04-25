import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import type { BookStatus } from "../store/library";
import { FONT_STACKS, type Theme } from "../styles/tokens";

export interface ContextMenuProps {
  theme: Theme;
  /** Click coordinates (clientX/clientY). The menu pins its top-left here,
      then nudges up/left if it would otherwise overflow the viewport. */
  x: number;
  y: number;
  status: BookStatus | undefined;
  onPickStatus: (s: BookStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const STATUS_OPTIONS: { value: BookStatus; label: string }[] = [
  { value: "reading", label: "Reading" },
  { value: "finished", label: "Finished" },
  { value: "wishlist", label: "Wishlist" },
];

export function ContextMenu({
  theme,
  x,
  y,
  status,
  onPickStatus,
  onEdit,
  onDelete,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [statusOpen, setStatusOpen] = useState(false);

  // Keep the menu inside the viewport — measure after mount and shift
  // left/up if the requested coords would push it off-screen.
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw - 8) nx = Math.max(8, vw - rect.width - 8);
    if (ny + rect.height > vh - 8) ny = Math.max(8, vh - rect.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Click-outside / Esc to dismiss. mousedown fires before any click handler
  // inside the menu re-renders, so we read the event target instead of
  // closing on every mousedown.
  useEffect(() => {
    const onDocMouse = (e: MouseEvent) => {
      const el = menuRef.current;
      if (el && !el.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 9500,
        minWidth: 200,
        background: theme.bg,
        color: theme.ink,
        border: `0.5px solid ${theme.rule}`,
        borderRadius: 8,
        boxShadow: "0 12px 32px rgba(0,0,0,0.25)",
        padding: 4,
        fontFamily: FONT_STACKS.sans,
        fontSize: 13,
      }}
    >
      <Item
        theme={theme}
        onMouseEnter={() => setStatusOpen(true)}
        onMouseLeave={() => setStatusOpen(false)}
        right={<Icon name="chevronR" size={14} />}
      >
        Status{status ? ` · ${labelFor(status)}` : ""}
        {statusOpen && (
          <div
            style={{
              position: "absolute",
              top: -4,
              left: "100%",
              marginLeft: 2,
              background: theme.bg,
              border: `0.5px solid ${theme.rule}`,
              borderRadius: 8,
              boxShadow: "0 12px 32px rgba(0,0,0,0.25)",
              padding: 4,
              minWidth: 140,
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <Item
                key={o.value}
                theme={theme}
                onClick={() => onPickStatus(o.value)}
                right={
                  status === o.value ? (
                    <Icon name="check" size={13} />
                  ) : null
                }
              >
                {o.label}
              </Item>
            ))}
          </div>
        )}
      </Item>
      <Item theme={theme} onClick={onEdit}>
        Edit book info
      </Item>
      <div
        style={{
          height: 1,
          background: theme.rule,
          margin: "4px 6px",
        }}
      />
      <Item theme={theme} onClick={onDelete} destructive>
        Remove book
      </Item>
    </div>
  );
}

function labelFor(s: BookStatus): string {
  return s === "reading" ? "Reading" : s === "finished" ? "Finished" : "Wishlist";
}

function Item({
  theme,
  onClick,
  onMouseEnter,
  onMouseLeave,
  right,
  destructive,
  children,
}: {
  theme: Theme;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  right?: ReactNode;
  destructive?: boolean;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => {
        setHover(true);
        onMouseEnter?.();
      }}
      onMouseLeave={() => {
        setHover(false);
        onMouseLeave?.();
      }}
      style={{
        position: "relative",
        padding: "8px 12px",
        borderRadius: 6,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        color: destructive ? "#c04a3a" : theme.ink,
        background: hover ? theme.hover : "transparent",
      }}
    >
      <span>{children}</span>
      {right && <span style={{ color: theme.muted }}>{right}</span>}
    </div>
  );
}
