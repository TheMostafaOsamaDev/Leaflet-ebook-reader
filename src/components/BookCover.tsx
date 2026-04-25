import { useState } from "react";
import { FONT_SERIF_DISPLAY, FONT_STACKS } from "../styles/tokens";

interface Props {
  title: string;
  author: string;
  palette: readonly [string, string, string];
  size?: "sm" | "md" | "lg";
  /**
   * Webview-loadable cover URL (e.g. from `convertFileSrc`). When present,
   * the image replaces the palette/text spine. If it fails to load, we fall
   * back to the palette rendering automatically.
   */
  src?: string | null;
}

export const BOOK_COVER_DIMS = {
  sm: { w: 110, h: 164 },
  md: { w: 140, h: 208 },
  lg: { w: 200, h: 296 },
} as const;

export function BookCover({ title, author, palette, size = "md", src }: Props) {
  const { w, h } = BOOK_COVER_DIMS[size];
  const [p1, p2, p3] = palette;
  const [failed, setFailed] = useState(false);
  const showImage = !!src && !failed;

  const shellStyle = {
    width: w,
    height: h,
    borderRadius: 6,
    position: "relative" as const,
    boxShadow:
      "0 1px 2px rgba(0,0,0,0.1), 0 6px 18px rgba(0,0,0,0.15), inset 1px 0 0 rgba(255,255,255,0.08), inset -1px 0 0 rgba(0,0,0,0.2)",
    overflow: "hidden" as const,
    flexShrink: 0,
  };

  if (showImage) {
    return (
      <div style={{ ...shellStyle, background: p1 }}>
        <img
          src={src!}
          alt={`${title} — cover`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
        {/* Thin spine shadow, kept for depth — covers don't paint it themselves. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            background:
              "linear-gradient(90deg, rgba(0,0,0,0.3) 0%, transparent 100%)",
            pointerEvents: "none",
          }}
        />
      </div>
    );
  }

  const pad =
    size === "lg" ? "18px 16px" : size === "sm" ? "10px 9px" : "14px 12px";
  const titleSize = size === "lg" ? 22 : size === "sm" ? 13 : 16;
  const authorSize = size === "lg" ? 10 : size === "sm" ? 8 : 9;

  return (
    <div
      style={{
        ...shellStyle,
        background: `linear-gradient(155deg, ${p1} 0%, ${p1} 55%, ${p2} 100%)`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: pad,
        fontFamily: FONT_SERIF_DISPLAY,
        color: p3,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          background:
            "linear-gradient(90deg, rgba(0,0,0,0.3) 0%, transparent 100%)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
        <div style={{ width: 14, height: 1, background: p3, opacity: 0.5 }} />
        <div
          style={{
            width: 3,
            height: 3,
            borderRadius: "50%",
            background: p3,
            opacity: 0.5,
          }}
        />
        <div style={{ width: 14, height: 1, background: p3, opacity: 0.5 }} />
      </div>
      <div style={{ marginLeft: 8, marginRight: 4, minWidth: 0 }}>
        <div
          style={{
            fontSize: titleSize,
            fontWeight: 500,
            fontStyle: "italic",
            lineHeight: 1.1,
            letterSpacing: "-0.01em",
            textWrap: "balance",
            display: "-webkit-box",
            WebkitLineClamp: size === "sm" ? 3 : 4,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: size === "lg" ? 10 : 6,
            fontSize: authorSize,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: FONT_STACKS.sans,
            fontWeight: 600,
            opacity: 0.7,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {author}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
        <div style={{ width: 14, height: 1, background: p3, opacity: 0.5 }} />
        <div
          style={{
            width: 3,
            height: 3,
            borderRadius: "50%",
            background: p3,
            opacity: 0.5,
          }}
        />
        <div style={{ width: 14, height: 1, background: p3, opacity: 0.5 }} />
      </div>
    </div>
  );
}
