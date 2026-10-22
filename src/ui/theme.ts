/**
 * The only file allowed to hold a literal colour, size or duration. Everything
 * else names one of these; `tests/ui/design-system-contract.test.ts` enforces
 * both the values and the monopoly.
 *
 * It imports React and never React Native, so the contract test runs in Node.
 */

import { createContext, useContext } from "react";


export interface Palette {
  background: string;
  surface: string;
  surfaceAlt: string;
  surfaceStrong: string;
  border: string;
  controlBorder: string;

  textStrong: string;
  text: string;
  textSecondary: string;
  textMuted: string;

  primary: string;
  primaryStrong: string;
  primarySoft: string;
  accentText: string;
  primaryText: string;
  onPrimary: string;

  secondary: string;
  secondaryStrong: string;
  secondarySoft: string;
  secondaryText: string;
  onSecondary: string;
  tertiary: string;
  tertiaryStrong: string;
  tertiarySoft: string;
  tertiaryText: string;
  onTertiary: string;

  shadow: string;
  shadowStrong: string;
  scrim: string;

  destructive: string;
  onDestructive: string;
  error: string;
  errorText: string;
  success: string;
  successText: string;
  warning: string;
  warningText: string;
  focus: string;
}

type SemanticPalette = Pick<Palette,
  | "destructive" | "onDestructive" | "error" | "errorText"
  | "success" | "successText" | "warning" | "warningText" | "focus"
>;

// Status keeps its meaning across themes: done stays green, an error stays red.
const lightSemanticColors = {
  destructive: "#A94F48",
  onDestructive: "#FBF4F1",
  error: "#A94F48",
  errorText: "#833832",
  success: "#4D775B",
  successText: "#365D43",
  warning: "#9A703A",
  warningText: "#745126",
  focus: "#3C6F96",
} satisfies SemanticPalette;

const darkSemanticColors = {
  destructive: "#D77C74",
  onDestructive: "#3A2726",
  error: "#D77C74",
  errorText: "#F0A49E",
  success: "#82A68A",
  successText: "#B0CFB5",
  warning: "#CFA667",
  warningText: "#E6C78F",
  focus: "#7EADD0",
} satisfies SemanticPalette;

// Amber — linen ground, terracotta, olive and aged brass.
const amberLight: Palette = {
  background: "#F1EDE8",
  surface: "#FFFDFB",
  surfaceAlt: "#E7DFD7",
  surfaceStrong: "#C2B2A3",
  border: "#8B796A",
  controlBorder: "#6D5B4D",
  textStrong: "#2A211B",
  text: "#3A3028",
  textSecondary: "#62564C",
  textMuted: "#6D6157",
  primary: "#A55335",
  primaryStrong: "#88432D",
  primarySoft: "#EED8CC",
  accentText: "#7B3A28",
  primaryText: "#2A211B",
  onPrimary: "#FBF4EF",
  secondary: "#6C7047",
  secondaryStrong: "#585C39",
  secondarySoft: "#E2E1C9",
  secondaryText: "#555937",
  onSecondary: "#FAF8F0",
  tertiary: "#91672F",
  tertiaryStrong: "#765226",
  tertiarySoft: "#EDDFC5",
  tertiaryText: "#775624",
  onTertiary: "#FBF7EE",
  shadow: "rgba(63, 45, 34, 0.08)",
  shadowStrong: "rgba(63, 45, 34, 0.20)",
  scrim: "rgba(39, 29, 23, 0.52)",
  ...lightSemanticColors,
};

const amberDark: Palette = {
  background: "#090807",
  surface: "#191512",
  surfaceAlt: "#27211D",
  surfaceStrong: "#473D36",
  border: "#807064",
  controlBorder: "#8F8176",
  textStrong: "#F2ECE6",
  text: "#E5DDD6",
  textSecondary: "#BEB2A8",
  textMuted: "#9D9289",
  primary: "#D88967",
  primaryStrong: "#BE6B4A",
  primarySoft: "#3C2A22",
  accentText: "#E7A68B",
  primaryText: "#F2ECE6",
  onPrimary: "#2C1D17",
  secondary: "#A3A774",
  secondaryStrong: "#898E5E",
  secondarySoft: "#3A3B2B",
  secondaryText: "#CED1A5",
  onSecondary: "#25261B",
  tertiary: "#CAA05F",
  tertiaryStrong: "#AD8549",
  tertiarySoft: "#443824",
  tertiaryText: "#E3C187",
  onTertiary: "#2D2416",
  shadow: "rgba(9, 7, 6, 0.30)",
  shadowStrong: "rgba(9, 7, 6, 0.50)",
  scrim: "rgba(10, 8, 7, 0.68)",
  ...darkSemanticColors,
};

