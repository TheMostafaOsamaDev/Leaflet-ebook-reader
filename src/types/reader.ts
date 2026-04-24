export type ActivePanel =
  | null
  | "toc"
  | "bookmarks"
  | "highlights"
  | "settings"
  | "progress";

export interface Tweaks {
  theme: "light" | "sepia" | "dark" | "oled";
  fontFamily: "serif" | "sans" | "dyslexic";
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  textAlign: "left" | "justify" | "right";
  rtl: boolean;
}
