import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FONT_STACKS, type Theme } from "../styles/tokens";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "destructiveGhost";

export type ButtonSize = "sm" | "md";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "ref"> {
  theme: Theme;
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  type?: "button" | "submit" | "reset";
}

// Press animation feels right for action buttons but not for chrome icon
// buttons in the reader's header — those have their own toolbar feel. Keep
// this component focused on labelled actions; icon-only chrome buttons
// stay where they are.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    theme,
    variant = "primary",
    size = "md",
    leadingIcon,
    trailingIcon,
    fullWidth,
    type = "button",
    disabled,
    style,
    children,
    onMouseEnter,
    onMouseLeave,
    onMouseDown,
    onMouseUp,
    onBlur,
    ...rest
  },
  ref,
) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);

  const padding = size === "sm" ? "7px 12px" : "9px 18px";
  const fontSize = size === "sm" ? 12 : 13;
  const gap = size === "sm" ? 6 : 8;

  const interactive = !disabled;
  const v = variantStyle(variant, theme, interactive && hover);

  const composed: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap,
    padding,
    fontSize,
    fontWeight: variant === "primary" || variant === "destructive" ? 600 : 500,
    fontFamily: FONT_STACKS.sans,
    letterSpacing: "-0.005em",
    borderRadius: 8,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    transition:
      "transform 90ms ease, background 120ms ease, color 120ms ease, box-shadow 120ms ease",
    transform: interactive && pressed ? "scale(0.97)" : "scale(1)",
    width: fullWidth ? "100%" : undefined,
    userSelect: "none",
    // Buttons should never wrap their label across lines — they're sized
    // by content. If you need a multi-line button you're using the wrong
    // primitive.
    whiteSpace: "nowrap",
    ...v,
    ...style,
  };

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      style={composed}
      onMouseEnter={(e) => {
        setHover(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        setPressed(false);
        onMouseLeave?.(e);
      }}
      onMouseDown={(e) => {
        setPressed(true);
        onMouseDown?.(e);
      }}
      onMouseUp={(e) => {
        setPressed(false);
        onMouseUp?.(e);
      }}
      onBlur={(e) => {
        setPressed(false);
        onBlur?.(e);
      }}
      {...rest}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

function variantStyle(
  variant: ButtonVariant,
  theme: Theme,
  hover: boolean,
): CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: theme.ink,
        color: theme.bg,
        border: "none",
        // Inset overlay lifts the dark surface a touch on hover without
        // needing a per-theme palette of shades.
        boxShadow: hover
          ? "inset 0 0 0 9999px rgba(255,255,255,0.10)"
          : "none",
      };
    case "secondary":
      return {
        background: theme.chrome,
        color: theme.ink,
        border: `0.5px solid ${theme.rule}`,
        boxShadow: hover ? "inset 0 0 0 9999px rgba(0,0,0,0.04)" : "none",
      };
    case "outline":
      return {
        background: hover ? theme.hover : "transparent",
        color: theme.ink,
        border: `0.5px solid ${theme.rule}`,
      };
    case "ghost":
      return {
        background: hover ? theme.hover : "transparent",
        color: hover ? theme.ink : theme.muted,
        border: "none",
      };
    case "destructive":
      return {
        background: hover ? "rgba(192,74,58,0.10)" : "transparent",
        color: "#c04a3a",
        border: "0.5px solid #c04a3a",
      };
    case "destructiveGhost":
      // Same red as `destructive` but no border — for inline secondary
      // actions like 'Remove from library' on the hero card, where a
      // bordered button would feel too heavy next to a ghost 'Edit
      // details' sibling.
      return {
        background: hover ? "rgba(192,74,58,0.10)" : "transparent",
        color: "#c04a3a",
        border: "none",
      };
  }
}
