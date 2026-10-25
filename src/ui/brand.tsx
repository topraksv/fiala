/**
 * The brand mark, the living staff: a thread wound round a staff that ends in
 * leaves, drawn as vectors so it is sharp at any size and can draw itself. The
 * staff is traced foot to top, the thread turn by turn under one mask over its
 * back and front parts, then the leaves open from their stems; once the intro
 * ends the masks are dropped, so the resting mark is the kit's exact drawing.
 * The staff and the name take the palette's strongest ink; the thread and the
 * middle leaf take the palette's accent, as Helix's and Gital's marks do, and
 * the side leaves keep the kit's sage. On Adaçayı, the default, that is the
 * kit's own drawing. `named` writes the name under it, left to
 * right, as a cold start shows it. Decoration: hidden from assistive
 * technology on a wrapper, since an SVG drops the props that would hide it.
 * Reduced motion draws it at rest. The art is a lazy chunk, Helix's, so the
 * first screen does not wait for it.
 */

import { useEffect, useId, useState } from "react";
import { Easing, View } from "react-native";
import Svg, { Defs, G, LinearGradient, Mask, Path, Rect, Stop } from "react-native-svg";

import type { Stroke } from "./brand-art";
import { useReducedMotion } from "./motion";
import { brandMark, PALETTES, useTheme } from "./theme";

/** The drawing's width over its height (`ASPECT` in `brand-art.ts`), known before its chunk arrives. */
export const MARK_ASPECT = 0.4223;

type Art = typeof import("./brand-art");
let art: Art | undefined;
let pending: Promise<Art> | undefined;

/** Settles once the drawing can be drawn. The launch screen waits on it, so
 *  its first frame after the native splash is the mark and never a blank box. */
export function preloadBrandMark(): Promise<Art> {
  return (pending ??= import("./brand-art").then((module) => (art = module)));
}

function useArt(): Art | undefined {
  const [, setArrived] = useState(art !== undefined);
  useEffect(() => {
    if (art) return;
    let live = true;
    void preloadBrandMark().then(() => live && setArrived(true));
    return () => {
      live = false;
    };
  }, []);
  return art;
}

const easeOut = Easing.bezier(0, 0, 0.58, 1);

/** The kit's timeline, from the first frame to the last leaf at rest; the name ends with it. */
const { staff, turns, leaves, wordAt } = brandMark;
const MARK_DRAW_MS = leaves.at + leaves.every * (3 - 1) + leaves.for; // the kit's three leaves

/**
 * Milliseconds into the intro, or null once it is over. React state rather
 * than an animated value: a mask's stroke is not a prop the native driver can
 * reach, and a second of re-renders on one small tree costs nothing.
 */
