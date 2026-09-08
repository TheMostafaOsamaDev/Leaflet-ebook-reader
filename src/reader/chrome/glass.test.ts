import { describe, expect, it } from "vitest";
import { THEMES } from "../../styles/tokens";
import { GLASS_CLASS, glassBar } from "./glass";

describe("glassBar", () => {
  it("fills with the theme's translucent chrome, not the opaque one", () => {
    const bar = glassBar(THEMES.dark, "top");
    expect(bar.style.background).toBe(THEMES.dark.chromeGlass);
    expect(bar.style.background).not.toBe(THEMES.dark.chrome);
  });

  it("carries the blur class", () => {
    expect(glassBar(THEMES.dark, "top").className).toBe(GLASS_CLASS);
  });

  it("hands the opaque chrome to the no-backdrop-filter fallback", () => {
    // The @supports rule in global.css reads this variable. Without it the
    // fallback lands on `transparent` and the bar shows raw, unblurred text
    // through a 0.78 scrim — the one outcome that is actually unreadable.
    const bar = glassBar(THEMES.sepia, "bottom");
    expect(bar.style["--riwaq-chrome-opaque"]).toBe(THEMES.sepia.chrome);
  });

  it("puts the hairline on the edge facing the page", () => {
    // A frosted bar with no edge dissolves into the text it floats over, so
    // each bar gets a rule on its inward side only — and only that side, or
    // the two bars would draw a line along the outer screen edge too.
    const top = glassBar(THEMES.light, "top");
    expect(top.style.borderBottom).toBe(`0.5px solid ${THEMES.light.rule}`);
    expect(top.style.borderTop).toBeUndefined();

    const bottom = glassBar(THEMES.light, "bottom");
    expect(bottom.style.borderTop).toBe(
      `0.5px solid ${THEMES.light.ruleStrong}`,
    );
    expect(bottom.style.borderBottom).toBeUndefined();
  });

  it("gives every theme a glass fill", () => {
    // A theme missing `chromeGlass` would render a bar with no fill at all —
    // transparent over the text — rather than failing loudly.
    for (const [key, theme] of Object.entries(THEMES)) {
      expect(glassBar(theme, "top").style.background, key).toMatch(
        /^rgba\(/,
      );
    }
  });
});