// Petrol — mineral grey, petrol blue and a small coral counterweight.
const petrolLight: Palette = {
  background: "#ECEEEE",
  surface: "#FEFEFD",
  surfaceAlt: "#E6E9EA",
  surfaceStrong: "#C1C8CB",
  border: "#808B91",
  controlBorder: "#5E6B72",
  textStrong: "#20292E",
  text: "#2B353A",
  textSecondary: "#566268",
  textMuted: "#626D72",
  primary: "#315F78",
  primaryStrong: "#244C63",
  primarySoft: "#DCE8EE",
  accentText: "#284F65",
  primaryText: "#20292E",
  onPrimary: "#F7FAFB",
  secondary: "#5B7973",
  secondaryStrong: "#4E6C66",
  secondarySoft: "#DFE9E6",
  secondaryText: "#44645D",
  onSecondary: "#F6FAF8",
  tertiary: "#A8604C",
  tertiaryStrong: "#874937",
  tertiarySoft: "#F0E0DA",
  tertiaryText: "#7E4434",
  onTertiary: "#FFF9F6",
  shadow: "rgba(28, 37, 42, 0.06)",
  shadowStrong: "rgba(28, 37, 42, 0.18)",
  scrim: "rgba(24, 29, 32, 0.50)",
  ...lightSemanticColors,
};

const petrolDark: Palette = {
  background: "#0B0D0F",
  surface: "#15191C",
  surfaceAlt: "#20262A",
  surfaceStrong: "#3A444A",
  border: "#687882",
  controlBorder: "#89969D",
  textStrong: "#F1F3F3",
  text: "#E2E6E7",
  textSecondary: "#B8C0C4",
  textMuted: "#98A3A8",
  primary: "#7FAAC2",
  primaryStrong: "#628FA8",
  primarySoft: "#263842",
  accentText: "#AFCCE0",
  primaryText: "#F1F3F3",
  onPrimary: "#1B2A32",
  secondary: "#91B1A9",
  secondaryStrong: "#75978F",
  secondarySoft: "#2D3D39",
  secondaryText: "#C2D7D1",
  onSecondary: "#202C29",
  tertiary: "#D08C79",
  tertiaryStrong: "#B4715F",
  tertiarySoft: "#44312D",
  tertiaryText: "#EDB9AA",
  onTertiary: "#2D201D",
  shadow: "rgba(0, 0, 0, 0.30)",
  shadowStrong: "rgba(0, 0, 0, 0.52)",
  scrim: "rgba(4, 5, 6, 0.70)",
  ...darkSemanticColors,
};

// Servi — warm stone neutrals, deep cypress and a measured wild plum.
const serviLight: Palette = {
  background: "#ECEBE7",
  surface: "#FFFDF9",
  surfaceAlt: "#E8E6DF",
  surfaceStrong: "#C5C2B8",
  border: "#817E74",
  controlBorder: "#625F56",
  textStrong: "#292C29",
  text: "#343734",
  textSecondary: "#60645F",
  textMuted: "#60645F",
  primary: "#3D5D49",
  primaryStrong: "#2E4938",
  primarySoft: "#DFE7E1",
  accentText: "#35513F",
  primaryText: "#292C29",
  onPrimary: "#F4F7F1",
  secondary: "#987F4D",
  secondaryStrong: "#6E5A35",
  secondarySoft: "#ECE5D5",
  secondaryText: "#66532F",
  onSecondary: "#1A1A12",
  tertiary: "#885966",
  tertiaryStrong: "#704551",
  tertiarySoft: "#EADDE0",
  tertiaryText: "#69414C",
  onTertiary: "#F9F3F4",
  shadow: "rgba(39, 42, 39, 0.06)",
  shadowStrong: "rgba(39, 42, 39, 0.18)",
  scrim: "rgba(29, 31, 29, 0.50)",
  ...lightSemanticColors,
};

