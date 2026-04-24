import type { ReactNode } from "react";
import type { Theme } from "../styles/tokens";

interface Props {
  theme: Theme;
  onClose: () => void;
  children: ReactNode;
  height?: string;
}

export function MobileSheet({
  theme,
  onClose,
  children,
  height = "78%",
}: Props) {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 20 }}>
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height,
          background: theme.chrome,
          color: theme.ink,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 -10px 40px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            paddingTop: 8,
            paddingBottom: 2,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: theme.rule,
            }}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
