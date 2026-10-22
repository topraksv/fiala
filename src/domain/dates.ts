/** The part of the day a greeting is written for. */

type PartOfDay = "night" | "morning" | "day" | "evening";

/** Greeting hours on the device's clock: before 6 is still night. */
export function partOfDay(now: Date = new Date()): PartOfDay {
  const hour = now.getHours();
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "day";
  return "evening";
}