const serviDark: Palette = {
  background: "#0C0D0C",
  surface: "#171917",
  surfaceAlt: "#232623",
  surfaceStrong: "#414641",
  border: "#6F786F",
  controlBorder: "#8B938C",
  textStrong: "#F0F2ED",
  text: "#E2E7E1",
  textSecondary: "#BBC5BA",
  textMuted: "#9AA69A",
  primary: "#8FAB94",
  primaryStrong: "#739078",
  primarySoft: "#2B3830",
  accentText: "#BED1C0",
  primaryText: "#F0F2ED",
  onPrimary: "#263128",
  secondary: "#B1AA76",
  secondaryStrong: "#96905F",
  secondarySoft: "#403D2C",
  secondaryText: "#D9D4A6",
  onSecondary: "#29271B",
  tertiary: "#BE8E95",
  tertiaryStrong: "#A4747C",
  tertiarySoft: "#443335",
  tertiaryText: "#DFC0C4",
  onTertiary: "#2D2123",
  shadow: "rgba(0, 0, 0, 0.30)",
  shadowStrong: "rgba(0, 0, 0, 0.52)",
  scrim: "rgba(5, 6, 5, 0.70)",
  ...darkSemanticColors,
};

export type PaletteId = "clay" | "ocean" | "forest";

export const DEFAULT_PALETTE_ID: PaletteId = "clay";

export const PALETTES: Record<PaletteId, { light: Palette; dark: Palette }> = {
  clay: { light: amberLight, dark: amberDark },
  ocean: { light: petrolLight, dark: petrolDark },
  forest: { light: serviLight, dark: serviDark },
};

/** A stored preference that names no palette falls back rather than blanking the theme. */
export function resolvePaletteId(value: string | null): PaletteId {
  // `hasOwn`, not `in`: "constructor" is `in` every object.
  return value != null && Object.hasOwn(PALETTES, value) ? (value as PaletteId) : DEFAULT_PALETTE_ID;
}

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * Optical offsets under the grid: a caption tucked under its title, a hairline
 * rule. The 4-point grid spaces blocks; these place a line against its partner.
 */
export const offset = { hair: 1, tight: 2, tuck: 3 } as const;

/** How wide a screen's column may grow, named by what the screen holds. */
export const contentWidth = {
  focus: 560,
  form: 860,
  workspace: 1180,
  wide: 1560,
} as const;

export type ContentWidth = keyof typeof contentWidth;

export const radius = { sm: 8, md: 10, lg: 14, xl: 18, full: 999 } as const;

export function circle(size: number): number {
  return size / 2;
}

/**
 * `minimumTarget` is the 44-point floor every pressable box keeps, because the
 * web ignores `hitSlop`; `compact` is the chip painted inside it.
 */
export const controlSize = { compact: 36, minimumTarget: 44, regular: 48 } as const;

export const iconSize = { compact: 15, control: 17, headerBack: 24 } as const;

/** lucide's stroke, heavier than its default so a small mark holds its weight beside text. */
export const iconStroke = { regular: 2.2, mark: 2.5, quiet: 1.8 } as const;

export const density = {
  list: { sectionGap: spacing.lg, cardPadding: spacing.md, rowGap: spacing.sm },
} as const;

