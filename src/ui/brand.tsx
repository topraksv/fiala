/**
 * The brand mark, drawn as vectors so it is sharp at any size and can draw
 * itself: the timeline traces the ring under a widening mask, then opens the
 * leaf from its stem. Once the intro ends the mask is dropped, so the resting
 * mark is the art's exact drawing. The ring takes the palette's accent.
 * `named` writes the name under it, left to right, as a cold start shows it.
 * Decoration: hidden from assistive technology on a wrapper, since an SVG
 * drops the props that would hide it. Reduced motion draws it at rest.
 * The art is a placeholder (`brand-art.ts`) until the app has a name.
 */

import { useEffect, useId, useState } from "react";
import { Easing, View } from "react-native";
import Svg, { ClipPath, Defs, G, LinearGradient, Mask, Path, Rect, Stop } from "react-native-svg";

import {
  ASPECT,
  G as G_SHAPE,
  G_DRAW,
  G_DRAW_LENGTH,
  G_DRAW_WIDTH,
  LEAF,
  LEAF_PIVOT,
  LEAF_TRANSFORM,
  VIEW_BOX,
  WEAVE_DARK,
  WEAVE_LIGHT,
  WEAVE_OUTLINE,
  WORDMARK,
  WORDMARK_BOX,
  WORDMARK_CAP,
} from "./brand-art";
import { useReducedMotion } from "./motion";
import { brandMark, PALETTES, useTheme } from "./theme";

const easeOut = Easing.bezier(0, 0, 0.58, 1);

/** The kit's timeline, from the first frame to the leaf at rest. */
const MARK_DRAW_MS = brandMark.leafAt + brandMark.leaf;

/**
 * Milliseconds into the intro, or null once it is over. React state rather
 * than an animated value: a mask's stroke is not a prop the native driver can
 * reach, and a second of re-renders on one small tree costs nothing.
 */
function useIntro(duration: number | undefined): number | null {
  const reducedMotion = useReducedMotion();
  const [elapsed, setElapsed] = useState<number | null>(0);
  useEffect(() => {
    if (reducedMotion || duration === undefined) return;
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
  }, [reducedMotion, duration]);
  return reducedMotion || duration === undefined ? null : elapsed;
}

/**
 * The name as the kit's wordmark files set it, turned from beside the mark to
 * under it with the lockup's gap: half the mark's width at the name's size.
 * It writes itself under a mask whose soft edge, half a cap high, travels with
 * the pen; at rest there is no mask.
 */
const WORD_SCALE = brandMark.wordCap / WORDMARK_CAP;
const WORD_GAP = (1.6 * brandMark.wordCap * ASPECT) / 2;
const PEN_EDGE = WORDMARK_CAP / 2;

function Name({ id, ink, written }: { id: string; ink: string; written: number | null }) {
  const [x, y, inkWidth, inkHeight] = WORDMARK_BOX;
  const pen = x + (inkWidth + PEN_EDGE) * (written ?? 1);
  return (
    <Svg width={inkWidth * WORD_SCALE} height={inkHeight * WORD_SCALE} viewBox={`${x} ${y} ${inkWidth} ${inkHeight}`}>
      {written !== null && (
        <Defs>
          <LinearGradient id={`${id}p`} gradientUnits="userSpaceOnUse" x1={pen - PEN_EDGE} y1={0} x2={pen} y2={0}>
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
  const elapsed = useIntro(duration);
  const pace = (duration ?? MARK_DRAW_MS) / MARK_DRAW_MS;
  // `useId` answers with colons, which a `url(#…)` reference cannot hold.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const progress = (start: number, length: number) => (elapsed === null ? 1 : easeOut(Math.min(1, Math.max(0, (elapsed - start * pace) / (length * pace)))));
  const drawn = progress(0, brandMark.draw);
  const leaf = progress(brandMark.leafAt, brandMark.leaf);
  const written = elapsed === null ? null : progress(brandMark.wordAt, brandMark.word);
  const [x, y] = LEAF_PIVOT;
  const width = Math.round(height * ASPECT);
  return (
    <View aria-hidden accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ width, height }}>
      <Svg width={width} height={height} viewBox={VIEW_BOX}>
        <Defs>
          <ClipPath id={`${id}c`}>
            <Path d={G_SHAPE} />
          </ClipPath>
          {elapsed !== null && (
            <Mask id={`${id}m`}>
              <Path
                d={G_DRAW}
                fill="none"
                stroke={brandMark.reveal}
                strokeWidth={G_DRAW_WIDTH}
                strokeLinejoin="round"
                strokeDasharray={[G_DRAW_LENGTH, G_DRAW_LENGTH]}
                strokeDashoffset={G_DRAW_LENGTH * (1 - drawn)}
              />
            </Mask>
          )}
        </Defs>
        <G mask={elapsed === null ? undefined : `url(#${id}m)`}>
          <Path d={G_SHAPE} fill={PALETTES[paletteId].light.primary} fillRule="evenodd" />
          <G clipPath={`url(#${id}c)`}>
            <Path d={WEAVE_LIGHT} fill={brandMark.weave} stroke={brandMark.weave} strokeWidth={WEAVE_OUTLINE} strokeLinejoin="round" />
            <Path d={WEAVE_DARK} fill={brandMark.weaveShade} stroke={brandMark.weaveShade} strokeWidth={WEAVE_OUTLINE} strokeLinejoin="round" />
          </G>
        </G>
        {leaf > 0 && (
          <G transform={`translate(${x} ${y}) rotate(${-brandMark.leafTurn * (1 - leaf)}) scale(${leaf}) translate(${-x} ${-y})`}>
            <Path d={LEAF} fill={brandMark.leafInk} fillRule="evenodd" transform={LEAF_TRANSFORM} />
          </G>
        )}
      </Svg>
      {/* Hung below the mark's box, so the mark keeps the place the native splash gave it. */}
      {named && (
        <View style={{ position: "absolute", top: height + WORD_GAP, left: (width - WORDMARK_BOX[2] * WORD_SCALE) / 2 }}>
          <Name id={id} ink={palette.textStrong} written={written} />
        </View>
      )}
    </View>
  );
}
