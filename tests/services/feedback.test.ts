import { beforeEach, describe, expect, it, vi } from "vitest";

const cloud = {
  configured: true,
  session: true as boolean,
  answer: null as null | { context: { status: number } },
  thrown: false,
  sent: [] as unknown[],
};

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.0.0" } } }));
vi.mock("../../src/sync/supabase", () => ({
  getSupabase: () =>
    cloud.configured
      ? {
          auth: { getSession: async () => ({ data: { session: cloud.session ? {} : null } }) },
          functions: {
            invoke: async (_name: string, { body }: { body: unknown }) => {
              if (cloud.thrown) throw new Error("offline");
              cloud.sent.push(body);
              return { error: cloud.answer };
            },
          },
        }
      : null,
}));

const { sendFeedback } = await import("../../src/services/feedback");

const report = { category: "functional" as const, message: "  Süt işaretlenmiyor  ", images: ["data:image/jpeg;base64,QUJD"] };

beforeEach(() => Object.assign(cloud, { configured: true, session: true, answer: null, thrown: false, sent: [] }));

describe("sending a report", () => {
  it("posts the trimmed message, the device and each screenshot's base64 alone", async () => {
    expect(await sendFeedback(report)).toBe("sent");
    expect(cloud.sent).toEqual([
      {
        category: "functional",
        message: "Süt işaretlenmiyor",
        platform: "ios",
        appVersion: "1.0.0",
        images: [{ mimeType: "image/jpeg", filename: "ekran-goruntusu-1.jpg", base64: "QUJD" }],
      },
    ]);
  });

  it("tells apart what a person can act on", async () => {
    cloud.answer = { context: { status: 429 } };
    expect(await sendFeedback(report)).toBe("rateLimited");
    cloud.answer = { context: { status: 502 } };
    expect(await sendFeedback(report)).toBe("failed");
    cloud.thrown = true;
    expect(await sendFeedback(report)).toBe("failed");
    cloud.session = false;
    expect(await sendFeedback(report)).toBe("unauthenticated");
    cloud.configured = false;
    expect(await sendFeedback(report)).toBe("unconfigured");
  });

  it("posts signed out with the address to answer and no screenshot", async () => {
    cloud.session = false;
    expect(await sendFeedback({ ...report, images: [], replyTo: " ayse@ev.com " })).toBe("sent");
    expect(cloud.sent).toEqual([expect.objectContaining({ images: [], replyTo: "ayse@ev.com" })]);
    expect(await sendFeedback({ ...report, replyTo: "ayse@ev.com" }), "a screenshot needs an account").toBe("unauthenticated");
    expect(await sendFeedback({ ...report, images: [], replyTo: "ayse" })).toBe("unauthenticated");
    expect(cloud.sent).toHaveLength(1);
  });

  it("posts nothing the rules refuse", async () => {
    expect(await sendFeedback({ ...report, message: "kısa" })).toBe("failed");
    expect(await sendFeedback({ ...report, category: "bug" as never })).toBe("failed");
    expect(await sendFeedback({ ...report, images: ["data:image/png;base64,QUJD"] })).toBe("failed");
    expect(await sendFeedback({ ...report, images: Array(5).fill(report.images[0]) })).toBe("failed");
    expect(cloud.sent).toEqual([]);
  });
});
