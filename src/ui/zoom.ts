/**
 * The arithmetic of a zoomed photo, apart from the gesture that drives it so
 * a test can hold it. `worklet` so the viewer's gesture callbacks, which run
 * on the UI thread, can call it.
 */

export function clampScale(scale: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, scale));
}

/** How far a photo `shown` across at 1x may move from centre at `scale` in a `window` that wide: until its edge meets the window's, measured by the photo, not the window. */
export function clampPan(offset: number, shown: number, window: number, scale: number): number {
  "worklet";
  const reach = Math.max(0, shown * scale - window) / 2;
  return Math.min(reach, Math.max(-reach, offset));
}
