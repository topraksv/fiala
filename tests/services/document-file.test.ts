/**
 * A document's file leaving the app (F3.2): a tab or a download in a browser,
 * the share sheet on a phone, each under the type its bytes said and a name
 * any file system takes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  os: "ios",
  files: [] as { at: string; name: string; created?: unknown; written?: [string, unknown] }[],
  shared: [] as [string, unknown][],
  blobs: [] as Blob[],
  revoked: [] as string[],
  clicked: [] as { tag: string; href: string; download: string }[],
  opened: [] as unknown[][],
  tab: null as { opener: unknown; location: { href: string } } | null,
}));

vi.mock("react-native", () => ({ Platform: { get OS() { return device.os; } } }));
vi.mock("../../src/sync/photos", () => ({ bytesOf: (base64: string) => new Uint8Array(Buffer.from(base64, "base64")) }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache:" },
  File: class {
    readonly entry: (typeof device.files)[number];
    constructor(at: string, name: string) {
      this.entry = { at, name };
      device.files.push(this.entry);
    }
    get uri() {
      return `${this.entry.at}/${this.entry.name}`;
    }
    create(options: unknown) {
      this.entry.created = options;
    }
    write(data: string, options: unknown) {
      this.entry.written = [data, options];
    }
  },
}));
vi.mock("expo-sharing", () => ({ shareAsync: async (uri: string, options: unknown) => void device.shared.push([uri, options]) }));

const { openingTab, shareDocument, showPdf } = await import("../../src/services/document-file");

const PDF = Buffer.from("%PDF-1.7 reçete").toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");

beforeEach(() => {
  Object.assign(device, { os: "ios", files: [], shared: [], blobs: [], revoked: [], clicked: [], opened: [], tab: { opener: "app", location: { href: "" } } });
  vi.useFakeTimers();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    device.blobs.push(blob as Blob);
    return `blob:${device.blobs.length}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void device.revoked.push(url));
  vi.stubGlobal("window", { open: (...args: unknown[]) => (device.opened.push(args), device.tab) });
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      const link = { href: "", download: "", click: () => void device.clicked.push({ tag, href: link.href, download: link.download }) };
      return link;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("on a phone", () => {
  it("opens no tab, and hands a PDF to the share sheet as a file in the cache", async () => {
    expect(openingTab()).toBeNull();
    expect(device.opened).toEqual([]);
    await showPdf(null, PDF, "Reçete: Ocak/2026");
    expect(device.files).toEqual([{ at: "cache:", name: "Reçete- Ocak-2026.pdf", created: { overwrite: true }, written: [PDF, { encoding: "base64" }] }]);
    expect(device.shared).toEqual([["cache:/Reçete- Ocak-2026.pdf", { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: "Reçete: Ocak/2026" }]]);
  });

  it("names a photo as one, a nameless file as a document, and a long name short", async () => {
    await shareDocument(JPEG, "jpeg", ' *?"<>|\n\r ');
    await shareDocument(JPEG, "jpeg", "  ");
    await shareDocument(PDF, "pdf", "a".repeat(80));
    expect(device.files.map((file) => file.name)).toEqual(["--------.jpg", "belge.jpg", `${"a".repeat(60)}.pdf`]);
    expect(device.shared[0]![1]).toEqual({ mimeType: "image/jpeg", UTI: "public.jpeg", dialogTitle: ' *?"<>|\n\r ' });
  });
});

describe("in a browser", () => {
  beforeEach(() => {
    device.os = "web";
  });

  it("opens a tab the app's page cannot be reached from, or none where the browser refuses", () => {
    expect(openingTab()).toBe(device.tab);
    expect(device.opened).toEqual([["", "_blank"]]);
    expect(device.tab!.opener).toBeNull();
    device.tab = null;
    expect(openingTab()).toBeNull();
  });

  it("shows a PDF in the tab opened for it, and lets its address go a minute on", async () => {
    const tab = device.tab!;
    await showPdf(tab as unknown as Window, PDF, "Reçete");
    expect(tab.location.href).toBe("blob:1");
    expect(device.blobs[0]!.type).toBe("application/pdf");
    expect(Buffer.from(await device.blobs[0]!.arrayBuffer()).toString("base64")).toBe(PDF);
    expect(device.clicked).toEqual([]);
    vi.advanceTimersByTime(59_999);
    expect(device.revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(device.revoked).toEqual(["blob:1"]);
  });

  it("downloads it where no tab opened, and keeps a photo as a download too", async () => {
    await showPdf(null, PDF, "Reçete");
    await shareDocument(JPEG, "jpeg", "Tahlil");
    expect(device.clicked).toEqual([
      { tag: "a", href: "blob:1", download: "Reçete.pdf" },
      { tag: "a", href: "blob:2", download: "Tahlil.jpg" },
    ]);
    expect(device.blobs.map((blob) => blob.type)).toEqual(["application/pdf", "image/jpeg"]);
    expect(device.shared).toEqual([]);
  });
});