export const motion = {
  /** A pointer arriving on a control: slower than a press, so a passing pointer does not flicker. */
  hover: 170,
  /** Light to dark: the one moment the whole window changes, so it is the longest. */
  theme: 600,
  /** Held past a CSS fade before its layer unmounts, so the unmount cannot cut the last frame. */
  fadeTail: 50,
  /** A dragged-away bar leaving: quick, because the finger already said where it goes. */
  feedback: 120,
  /** A row making room or closing a gap. */
  standard: 220,
  /** How long the undo bar waits to be used before it leaves on its own. */
  undoHold: 6000,
  /** The same bar with nothing to take back. */
  noticeHold: 3600,
  /** A figure counting to its value. */
  figure: 900,
  /** A pulse fading off a row that changed. */
  settle: 420,
  /** The ease-out every web CSS transition uses. */
  webEase: "cubic-bezier(0.22, 1, 0.36, 1)",
  spring: {
    entrance: { damping: 18, stiffness: 170, mass: 1 },
    /** Stiffer than an arrival: a held control answers the finger at once. */
    press: { damping: 20, stiffness: 420, mass: 1 },
  },
  /** How small a held control gets, `docs/UI.md` section 5. */
  press: { scale: 0.97 },
  /**
   * How far a thing travels as it arrives. A block rising into empty space
   * lifts a little; the undo bar comes up off the edge near where it lands; a
   * phone-width sheet is pulled up off the screen's edge and needs the longer
   * travel to read as one.
   */
  travel: { rise: 10, bar: 24, sheet: 40 },
  /** A row flying to another tab shrinks to `shrink` on the way; the tab's icon lands at `bounce` and springs home. */
  landing: { shrink: 0.2, bounce: 1.3 },
  /** A wait shows nothing before this, so a quick one never flashes (`docs/UI.md` §7). */
  reveal: 350,
  /** An account operation's medallion breathing in and out. */
  operation: { breath: 1100 },
  /** The skeleton: a slow, shallow pulse. */
  skeleton: { pulse: 1200, opacity: [1, 0.55] as const, lines: ["60%", "40%"] as const },
} as const;

/**
 * One alpha of the palette's own ink over whatever a control sits on, so a
 * hover is the same size in every theme. It and `composite` live here rather
 * than in `interaction.ts` because the contract test measures what they paint
 * and cannot import React Native.
 */
export const INTERACTION_ALPHA = { hover: 0.06, pressed: 0.11 } as const;

/** `alpha` of `tint` over an opaque `base`, both `#RRGGBB`. */
export function composite(base: string, tint: string, alpha: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5]
    .map((at) => Math.round(channel(base, at) * (1 - alpha) + channel(tint, at) * alpha))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 1.4.4's 200%, applied only where a box cannot grow with its text. */
export const maxFontScale = { measuredBox: 2 } as const;

/**
 * `selected` is a chosen tile's ring: constant weight, so choosing never
 * re-wraps the row. `outline` edges the appearance card's miniatures.
 */
export const borderWidth = { outline: 1, control: 1.5, selected: 2 } as const;

/** Alpha channels appended to a palette hex, so a softened edge or tint is written once. */
export const alpha = { edge: "70", tileEdge: "80", controlEdge: "90", selectedTint: "14", inverseTint: "18", doneEdge: "66", noticeTint: "16" } as const;

export const stateOpacity = { pressed: 0.85 } as const;

/** Every face here is loaded in `src/app/_layout.tsx`; an unused one is ~175 KB of TTF. */
export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  serif: "IBMPlexSerif_600SemiBold",
} as const;

// Static faces carry one weight each, so a role sets fontFamily and never
// fontWeight, which iOS would synthesise into a second face.
export const type = {
  /** The greeting size: the sign-in's welcome on a wide window. */
  display: { fontSize: 40, fontFamily: font.serif, letterSpacing: -0.8 },
  title: { fontSize: 26, fontFamily: font.serif, letterSpacing: -0.2 },
  heading: { fontSize: 18, fontFamily: font.semibold, letterSpacing: -0.2 },
  /** A field's name above it. */
  label: { fontSize: 13, fontFamily: font.medium },
  sectionTitle: { fontSize: 16, fontFamily: font.semibold, letterSpacing: -0.2 },
  field: { fontSize: 16, fontFamily: font.regular },
  body: { fontSize: 15, fontFamily: font.regular },
  button: { fontSize: 15, fontFamily: font.medium },
  buttonCompact: { fontSize: 13, fontFamily: font.medium },
  small: { fontSize: 12, fontFamily: font.regular },
  caption: { fontSize: 11, fontFamily: font.regular },
  /** The calculator: a key's glyph, sized to the pad rather than to prose, and the display's figure. */
  keypad: { fontSize: 22, fontFamily: font.medium },
  amount: { fontSize: 34, fontFamily: font.semibold, fontVariant: ["tabular-nums"] as "tabular-nums"[] },
} as const;

/** Prose leading, applied on web only: RN Web's `font` shorthand resets it to ~1.21. */
export const proseLeading = 1.5;

