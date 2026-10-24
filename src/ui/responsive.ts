/**
 * Every width that changes a layout mode, named for what the width buys.
 */

/**
 * The one desktop threshold. A tablet in portrait is on the desktop side:
 * navigation never changes here — one bottom bar at every width.
 */
const DESKTOP_WIDTH = 768;

export function shouldUseWideGutter(viewportWidth: number): boolean {
  return viewportWidth >= DESKTOP_WIDTH;
}

/** Below this a pair of explained tiles stops fitting side by side. */
const PAIRED_TILE_WIDTH = 640;

export function shouldPairTiles(contentWidth: number): boolean {
  return contentWidth >= PAIRED_TILE_WIDTH;
}

/** A narrow browser has no room for the blur to hide much, so the veil stays denser. */
const COMPACT_NAV_MATERIAL_WIDTH = 600;

export function shouldUseCompactNavigationMaterial(viewportWidth: number): boolean {
  return viewportWidth < COMPACT_NAV_MATERIAL_WIDTH;
}

/**
 * Air a tab label keeps from its neighbours. 6 is the boundary
 * between "tight but separate" at 360px and "one run of text" at 320px.
 */
const LABEL_BREATHING = 6;

/** A width the column provably cannot hold, for a label that wrapped. */
export function tooWide(slotWidth: number): number {
  return slotWidth + LABEL_BREATHING + 1;
}

/** Zero means "not measured yet" and reads as fits: a label must render once to be measured. */
export function tabLabelsFit(labelWidth: number, slotWidth: number): boolean {
  if (labelWidth <= 0 || slotWidth <= 0) return true;
  return labelWidth <= slotWidth - LABEL_BREATHING;
}

/** Whether a browser's visual viewport can be shrunk by a software keyboard. */
export function isMobileViewportWidth(viewportWidth: number): boolean {
  return viewportWidth < DESKTOP_WIDTH;
}

/**
 * The same line the dialog asks about: a phone gets a sheet from the bottom
 * edge its thumb reaches, a pointer gets a centred box.
 */
const SHEET_WIDTH = 640;

export function shouldPresentOptionsAsSheet(viewportWidth: number): boolean {
  return viewportWidth < SHEET_WIDTH;
}

/** Where the sign-in's greeting and its form stand side by side. */
const SPLIT_AUTH_HERO_WIDTH = 820;

export function shouldSplitAuthHero(viewportWidth: number): boolean {
  return viewportWidth >= SPLIT_AUTH_HERO_WIDTH;
}

/**
 * The narrowest a tile holding one short word stands at system text size 1,
 * its padding and gap included; a weekday's three letters need less.
 */
export const TILE_WIDTH = 92;
export const WEEKDAY_TILE_WIDTH = 40;

/**
 * How many of `wanted` tiles fit a row once the system text size applies:
 * a larger text size takes columns, never letters (`docs/UI.md` section 10).
 */
export function tileColumns(contentWidth: number, fontScale: number, wanted: number, tileWidth = TILE_WIDTH): number {
  return Math.max(1, Math.min(wanted, Math.floor(contentWidth / Math.max(1, fontScale) / tileWidth)));
}
