import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ os: "web" }));
const nativeFile = vi.hoisted(() => ({
  size: 0,
  text: vi.fn(async () => "{}"),
  bytes: vi.fn(async () => new Uint8Array()),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    get size() {
      return nativeFile.size;
    }

    text() {
      return nativeFile.text();
    }

    bytes() {
      return nativeFile.bytes();
    }
  },
}));

import { readPickedBytes, readPickedText } from "../../src/services/picked-file";

describe("picked file limits", () => {
  beforeEach(() => {
    platform.os = "web";
    nativeFile.size = 0;
    nativeFile.text.mockClear();
    nativeFile.bytes.mockClear();
    vi.unstubAllGlobals();
  });

  it("rejects a web byte asset from File.size before allocating its contents", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(11));
    const asset = {
      uri: "blob:workbook",
      name: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      file: { size: 11, arrayBuffer },
    };

    await expect(readPickedBytes(asset as never, 10, "Dosya çok büyük.")).rejects.toThrow("Dosya çok büyük.");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects a web text asset from File.size before allocating its contents", async () => {
    const text = vi.fn(async () => "{}");
    const asset = {
      uri: "blob:backup",
      name: "backup.json",
      mimeType: "application/json",
      file: { size: 11, text },
    };

    await expect(readPickedText(asset as never, 10, "Yedek çok büyük.", "Geçersiz yedek.")).rejects.toThrow("Yedek çok büyük.");
    expect(text).not.toHaveBeenCalled();
  });

  it("decodes valid UTF-8 text and rejects a legacy single-byte encoding", async () => {
    const valid = new TextEncoder().encode('{"name":"Çağrı"}');
    const invalid = Uint8Array.of(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xfc, 0x22, 0x7d);
    const asset = (bytes: Uint8Array) => ({
      uri: "blob:backup",
      name: "backup.json",
      mimeType: "application/json",
      file: { size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer) },
    });

    await expect(readPickedText(asset(valid) as never, 100, "Büyük.", "Kodlama geçersiz."))
      .resolves.toBe('{"name":"Çağrı"}');
    await expect(readPickedText(asset(invalid) as never, 100, "Büyük.", "Kodlama geçersiz."))
      .rejects.toThrow("Kodlama geçersiz.");
  });

  it("validates native bytes before asking Expo to decode them", async () => {
    platform.os = "ios";
    nativeFile.bytes.mockResolvedValueOnce(Uint8Array.of(0xff));

    await expect(readPickedText({ uri: "file:///backup.json" } as never, 100, "Büyük.", "Kodlama geçersiz."))
      .rejects.toThrow("Kodlama geçersiz.");
    expect(nativeFile.text).not.toHaveBeenCalled();
  });

  it("rejects a native asset from the filesystem size before reading it", async () => {
    platform.os = "ios";
    nativeFile.size = 11;
    const asset = {
      uri: "file:///workbook.xlsx",
      name: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    await expect(readPickedBytes(asset as never, 10, "Dosya çok büyük.")).rejects.toThrow("Dosya çok büyük.");
    expect(nativeFile.bytes).not.toHaveBeenCalled();
  });

  it("stops a web fallback response while its stream crosses the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(11))));
    const asset = {
      uri: "blob:workbook",
      name: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    await expect(readPickedBytes(asset as never, 10, "Dosya çok büyük.")).rejects.toThrow("Dosya çok büyük.");
  });

  it("checks the actual byte count when picker metadata understates it", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(11));
    const asset = {
      uri: "blob:workbook",
      name: "workbook.xlsx",
      size: 5,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      file: { size: 5, arrayBuffer },
    };

    await expect(readPickedBytes(asset as never, 10, "Dosya çok büyük.")).rejects.toThrow("Dosya çok büyük.");
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });
  it("reads a file of exactly the limit, whatever size the picker could not state", async () => {
    const bytes = new TextEncoder().encode("0123456789");
    const asset = (size: unknown) => ({
      uri: "blob:workbook",
      name: "workbook.xlsx",
      size,
      file: { size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer) },
    });
    for (const size of [10, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readPickedBytes(asset(size) as never, 10, "Dosya çok büyük."), String(size)).resolves.toEqual(bytes);
    }
  });

  it("names a web fallback the browser could not read, rather than reading its error page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await expect(readPickedBytes({ uri: "blob:gone", name: "gone.xlsx" } as never, 10, "Dosya çok büyük."))
      .rejects.toThrow("Selected file could not be read (404)");
  });

  it("reads a native file through Expo, not the browser", async () => {
    platform.os = "ios";
    nativeFile.size = 2;
    nativeFile.bytes.mockResolvedValueOnce(new Uint8Array([123, 125]));
    await expect(readPickedText({ uri: "file:///backup.json", name: "backup.json" } as never, 10, "Yedek çok büyük.", "Geçersiz yedek."))
      .resolves.toBe("{}");
    expect(nativeFile.text).toHaveBeenCalledOnce();
  });

  it("takes UTF-8 at the edges of each length and refuses the overlong, the surrogate, the truncated and past U+10FFFF", async () => {
    const read = (bytes: number[]) =>
      readPickedText({ uri: "blob:x", name: "x.csv", file: { size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer } } as never, 100, "Büyük.", "Kodlama geçersiz.").then(
        () => true,
        () => false,
      );
    const valid = [[0x7f], [0xc2, 0x80], [0xdf, 0xbf], [0xe0, 0xa0, 0x80], [0xed, 0x9f, 0xbf], [0xee, 0x80, 0x80], [0xef, 0xbf, 0xbf], [0xf0, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0x41, 0xc2, 0x80, 0x42]];
    const invalid = [[0x80], [0xc1, 0xbf], [0xe0, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xf0, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xc2], [0xe0, 0xa0], [0xc2, 0x41], [0xc2, 0xc0]];
    for (const bytes of valid) expect(await read(bytes), bytes.map((byte) => byte.toString(16)).join(" ")).toBe(true);
    for (const bytes of invalid) expect(await read(bytes), bytes.map((byte) => byte.toString(16)).join(" ")).toBe(false);
  });

  it("refuses with the person's own sentence, as an error the screen may show", async () => {
    await expect(readPickedText({ uri: "blob:x", name: "x.csv", file: { size: 1, arrayBuffer: async () => Uint8Array.of(0xff).buffer } } as never, 10, "Büyük.", "Kodlama geçersiz."))
      .rejects.toMatchObject({ name: "UserFacingError", message: "Kodlama geçersiz." });
  });

  it("checks the bytes a native file gave, not only the size it stated", async () => {
    platform.os = "ios";
    nativeFile.size = 5;
    nativeFile.bytes.mockResolvedValueOnce(new Uint8Array(11));
    await expect(readPickedBytes({ uri: "file:///big.csv" } as never, 10, "Dosya çok büyük.")).rejects.toThrow("Dosya çok büyük.");
  });

  it("reads a web fallback whole, chunk after chunk, and refuses one whose stated length is past the limit before reading", async () => {
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1, 2)); controller.enqueue(Uint8Array.of(3)); controller.close(); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream())));
    await expect(readPickedBytes({ uri: "blob:x", name: "x.csv" } as never, 10, "Büyük.")).resolves.toEqual(Uint8Array.of(1, 2, 3));
    const stated = new Response(stream(), { headers: { "content-length": "11" } });
    const read = vi.spyOn(stated.body!, "getReader");
    vi.stubGlobal("fetch", vi.fn(async () => stated));
    await expect(readPickedBytes({ uri: "blob:x", name: "x.csv" } as never, 10, "Büyük.")).rejects.toThrow("Büyük.");
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a web fallback with no stream from its buffer, within the limit", async () => {
    const bodiless = (size: number) => ({ ok: true, headers: new Headers(), body: null, arrayBuffer: async () => new Uint8Array(size).fill(7).buffer });
    vi.stubGlobal("fetch", vi.fn(async () => bodiless(3)));
    await expect(readPickedBytes({ uri: "blob:x", name: "x.csv" } as never, 10, "Büyük.")).resolves.toEqual(Uint8Array.of(7, 7, 7));
    vi.stubGlobal("fetch", vi.fn(async () => bodiless(11)));
    await expect(readPickedBytes({ uri: "blob:x", name: "x.csv" } as never, 10, "Büyük.")).rejects.toThrow("Büyük.");
  });

  it("lets go of a stream it stopped reading", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(6)); }, cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    await expect(readPickedBytes({ uri: "blob:x", name: "x.csv" } as never, 10, "Büyük.")).rejects.toThrow("Büyük.");
    expect(cancel).toHaveBeenCalled();
  });
});