export const themeShadow = {
  card: (palette: Palette) => ({ boxShadow: `0 8px 24px ${palette.shadow}` } as const),
  overlay: (palette: Palette) => ({ boxShadow: `0 16px 40px ${palette.shadowStrong}` } as const),
  /** The switch's thumb: it reads as a lens on the track rather than a flat dot. */
  toggleThumb: (palette: Palette) => ({ boxShadow: `0 1px 3px ${palette.shadowStrong}` } as const),
} as const;

/** The floating tab bar, measured from `tab-bar.tsx`. */
export const TAB_BAR = {
  height: 56,
  /** Taller on web so ç and ğ are not clipped. */
  webHeight: 60,
  minBottomGap: 10,
  sideInset: 12,
  gap: 10,
  maxWidth: 560,
  /** The bar's outline; the columns share what is inside it. */
  border: 1,
  /** The bar's own inset; the selection slides inside it. */
  padding: 2,
  icon: 20,
  iconBox: { width: 30, height: 28 },
  labelGap: 1,
  /** The glass highlight along the top edge, fainter when the bar is opaque. */
  highlight: { top: 1, inset: 18, thickness: 1, glassAlpha: "18", solidAlpha: "0D" },
  /** The travelling selection's outline, heavier along its bottom edge. */
  selection: { border: 1, bottomEdge: 2 },
} as const;

export function tabBarHeight(isWeb: boolean): number {
  return isWeb ? TAB_BAR.webHeight : TAB_BAR.height;
}

/** How far the bar's bottom edge sits above the screen's: over the home indicator, never around it. */
export function tabBarBottomOffset(bottomInset: number): number {
  return Math.max(bottomInset, TAB_BAR.minBottomGap);
}

/** Space a tab scene leaves under its content; the bar floats over the scene. */
export function navigationInset({ bottomInset, isWeb }: { bottomInset: number; isWeb: boolean }): { bottom: number } {
  return { bottom: tabBarHeight(isWeb) + tabBarBottomOffset(bottomInset) + TAB_BAR.gap };
}

/**
 * The bar is a veil over the page, not a lid. Web can be thinner because a
 * real backdrop blur removes the detail behind an 11px label; native has no
 * blur in Expo Go and keeps a denser fill.
 */
export const NAV_GLASS = {
  webAlpha: "70",
  mobileWebAlpha: "80",
  nativeAlpha: "C0",
  blur: "blur(30px) saturate(180%)",
} as const;

export function navigationMaterial(surface: string, { glass, isWeb, compact = false }: { glass: boolean; isWeb: boolean; compact?: boolean }): string {
  if (!glass) return surface;
  return surface + (isWeb ? compact ? NAV_GLASS.mobileWebAlpha : NAV_GLASS.webAlpha : NAV_GLASS.nativeAlpha);
}

export const sectionMark = { width: 3, height: 18, radius: 2 } as const;

/** The switch, drawn the same on every platform, so its geometry is one contract. */
export const toggleSize = { width: 46, height: 28, padding: 3, glyph: 11, glyphInset: 7 } as const;

/**
 * The mark drawing itself (`src/ui/brand.tsx`), on the brand kit's timeline:
 * the G is traced, then its leaf opens from the stem, swinging in by `leafTurn`
 * degrees. Milliseconds from the first frame.
 */
export const brandMark = {
  draw: 900,
  leafAt: 900,
  leaf: 220,
  leafTurn: 8,
  /**
   * A cold start's name under the mark (owner, 2026-10-02): it starts writing
   * as the G is half drawn and finishes with the leaf. Its cap height is the
   * kit's wordmark files' own, not the lockup's 1.6 scaled to the splash mark,
   * which would make the name twice as wide as the mark it sits under.
   */
  wordAt: 450,
  word: 670,
  wordCap: 44,
  /**
   * A cold start's mark: the same timeline stretched to `draw`, the finished
   * mark held for `rest`, then a fade. At the kit's own 1120 ms and a 120 ms
   * fade it was gone before it was seen (owner, 2026-10-02).
   */
  launch: { draw: 2000, rest: 300, fade: 400 },
  /** The kit's own inks; only the G follows the palette. */
  weave: "#C98D4C",
  weaveShade: "#B87C40",
  leafInk: "#8B9583",
  /** What a mask shows through, and what it hides: luminance, never opacity, which a native mask may not read. */
  reveal: "#FFFFFF",
  conceal: "#000000",
} as const;

