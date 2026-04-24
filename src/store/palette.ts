// Palette derivation — generates a warm 3-color book-cover palette from a
// book id so imported EPUBs get a consistent, distinct cover without
// needing an extracted cover image. Same id → same palette across
// sessions.

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Anchor hues we like — rotating through them keeps covers warm and in
// the sepia/amber/burgundy/ink family rather than landing on bright neon.
const HUE_ANCHORS = [28, 12, 200, 150, 260, 340, 90, 45];

function oklchToHex(L: number, C: number, h: number): string {
  // Approximate OKLCH → sRGB (D65). Good enough for book-cover swatches.
  const a = Math.cos((h * Math.PI) / 180) * C;
  const b = Math.sin((h * Math.PI) / 180) * C;

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const gamma = (u: number) =>
    u <= 0.0031308
      ? 12.92 * u
      : 1.055 * Math.pow(Math.max(0, u), 1 / 2.4) - 0.055;

  const to8 = (u: number) =>
    Math.max(0, Math.min(255, Math.round(gamma(u) * 255)));

  return (
    "#" +
    to8(r).toString(16).padStart(2, "0") +
    to8(g).toString(16).padStart(2, "0") +
    to8(bl).toString(16).padStart(2, "0")
  );
}

export function paletteForId(
  id: string,
): readonly [string, string, string] {
  const h = hash32(id);
  const hue = HUE_ANCHORS[h % HUE_ANCHORS.length] + ((h >> 8) % 20) - 10;
  const deep = oklchToHex(0.22, 0.05, hue);
  const mid = oklchToHex(0.6, 0.08, hue);
  const light = oklchToHex(0.82, 0.04, hue);
  return [deep, mid, light] as const;
}
