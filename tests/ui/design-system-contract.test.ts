import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "../source-corpus";
import { PERSON_COLORS } from "../../src/db/schema";
import {
  composite,
  DEFAULT_PALETTE_ID,
  INTERACTION_ALPHA,
  PALETTES,
  motion,
  personColors,
  navigationInset,
  radius,
  resolvePaletteId,
  spacing,
  TAB_BAR,
  type,
  type Palette,
} from "../../src/ui/theme";

/** A `#RRGGBB` colour's channels as linear light, 0 to 1. */
function linear(hex: string): [number, number, number] {
  return (hex.match(/[0-9a-f]{2}/gi) ?? []).map((pair) => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

/** WCAG 2.2 relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

const schemes: [string, Palette][] = Object.entries(PALETTES).flatMap(([id, { light, dark }]) => [
  [`${id} light`, light],
  [`${id} dark`, dark],
]);

// Depth roles are rgba by nature; every other role is a flat colour a ratio can
// be computed from.
const DEPTH_ROLES = new Set(["shadow", "shadowStrong", "scrim"]);

// SC 1.4.3 for text, SC 1.4.11 for a control's edge or a focus ring.
const TEXT = 4.5;
const NON_TEXT = 3;

describe("the palette set", () => {
  it("ships Fiala's own Adaçayı first as the default, then the family's three", () => {
    expect(Object.keys(PALETTES)).toEqual(["sage", "clay", "ocean", "forest"]);
    expect(DEFAULT_PALETTE_ID).toBe("sage");
    expect(PALETTES.sage.light.primary).toBe("#3F6B62"); // the brand kit's accent
  });

  it("resolves an unknown or missing preference to the default", () => {
    for (const stored of ["sand", "violet", "", null]) expect(resolvePaletteId(stored)).toBe(DEFAULT_PALETTE_ID);
    for (const id of Object.keys(PALETTES)) expect(resolvePaletteId(id)).toBe(id);
  });

  // Amber is the family's default, so a person who chose it in Helix finds the same ramp here.
  it("keeps Amber's ramp exactly Helix's", () => {
    expect(PALETTES.clay.light).toMatchObject({
      background: "#F1EDE8", surface: "#FFFDFB", surfaceAlt: "#E7DFD7", surfaceStrong: "#C2B2A3",
      textStrong: "#2A211B", text: "#3A3028", textSecondary: "#62564C", textMuted: "#6D6157",
      primary: "#A55335", accentText: "#7B3A28", primaryStrong: "#88432D", primarySoft: "#EED8CC", border: "#8B796A",
    });
    expect(PALETTES.clay.dark).toMatchObject({
      background: "#090807", surface: "#191512", surfaceAlt: "#27211D", surfaceStrong: "#473D36",
      textStrong: "#F2ECE6", text: "#E5DDD6", textSecondary: "#BEB2A8", textMuted: "#9D9289",
      primary: "#D88967", accentText: "#E7A68B", primaryStrong: "#BE6B4A", primarySoft: "#3C2A22", border: "#807064",
    });
  });
});

describe.each(schemes)("%s", (_, p) => {
  const flat = Object.entries(p).filter(([role]) => !DEPTH_ROLES.has(role));

  it("writes every flat role as six-digit hex, so every ratio below is computable", () => {
    for (const [role, value] of flat) expect(value, role).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("holds no pure black or pure white", () => {
    for (const [role, value] of flat) expect(["#000000", "#FFFFFF"], role).not.toContain(value);
  });

  it.each([
    ["text", "background"],
    ["text", "surface"],
    ["textStrong", "surface"],
    ["textSecondary", "background"],
    ["textSecondary", "surface"],
    ["textSecondary", "surfaceAlt"],
    ["textMuted", "background"],
    ["textMuted", "surface"],
    ["accentText", "surface"],
    ["primaryText", "primarySoft"],
    // A list's tile: its initial on one of three soft tones.
    ["accentText", "primarySoft"],
    ["secondaryText", "secondarySoft"],
    ["tertiaryText", "tertiarySoft"],
    ["onPrimary", "primary"],
    ["onDestructive", "destructive"],
    ["successText", "surface"],
    ["errorText", "surface"],
    ["warningText", "surface"],
    // The mark in a ticked item's circle, and any text drawn on `secondary`
    // later.
    ["onSecondary", "secondary"],
  ] as const)("%s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(p[fg], p[bg])).toBeGreaterThanOrEqual(TEXT);
  });

  it.each([
    ["controlBorder", "background"],
    ["controlBorder", "surface"],
    ["controlBorder", "surfaceAlt"],
    ["focus", "surface"],
    ["focus", "surfaceAlt"],
    ["primary", "surface"],
    // A ticked item's circle: a graphic, not text.
    ["secondary", "surface"],
  ] as const)("%s on %s reaches 3:1", (fg, bg) => {
    expect(contrast(p[fg], p[bg])).toBeGreaterThanOrEqual(NON_TEXT);
  });

  // A card has to read as a card on its page: separation at every join, with
  // the dark floor lower because ratios compress among charcoals.
  it("keeps each surface layer distinguishable from the one under it", () => {
    const floor = luminance(p.background) < 0.05 ? 1.1 : 1.14;
    const ramp = [p.background, p.surface, p.surfaceAlt, p.surfaceStrong];
    for (let i = 1; i < ramp.length; i++) expect(contrast(ramp[i - 1]!, ramp[i]!)).toBeGreaterThanOrEqual(floor);
  });

  it("keeps status green green and error red in every family", () => {
    const [sr, sg, sb] = channels(p.success);
    expect(sg).toBeGreaterThan(Math.max(sr, sb));
    const [er, eg, eb] = channels(p.error);
    expect(er).toBeGreaterThan(Math.max(eg, eb));
  });

  // One alpha of the palette's own ink is what makes a hover the same size in
  // every theme; hand-picked tokens measured spreading 1.25–1.56:1.
  it("says hover quietly and pressed louder, on every surface a control sits on", () => {
    for (const under of [p.surface, p.surfaceAlt, p.primarySoft]) {
      const hovered = contrast(under, composite(under, p.textStrong, INTERACTION_ALPHA.hover));
      const held = contrast(under, composite(under, p.textStrong, INTERACTION_ALPHA.pressed));
      expect(hovered).toBeGreaterThan(1.05);
      expect(hovered).toBeLessThan(1.25);
      expect(held).toBeGreaterThan(hovered);
    }
  });
});

describe("a person's colour", () => {
  it("is drawn for every colour a person may be given, and its initial reads on it in every family", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(Object.keys(personColors[scheme]), scheme).toEqual([...PERSON_COLORS]);
      for (const [name, fill] of Object.entries(personColors[scheme])) {
        for (const family of Object.values(PALETTES)) expect(contrast(fill, family[scheme].surface), `${scheme} ${name}`).toBeGreaterThanOrEqual(TEXT);
      }
    }
  });
});

describe("scales", () => {
  it("spacing sits on the 4-point grid and only grows", () => {
    const steps = Object.values(spacing);
    for (const step of steps) expect(step % 4).toBe(0);
    expect(steps.every((v, i) => i === 0 || v > steps[i - 1]!)).toBe(true);
  });

  // And no role pins a line box: a constant lineHeight beside a
  // font size the OS scales is what clips Turkish descenders at large text.
  it("draws no text under 10 and pins no line height", () => {
    for (const [role, style] of Object.entries(type)) {
      expect(style.fontSize, role).toBeGreaterThanOrEqual(10);
      expect(style, role).not.toHaveProperty("lineHeight");
    }
  });

  // `docs/UI.md` section 5: a held control shrinks, and answers the finger
  // faster than a thing arriving on screen settles.
  it("shrinks a held control to 0.97 on a spring stiffer than an arrival", () => {
    expect(motion.press.scale).toBe(0.97);
    expect(motion.spring.press.stiffness).toBeGreaterThan(motion.spring.entrance.stiffness);
  });

  it("rounds nothing past the pill", () => {
    const corners = Object.values(radius);
    expect(corners.every((v, i) => i === 0 || v > corners[i - 1]!)).toBe(true);
  });
});

describe("the floating tab bar", () => {
  it("leaves room for itself, its gap and the home indicator under every scene", () => {
    expect(navigationInset({ bottomInset: 34, isWeb: false }).bottom).toBe(TAB_BAR.height + 34 + TAB_BAR.gap);
    // No indicator: the bar still floats its minimum gap off the edge.
    expect(navigationInset({ bottomInset: 0, isWeb: true }).bottom).toBe(TAB_BAR.webHeight + TAB_BAR.minBottomGap + TAB_BAR.gap);
  });
});

describe("theme.ts holds the only literals", () => {
  // `brand-art.ts` is generated from the brand kit: its widths are pen weights
  // in the drawing's own viewBox units, not sizes on a screen.
  const sources = sourceFiles("src", { atLeast: 60 }).filter((path) => path !== join("src", "ui", "theme.ts") && path !== join("src", "ui", "brand-art.ts"));

  // A pair of hex digits appended to a palette colour is an alpha channel; a
  // quoted pair alone is not, or every "01" and "20" in a parser would be one.
  const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\+\s*"[0-9a-f]{2}"|\}[0-9a-f]{2}`/i;
  // `\w*` before Width and Height, so a stroke or border weight is a size too.
  const RAW_SIZE =
    /\b(?:margin|padding|gap|top|bottom|left|right|\w*[wW]idth|\w*[hH]eight|size|fontSize|lineHeight|borderRadius|duration)\w*\s*[:=]\s*\{?-?(?:[1-9]|0\.\d)/;

  it.each([
    ["colour", COLOUR],
    ["raw size", RAW_SIZE],
  ])("no %s literal outside src/ui/theme.ts", (_, pattern) => {
    const offenders = sources.flatMap((path) =>
      readFileSync(join(process.cwd(), path), "utf8")
        .split("\n")
        .map((line, i) => (pattern.test(line) ? `${path}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the error screen", () => {
  it("catches every route under the root layout", () => {
    expect(readFileSync(join(process.cwd(), "src/app/_layout.tsx"), "utf8")).toMatch(/<ErrorBoundary[^>]*>\s*<Routes/);
  });
});
