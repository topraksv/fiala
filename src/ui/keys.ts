/**
 * The keys react-native-web leaves out: Space on a checkbox or switch, the arrows on an `adjustable`
 * view. React Native types no key handler, so it is spread in as a web-only prop.
 */

type Key = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; repeat: boolean; preventDefault: () => void };

/**
 * A `keydown` handler running the action `actions` names for the key. Held
 * with a modifier the key is the browser's; `repeats: false` makes a held key
 * act once, as a toggle must.
 */
export function keyHandler(actions: Partial<Record<string, () => void>>, { repeats = true } = {}): (event: Key) => void {
  return (event) => {
    const action = actions[event.key];
    if (!action || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (repeats || !event.repeat) action();
  };
}

/** `keyHandler` as a prop on the web, and nothing on a phone, whose keys are its screen reader's. */
export function webKeys(actions: Partial<Record<string, () => void>>, options?: { repeats: boolean }): object {
  return typeof document === "undefined" ? {} : { onKeyDown: keyHandler(actions, options) };
}

type Radio = {
  getAttribute: (name: string) => string | null;
  click: () => void;
  focus: () => void;
  scrollIntoView?: (options: { block: "nearest"; inline: "nearest" }) => void;
};
const RADIO_STEPS: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * A radio group's arrows (WAI-ARIA): the choice moves to the next radio, or
 * the one before, wrapping at the ends, and focus goes with it. It moves from
 * the focused radio, since Tab reaches every one here, else from the chosen
 * one. The radio is clicked, which is how react-native-web presses it.
 */
export function radioGroupHandler(event: Key & { currentTarget: { querySelectorAll: (selector: string) => ArrayLike<Radio> } }): void {
  const step = RADIO_STEPS[event.key];
  if (step == null || event.altKey || event.ctrlKey || event.metaKey) return;
  const radios = Array.from(event.currentTarget.querySelectorAll("[role=radio]")).filter((radio) => radio.getAttribute("aria-disabled") !== "true");
  if (radios.length === 0) return;
  const focused = typeof document === "undefined" ? -1 : radios.indexOf(document.activeElement as unknown as Radio);
  const from = focused >= 0 ? focused : Math.max(0, radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true"));
  const next = radios[(from + step + radios.length) % radios.length]!;
  event.preventDefault();
  next.click();
  next.focus();
  // Focus alone leaves a chip past a sideways row's edge where it was.
  next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** `radioGroupHandler` on a radio group's container on the web; a phone's screen reader moves by swipe. */
export function radioGroupKeys(): object {
  return typeof document === "undefined" ? {} : { onKeyDown: radioGroupHandler };
}