/** The waiting page for an account operation: a halo breathing round a medallion. */
export const operationWait = {
  halo: 128,
  medallion: 96,
  icon: 34,
  maxWidth: 440,
  haloOpacity: [0.35, 0.9],
  haloScale: [0.82, 1],
  haloTint: "12",
  medallionTint: "1A",
  medallionEdge: "3A",
} as const;

/** A screenshot on a report (SPEC 4.1): enough to tell one from another. `edge` is what is sent, where print must read. */
export const screenshot = { thumb: 84, edge: 1600 } as const;

export const emptyState = { disc: 56, icon: 26 } as const;

/**
 * The dialog. `keyboardGap` is the air kept between the caret and a
 * native keyboard, capped at a share of the window so a short phone keeps
 * the sheet on screen.
 */
export const dialog = {
  maxWidth: 400,
  /** A multi-line prompt's field: six lines show, the rest scroll inside it. */
  multilineHeight: 160,
  handle: { width: 36, height: 4 },
  /** How far a sheet's held header overlaps its body: two surfaces meeting on a fractional pixel left a hairline of scrim between them. */
  seam: 1,
  /** How far a sheet is pulled down by its handle before it lets go and closes. */
  dragAway: 96,
  keyboardGap: 140,
  keyboardGapShare: 0.22,
} as const;

/** The notice sheet and consent box (`src/ui/legal-notice.tsx`). */
export const legalNotice = {
  maxWidth: 560,
  /** The text scrolls inside a bounded surface, so the close control never leaves a phone's screen. */
  sheetHeightShare: 0.88,
  boxHeightShare: 0.86,
  marker: 18,
  box: 20,
  acceptBox: 22,
  boxIcon: 14,
  boxStroke: 3,
  closeIcon: 20,
  chevron: 16,
} as const;

/** The sign-in greeting and its three-step picture, measured on `(auth)/sign-in.tsx`. */
export const authHero = {
  mark: 40,
  markWide: 48,
  titleLine: 33,
  titleLineWide: 45,
  /** The phone's title: the section title grown by 1.3. */
  titleScale: 1.3,
  bodyMaxWidth: 470,
  bodyLine: 22,
  noteIcon: 14,
  /** The reset page's round mark over its heading, and the glyph in it. */
  resultMark: 56,
  resultIcon: 28,
} as const;

export const undoBar = { mark: 26, markIcon: 15, actionIcon: 14 } as const;

/** The appearance card: each tile is drawn in the scheme or palette it chooses. */
export const appearanceTile = {
  theme: { minHeight: 82, swatch: { width: 58, height: 34 }, icon: 16 },
  palette: {
    minHeight: 92,
    wideMinHeight: 150,
    swatch: { width: 92, height: 68, wideHeight: 78 },
    /** Room the mock card leaves on its right for the primary dot. */
    cardRight: 32,
    wideCardRight: 42,
    lineGap: 5,
    lines: [
      { width: "62%", height: 5, radius: 3 },
      { width: "84%", height: 3, radius: 2 },
      { width: "70%", height: 3, radius: 2 },
    ],
    dot: 24,
    pip: 7,
    pipGap: 3,
    check: 18,
    checkIcon: 12,
    checkStroke: 3,
  },
} as const;

export type ThemePreference = "system" | "light" | "dark";

/**
 * Device-local: read before the first frame, by the web shell
 * (`src/app/+html.tsx`) and by the root layout, so the wrong ground never shows.
 */
export const APPEARANCE_KEYS = { theme: "fiala.theme", palette: "fiala.palette" } as const;

interface Theme {
  palette: Palette;
  scheme: "light" | "dark";
  paletteId: PaletteId;
  /** What the person chose; `scheme` is what it resolved to. */
  preference: ThemePreference;
}

export const ThemeContext = createContext<Theme>({
  palette: PALETTES[DEFAULT_PALETTE_ID].light,
  scheme: "light",
  paletteId: DEFAULT_PALETTE_ID,
  preference: "system",
});

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
