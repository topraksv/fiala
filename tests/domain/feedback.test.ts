/**
 * What a feedback report is allowed to be (SPEC 4.1): the
 * form, the service that posts and the function that mails each check them,
 * and none can see the others, so they are asserted once here.
 */

import { describe, expect, it } from "vitest";
import { feedbackSubject } from "../../supabase/functions/send-feedback/subject";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  feedbackMessageRejection,
  isFeedbackCategory,
} from "../../src/domain/feedback";

describe("a feedback report", () => {
  it("offers the shared repair vocabulary and nothing else", () => {
    expect([...FEEDBACK_CATEGORIES]).toEqual(["visual", "functional", "performance", "data", "suggestion", "other"]);
    for (const category of FEEDBACK_CATEGORIES) expect(isFeedbackCategory(category)).toBe(true);
    for (const value of ["", "bug", "Visual", null, 3, {}, undefined]) expect(isFeedbackCategory(value)).toBe(false);
  });

  it("measures the trimmed text, so whitespace is not a description", () => {
    expect(feedbackMessageRejection("")).toBe("empty");
    expect(feedbackMessageRejection(" ".repeat(40))).toBe("empty");
  });

  it("has a floor and a ceiling, each met exactly", () => {
    expect(feedbackMessageRejection("a".repeat(FEEDBACK_MESSAGE_MIN - 1))).toBe("tooShort");
    expect(feedbackMessageRejection(`  ${"a".repeat(FEEDBACK_MESSAGE_MIN)}  `)).toBeNull();
    expect(feedbackMessageRejection("a".repeat(FEEDBACK_MESSAGE_MAX))).toBeNull();
    expect(feedbackMessageRejection("a".repeat(FEEDBACK_MESSAGE_MAX + 1))).toBe("tooLong");
  });
});

describe("the subject a report arrives under", () => {
  it("names the app and the category, and keeps a short message whole", () => {
    expect(feedbackSubject("visual", "   Kısa mesaj   ")).toBe("[Fiala/visual] Kısa mesaj");
  });

  it("collapses whitespace, so no newline reaches a header", () => {
    expect(feedbackSubject("data", "İki\r\n\nsatır")).toBe("[Fiala/data] İki satır");
  });

  it("keeps exactly the limit whole, and shortens past it on a word boundary", () => {
    const exact = "a".repeat(60);
    expect(feedbackSubject("other", exact)).toBe(`[Fiala/other] ${exact}`);
    const long = "Kiler ekranında sütün miktarını değiştirdiğimde liste tamamen boş kalıyor";
    const subject = feedbackSubject("functional", long);
    const body = subject.slice("[Fiala/functional] ".length, -1);
    expect(subject.endsWith("…")).toBe(true);
    expect(long.startsWith(body)).toBe(true);
    expect(long[body.length]).toBe(" ");
  });

  it("cuts hard when stepping back would leave almost nothing", () => {
    const subject = feedbackSubject("other", `ab ${"c".repeat(80)}`);
    expect(subject).toBe(`[Fiala/other] ab ${"c".repeat(57)}…`);
  });
});
