export type ActivePanel =
  | null
  | "toc"
  | "highlights"
  | "settings"
  | "progress";

export interface Tweaks {
  theme: "light" | "sepia" | "dark" | "oled";
  fontFamily: "serif" | "sans" | "dyslexic" | "cairo" | "lateef" | "tajawal";
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  textAlign: "left" | "justify" | "right";
  rtl: boolean;
  columns: 1 | 2;
  /** Reading column width in px. Clamps the book body inside this width. */
  pageWidth: number;
}
