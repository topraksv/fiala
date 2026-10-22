// PLACEHOLDER. A plain geometric mark in the shape the brand kit's art takes, so the launch, the sign-in and the icons draw something before the app has a name. It is replaced, whole, by the Claude Design kit's output: regenerate from the kit, never by hand.

export const VIEW_BOX = "0 0 200 200";
export const ASPECT = 1;

/** The ring, filled; its hole is the opposite winding, so both fill rules leave it open. */
export const G = "M10 100A90 90 0 1 0 190 100A90 90 0 1 0 10 100ZM50 100A50 50 0 1 1 150 100A50 50 0 1 1 50 100Z";
/** The ring's centre line, which the intro traces under a widening mask. */
export const G_DRAW = "M100 30A70 70 0 0 1 100 170A70 70 0 0 1 100 30";
/** Wide enough that the stroke tracing the ring covers it. */
export const G_DRAW_WIDTH = 48;
export const G_DRAW_LENGTH = 440;

/** Slats clipped by the ring: light ones, then shaded ones between them. */
export const WEAVE_OUTLINE = 1.2;
export const WEAVE_LIGHT = "M0 10H200V22H0ZM0 50H200V62H0ZM0 90H200V102H0ZM0 130H200V142H0ZM0 170H200V182H0Z";
export const WEAVE_DARK = "M0 30H200V42H0ZM0 70H200V82H0ZM0 110H200V122H0ZM0 150H200V162H0ZM0 190H200V202H0Z";

export const LEAF = "M0-10L7 0L0 10L-7 0Z";
export const LEAF_TRANSFORM = "translate(100 100) scale(2)";
export const LEAF_PIVOT = [100, 100] as const;

/** A bar standing where the outlined name goes; the kit's wordmark replaces it once the app has a name. */
export const WORDMARK = "M0 0H1200V200H0Z";
export const WORDMARK_BOX = [0, 0, 1200, 200] as const;
/** The cap height in the same units: the kit sets the mark at 1.6 of it. */
export const WORDMARK_CAP = 200;