function useIntro(duration: number | undefined, ready: boolean): number | null {
  const reducedMotion = useReducedMotion();
  const [elapsed, setElapsed] = useState<number | null>(0);
  useEffect(() => {
    if (reducedMotion || !ready || duration === undefined) return;
    const start = Date.now();
    let frame = 0;
    const tick = () => {
      const now = Date.now() - start;
      if (now >= duration) return setElapsed(null);
      setElapsed(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion, duration, ready]);
  return reducedMotion || duration === undefined ? null : elapsed;
}

function DrawStroke({ stroke, drawn, cap }: { stroke: Stroke; drawn: number; cap: "butt" | "round" }) {
  return (
    <Path
      d={stroke.d}
      fill="none"
      stroke={brandMark.reveal}
      strokeWidth={stroke.width}
      strokeLinecap={cap}
      strokeLinejoin="round"
      strokeDasharray={[stroke.length, stroke.length]}
      strokeDashoffset={stroke.length * (1 - drawn)}
    />
  );
}

/**
 * The name as the kit's wordmark file sets it, turned from beside the mark to
 * under it with the lockup's gap: half the mark's width at the name's size.
 * It writes itself under a mask whose soft edge, the kit's 60 % of a cap,
 * travels with the pen; at rest there is no mask.
 */
const WORD_GAP = (1.6 * brandMark.wordCap * MARK_ASPECT) / 2;

function Name({ id, art: { WORDMARK, WORDMARK_BOX, WORDMARK_CAP }, ink, written }: { id: string; art: Art; ink: string; written: number | null }) {
  const [x, y, inkWidth, inkHeight] = WORDMARK_BOX;
  const scale = brandMark.wordCap / WORDMARK_CAP;
  const edge = WORDMARK_CAP * 0.6;
  const pen = x + (inkWidth + edge) * (written ?? 1);
  return (
    <Svg width={inkWidth * scale} height={inkHeight * scale} viewBox={`${x} ${y} ${inkWidth} ${inkHeight}`}>
      {written !== null && (
        <Defs>
          <LinearGradient id={`${id}p`} gradientUnits="userSpaceOnUse" x1={pen - edge} y1={0} x2={pen} y2={0}>
            <Stop offset={0} stopColor={brandMark.reveal} />
            <Stop offset={1} stopColor={brandMark.conceal} />
          </LinearGradient>
          <Mask id={`${id}w`}>
            <Rect x={x} y={y} width={pen - x} height={inkHeight} fill={`url(#${id}p)`} />
          </Mask>
        </Defs>
      )}
      <Path d={WORDMARK} fill={ink} mask={written === null ? undefined : `url(#${id}w)`} />
    </Svg>
  );
}

/** `duration` is the whole intro, the kit's timeline scaled evenly to fit.
 *  Omitted, the mark is drawn at rest: it draws itself on a cold start and nowhere else. */
export function BrandMark({ height, duration, named = false }: { height: number; duration?: number; named?: boolean }) {
  const { palette, paletteId } = useTheme();
  const drawing = useArt();
  const elapsed = useIntro(duration, drawing !== undefined);
  const pace = (duration ?? MARK_DRAW_MS) / MARK_DRAW_MS;
  // `useId` answers with colons, which a `url(#…)` reference cannot hold.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const progress = (start: number, length: number) => (elapsed === null ? 1 : easeOut(Math.min(1, Math.max(0, (elapsed - start * pace) / (length * pace)))));
  const ink = palette.textStrong;
  // The light primary on both schemes, as Gital's G: the dark one is a tint made for text on black.
  const accent = PALETTES[paletteId].light.primary;
  const width = Math.round(height * MARK_ASPECT);
  const hidden = { "aria-hidden": true, accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants", pointerEvents: "none" } as const;
  if (!drawing) return <View {...hidden} style={{ width, height }} />;
  const { LEAVES, STAFF, STAFF_DRAW, STRAND_BACK, STRAND_FRONT, TURN_DRAW, VIEW_BOX } = drawing;
  const tracing = elapsed !== null;
  const staffMask = tracing ? `url(#${id}s)` : undefined;
  const strandMask = tracing ? `url(#${id}t)` : undefined;
  return (
    <View {...hidden} style={{ width, height }}>
      <Svg width={width} height={height} viewBox={VIEW_BOX}>
        {tracing && (
          <Defs>
            <Mask id={`${id}s`}>
              <DrawStroke stroke={STAFF_DRAW} drawn={progress(staff.at, staff.for)} cap="butt" />
            </Mask>
            <Mask id={`${id}t`}>
              {TURN_DRAW.map((stroke, i) => <DrawStroke key={i} stroke={stroke} drawn={progress(turns.at + turns.every * i, turns.for)} cap="round" />)}
            </Mask>
          </Defs>
        )}
        <Path d={STRAND_BACK} fill={accent} mask={strandMask} />
        <Path d={STAFF} fill={ink} mask={staffMask} />
        <Path d={STRAND_FRONT} fill={accent} mask={strandMask} />
        {LEAVES.map((leaf, i) => {
          const open = progress(leaves.at + leaves.every * i, leaves.for);
          if (open === 0) return null;
          const [x, y] = leaf.pivot;
          return (
            <G key={i} transform={open === 1 ? undefined : `translate(${x} ${y}) rotate(${leaf.turn * leaves.turn * (1 - open)}) scale(${open}) translate(${-x} ${-y})`}>
              <Path d={leaf.d} fill={leaf.fill === "accent" ? accent : brandMark.sage} fillRule="evenodd" />
            </G>
          );
        })}
      </Svg>
      {/* Hung below the mark's box, so the mark keeps the place the native splash gave it. */}
      {named && (
        <View style={{ position: "absolute", top: height + WORD_GAP, left: (width - drawing.WORDMARK_BOX[2] * (brandMark.wordCap / drawing.WORDMARK_CAP)) / 2 }}>
          <Name id={id} art={drawing} ink={ink} written={tracing ? progress(wordAt, MARK_DRAW_MS - wordAt) : null} />
        </View>
      )}
    </View>
  );
}
