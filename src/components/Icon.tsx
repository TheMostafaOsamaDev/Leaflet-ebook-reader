// Stroke-based minimal icon set. Ported from reader-core.jsx `ICONS`.

import type { CSSProperties } from "react";

export interface IconProps {
  name: keyof typeof ICONS;
  size?: number;
  stroke?: number;
  fill?: string;
  style?: CSSProperties;
}

export const ICONS = {
  menu: "M3 6h18M3 12h18M3 18h18",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  bookmark: "M6 3h12v18l-6-4.5L6 21V3z",
  highlight: "M4 19h16M5 15l5-5 7 7-5 5H5v-7zM13 5l5 5",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  arrowL: "M15 18l-6-6 6-6",
  arrowR: "M9 18l6-6-6-6",
  close: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  cloudOk: "M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10zM9 14l2 2 4-4",
  clock: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2",
  home: "M3 12l9-9 9 9M5 10v10h14V10",
  plus: "M12 5v14M5 12h14",
  chevronR: "M9 18l6-6-6-6",
  chevronD: "M6 9l6 6 6-6",
  type: "M4 7V5h16v2M9 20h6M12 5v15",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  moon: "M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z",
  sun: "M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41M12 7a5 5 0 100 10 5 5 0 000-10z",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
  pencil: "M4 20l4-1 11-11-3-3L5 16l-1 4z",
  info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 7v7M12 17h.01",
} as const;

export function Icon({
  name,
  size = 18,
  stroke = 1.5,
  fill = "none",
  style,
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
