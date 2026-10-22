/**
 * The web focus ring, drawn by the app: `:focus-visible` so a tap draws none, and a negative offset
 * so a card that hides its overflow cannot clip it. The live palette's colour crosses as a custom property.
 */

export const FOCUS_PROPERTY = "--fiala-focus";

// Each focusable is named, which outranks react-native-web's `outline` reset. Under `body`, not
// `#root`: a sheet is a Modal rendered beside `#root`.
const TARGETS = ["[tabindex]", "[role=button]", "[role=checkbox]", "[role=switch]", "[role=radio]", "[role=tab]", "[role=slider]", "a", "input", "textarea"];

/** On a control whose hit area is a larger invisible square: the ring goes round this box instead. Web-only (`data-focus-box`). */
export const FOCUS_BOX = { dataSet: { focusBox: "true" } } as object;

export function focusRingCss(fallback: string): string {
  const ring = `outline:2px solid var(${FOCUS_PROPERTY},${fallback})`;
  const selector = TARGETS.map((target) => `body ${target}:focus-visible`).join(",");
  // After the rule above and as specific, so they win: a hit area with a box
  // rings the box, and a sheet's title, focused for a screen reader, is no control.
  return (
    `${selector}{${ring};outline-offset:-2px;}` +
    `body :focus-visible:has(> [data-focus-box]){outline:none;}` +
    `body :focus-visible > [data-focus-box]{${ring};outline-offset:2px;}` +
    `body [role=heading]:focus-visible{outline:none;}`
  );
}
