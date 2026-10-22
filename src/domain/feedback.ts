/**
 * What a feedback report is allowed to be (SPEC 4.1). The form, the service
 * that posts and the function that mails it each check these rules, since a
 * replayed request walks around a rule only the form holds; the function keeps
 * its own copy, being Deno.
 *
 * A picture's type and size are not checked here: screenshots come through the
 * photo picker, already a JPEG of bounded size, and the function still refuses
 * anything else.
 */

/** The words the reporter and the fixer must mean the same thing by. */
export const FEEDBACK_CATEGORIES = ["visual", "functional", "performance", "data", "suggestion", "other"] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** Enough for "buton çalışmıyor", more than an accidental tap. */
export const FEEDBACK_MESSAGE_MIN = 10;

/** So a pasted log cannot become an e-mail nobody opens. */
export const FEEDBACK_MESSAGE_MAX = 4000;

/** The screen before and the screen after, and a little more. */
export const MAX_FEEDBACK_IMAGES = 4;

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === "string" && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** Why this message cannot be sent, or `null`; measured trimmed, so spaces are not a description. */
export function feedbackMessageRejection(message: string): "empty" | "tooShort" | "tooLong" | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length < FEEDBACK_MESSAGE_MIN) return "tooShort";
  if (trimmed.length > FEEDBACK_MESSAGE_MAX) return "tooLong";
  return null;
}
