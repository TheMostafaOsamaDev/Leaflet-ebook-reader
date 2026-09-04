// Stroke-based minimal icon set. Ported from reader-core.jsx `ICONS`.

import type { CSSProperties } from "react";

export interface IconProps {
  name: keyof typeof ICONS;
  size?: number;
  stroke?: number;
  fill?: string;
  style?: CSSProperties;
  className?: string;
}

export const ICONS = {
  menu: "M3 6h18M3 12h18M3 18h18",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  // Text-alignment icons. Physical (left = lines flush left), so they read
  // correctly in both LTR and RTL — do NOT add `rtl-flip-x` to these.
  alignLeft: "M21 6H3M15 12H3M17 18H3",
  alignCenter: "M21 6H3M17 12H7M19 18H5",
  alignRight: "M21 6H3M21 12H9M21 18H7",
  alignJustify: "M3 6h18M3 12h18M3 18h18",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  book: "M12 6.5C10.5 5 7.5 4.5 4 5v13c3.5-.5 6.5 0 8 1.5 1.5-1.5 4.5-2 8-1.5V5c-3.5-.5-6.5 0-8 1.5zM12 6.5V20",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 12l10 5 10-5M2 17l10 5 10-5",
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
  /** Expand-all / collapse-all pair for accordion groups. */
  chevronsD: "M7 7l5 5 5-5M7 13l5 5 5-5",
  chevronsU: "M7 11l5-5 5 5M7 17l5-5 5 5",
  /** Focus mode — corners pulling outward, the usual "fill the frame" mark. */
  focus: "M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M3 16v3a2 2 0 002 2h3",
  /** Crosshair — "take me to where I am". */
  locate: "M2 12h3M19 12h3M12 2v3M12 19v3M12 19a7 7 0 100-14 7 7 0 000 14z",
  type: "M4 7V5h16v2M9 20h6M12 5v15",
  // Solid-fillable triangle — pass fill="currentColor" for the hero's primary
  // Read action; renders as an outline under the set's default fill="none".
  play: "M8 5v14l11-7z",
  // Box with an arrow leaving it — marks a link that opens an external site
  // (the source-badge chip + the Library cards' source marker).
  externalLink:
    "M15 3h6v6M10 14L21 3M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  moon: "M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z",
  sun: "M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41M12 7a5 5 0 100 10 5 5 0 000-10z",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
  image:
    "M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21",
  pencil: "M4 20l4-1 11-11-3-3L5 16l-1 4z",
  info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 7v7M12 17h.01",
  doc: "M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M9 13h6M9 17h6",
  slider: "M3 12h6M15 12h6M10 12a2 2 0 1 0 4 0 2 2 0 1 0 -4 0",
  trash: "M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6",
  more: "M12 5h.01M12 12h.01M12 19h.01",
  bookmark: "M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z",
  globe:
    "M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
} as const;

export function Icon({
  name,
  size = 18,
  stroke = 1.5,
  fill = "none",
  style,
  className,
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
      className={className}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
