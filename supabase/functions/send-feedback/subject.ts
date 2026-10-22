/**
 * The subject a feedback report arrives under. Here, never in the client: a
 * header a client dictates is a header a client injects into. Collapsing
 * whitespace keeps it on one line, and so keeps a CR or LF in a message from
 * starting a header of its own. Its own file, with no Deno global, so
 * `tests/domain/feedback.test.ts` runs it.
 */
const SUBJECT_LIMIT = 60;

/** Below this, stepping back to a word boundary would throw the subject away. */
const MIN_KEPT = 20;

export function feedbackSubject(category: string, message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length <= SUBJECT_LIMIT) return `[Fiala/${category}] ${trimmed}`;
  const cut = trimmed.slice(0, SUBJECT_LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  return `[Fiala/${category}] ${(lastSpace > MIN_KEPT ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
