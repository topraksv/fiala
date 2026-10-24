// Every case is synthetic: a real statement never belongs in this repository. An unreadable
// statement must be reported with a reason the review flow can act on, never half-read.
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES, extractPdfText } from "../../src/services/pdf-text";

function makePdf(
  lines: string[],
  options: { compress?: boolean; encrypt?: boolean; filter?: string } = {},
): Uint8Array {
  const { compress = true, encrypt = false, filter } = options;
  const content = ["BT /F1 10 Tf 40 800 Td"]
    .concat(lines.map((line, index) =>
      `${index === 0 ? "" : "0 -14 Td "}(${line.replace(/([()\\])/g, "\\$1")}) Tj`))
    .concat(["ET"])
    .join("\n");
  const body = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const declaredFilter = filter ?? (compress ? " /Filter /FlateDecode" : "");
  const parts: Buffer[] = [];
  const push = (value: string | Buffer) =>
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"));
  push("%PDF-1.4\n");
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n");
  push(`4 0 obj\n<< /Length ${body.length}${declaredFilter} >>\nstream\n`);
  push(body);
  push("\nendstream\nendobj\n");
  push(`trailer\n<< /Root 1 0 R${encrypt ? " /Encrypt 9 0 R" : ""} >>\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * A PDF whose ToUnicode CMap is a work bomb: each `<0000> <FFFF> <0041>` range is accepted
 * and then walked, so repeating it makes synchronous work the entry cap never bounded.
 */
function makeCmapBombPdf(rangeCount: number): Uint8Array {
  const cmap = `begincmap\nbeginbfrange\n${"<0000> <FFFF> <0041>\n".repeat(rangeCount)}endbfrange\nendcmap`;
  // Uncompressed on purpose (so not built with `pdfOf`): the inflate bound is not what is under test here.
  const cmapBody = Buffer.from(cmap, "latin1");
  const content = "BT /F1 10 Tf 40 800 Td <00410042> Tj ET";
  const contentBody = deflateSync(Buffer.from(content, "latin1"));
  const parts: Buffer[] = [];
  const push = (value: string | Buffer) =>
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"));
  push("%PDF-1.4\n");
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>\nendobj\n");
  push(`4 0 obj\n<< /Length ${contentBody.length} /Filter /FlateDecode >>\nstream\n`);
  push(contentBody);
  push("\nendstream\nendobj\n");
  push("6 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 7 0 R >>\nendobj\n");
  push(`7 0 obj\n<< /Length ${cmapBody.length} >>\nstream\n`);
  push(cmapBody);
  push("\nendstream\nendobj\n");
  push("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
  return new Uint8Array(Buffer.concat(parts));
}

/** `body` between a PDF header and a trailer, uncompressed. */
const plainPdf = (body: string) =>
  new Uint8Array(Buffer.from(`%PDF-1.5\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1"));
const MEGABYTE = "a".repeat(1_000_000);
const NO_TEXT = { ok: false, reason: "no_text_layer" } as const;

/** A PDF from numbered objects; a stream object is `[extra dictionary entries, body]`, deflated. */
function pdfOf(objects: Record<number, string | [string, string]>): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n", "latin1")];
  for (const [number, object] of Object.entries(objects)) {
    if (typeof object === "string") {
      parts.push(Buffer.from(`${number} 0 obj\n${object}\nendobj\n`, "latin1"));
      continue;
    }
    const body = deflateSync(Buffer.from(object[1], "latin1"));
    parts.push(
      Buffer.from(`${number} 0 obj\n<< ${object[0]} /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      body,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    );
  }
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

/** A `ToUnicode` CMap naming each glyph id's character. */
function toUnicode(glyphs: Record<string, string>): [string, string] {
  const pairs = Object.entries(glyphs).map(([id, text]) => `<${id}> <${text.charCodeAt(0).toString(16).padStart(4, "0")}>`);
  return ["", `begincmap\nbeginbfchar\n${pairs.join("\n")}\nendbfchar\nendcmap`];
}

/** An object stream holding `objects`, with the `number offset` header PDF 1.5 writes before `/First`. */
function objectStream(objects: [number, string][]): [string, string] {
  let offset = 0;
  const header: string[] = [];
  for (const [number, body] of objects) {
    header.push(`${number} ${offset}`);
    offset += body.length + 1;
  }
  const head = `${header.join(" ")}\n`;
  return [`/Type /ObjStm /N ${objects.length} /First ${head.length}`, head + objects.map(([, body]) => body).join("\n") + "\n"];
}

/** A Type3 glyph drawing: a 1-bit image from rows of `#` and `.`, top row first. */
function glyph(rows: string[]): [string, string] {
  const width = rows[0]!.length;
  const bits = rows.map((row) => {
    let bytes = "";
    for (let at = 0; at < width; at += 8) bytes += String.fromCharCode(Number.parseInt(row.slice(at, at + 8).padEnd(8, ".").replace(/#/g, "1").replace(/\./g, "0"), 2));
    return bytes;
  }).join("");
  return ["", `${width} 0 0 0 ${width} ${rows.length} d1 q ${width} 0 0 ${rows.length} 0 0 cm BI /W ${width} /H ${rows.length} /BPC 1 /IM true /D [1 0] ID ${bits} EI Q`];
}

const glyphFont = (map: number) => `<< /Type /Font /Subtype /Type0 /BaseFont /Sub /Encoding /Identity-H /ToUnicode ${map} 0 R >>`;
const CATALOG = "<< /Type /Catalog /Pages 2 0 R >>";
const page = (contents: number, fonts: string) => `<< /Type /Page /Parent 2 0 R /Contents ${contents} 0 R /Resources << /Font << ${fonts} >> >> >>`;

describe("reading the fonts a statement's text is set in", () => {
  it("decodes glyph ids through a font packed, with its pages, into an object stream", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R 10 0 R] /Count 2 >>",
      4: ["", "BT /F1 10 Tf 40 800 Td <00010002> Tj ET"],
      6: toUnicode({ "0001": "M", "0002": "G" }),
      11: ["", "BT /F1 10 Tf 40 800 Td <0002> Tj ET"],
      12: objectStream([[3, page(4, "/F1 5 0 R")], [5, glyphFont(6)], [10, page(11, "/F1 5 0 R")]]),
    }));
    expect(result.ok && result.pageCount).toBe(2);
    expect(result.ok && result.text.split("\n").filter(Boolean)).toEqual(["MG", "G"]);
  });

  it("decodes each glyph font on a page through its own map", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: page(4, "/F1 5 0 R /F2 7 0 R"),
      4: ["", "BT /F1 10 Tf 40 800 Td <0001> Tj /F2 10 Tf <0001> Tj ET"],
      5: glyphFont(6),
      6: toUnicode({ "0001": "M" }),
      7: glyphFont(8),
      8: toUnicode({ "0001": "Z" }),
    }));
    expect(result).toEqual({ ok: true, text: "MZ", pageCount: 1 });
  });

  it("reads a plain font's text beside a glyph font's, through a font dictionary of its own", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font 9 0 R >> >>",
      4: ["", "BT /F1 10 Tf 40 800 Td <0001> Tj /F2 10 Tf (PLAIN) Tj <41> Tj ET"],
      5: glyphFont(6),
      6: toUnicode({ "0001": "M" }),
      7: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      9: "<< /F1 5 0 R /F2 7 0 R >>",
    }));
    expect(result).toEqual({ ok: true, text: "MPLAINA", pageCount: 1 });
  });

  it("refuses a glyph font that ships no map instead of guessing its letters", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: page(4, "/F1 5 0 R /F2 7 0 R"),
      4: ["", "BT /F2 10 Tf 40 800 Td <0001> Tj ET"],
      5: glyphFont(6),
      6: toUnicode({ "0001": "M" }),
      7: "<< /Type /Font /Subtype /Type0 /BaseFont /Bare /Encoding /Identity-H >>",
    }));
    expect(result).toEqual({ ok: false, reason: "unmapped_font" });
  });

  it("refuses a Type3 font whose glyph names are not its codes", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: page(4, "/C1 5 0 R"),
      4: ["", "BT /C1 10 Tf 40 800 Td (\\301\\302) Tj ET"],
      5: "<< /Type /Font /Subtype /Type3 /CharProcs << /g1 6 0 R /g2 6 0 R >> /Encoding << /Type /Encoding /Differences [ 193 /g1 /g2 ] >> >>",
      6: glyph(["#"]),
    }));
    expect(result).toEqual({ ok: false, reason: "unmapped_font" });
  });

  /**
   * A statement printed through a mainframe's page format (AFP): Type3 fonts
   * named `C` + code, text in EBCDIC, each glyph group placed on its own, and
   * the Turkish letters the code page lacks drawn from a supplement font.
   */
  describe("a page-format statement", () => {
    const I = ["#.", "..", "#.", "#.", "#."];
    const S = ["###", "#..", "###", "..#", "###"];
    const A = [".#.", "#.#", "###", "#.#"];
    const afpFont = (codes: Record<number, number>) => {
      const names = Object.entries(codes).map(([code, object]) => `/C${Number(code).toString(16)} ${object} 0 R`).join(" ");
      const differences = Object.keys(codes).map((code) => `${code} /C${Number(code).toString(16)}`).join(" ");
      return `<< /Type /Font /Subtype /Type3 /FontMatrix [1 0 0 1 0 0] /FirstChar 0 /Widths [${Array(256).fill(1).join(" ")}] /CharProcs << ${names} >> /Encoding << /Differences [ ${differences} ] >> >>`;
    };
    const read = (content: string) => extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: page(4, "/F1 5 0 R /F2 6 0 R"),
      4: ["", content],
      5: afpFont({ 0x89: 10, 0xa2: 11, 0xc1: 12, 0xf1: 13, 0x4b: 13 }),
      6: afpFont({ 0xa6: 14, 0xa7: 15 }),
      10: glyph(I),
      11: glyph(S),
      12: glyph(A),
      13: glyph(["#"]),
      14: glyph([...S, "...", ".#."]),
      15: glyph(I.slice(2)),
    }));
    const run = (font: string, x: number, y: number, codes: string) => `/${font} 2 Tf 100 Tz 1 0 0 1 0 0 Tm ${x} ${y} Td [(${codes})] TJ`;

    it("reads rows top to bottom and left to right, whatever order the page drew them in", async () => {
      // "is" is two units wide at size 2, so the run at 14 follows it with no gap; 60 is a column away.
      const result = await read(`BT ${run("F1", 10, 700, "\\301")} ${run("F1", 10, 720, "\\211\\242")} ${run("F1", 14, 720, "\\301")} ${run("F1", 60, 720, "\\361\\113")} ET`);
      expect(result).toEqual({ ok: true, text: "isA 1.\nA", pageCount: 1 });
    });

    it("recognises the Turkish letters a supplement font draws as a base letter with marks", async () => {
      const result = await read(`BT ${run("F1", 10, 720, "\\211")} ${run("F2", 11, 720, "\\246\\247")} ${run("F1", 13, 720, "\\242")} ET`);
      expect(result).toEqual({ ok: true, text: "işıs", pageCount: 1 });
    });
  });

  /** An image and a Type3 glyph's drawing are compressed exactly as page content is, and neither is text. */
  it("does not read an image's pixels or a glyph's drawing as page text", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: page(4, "/F1 5 0 R"),
      4: ["", "BT /F1 10 Tf 40 800 Td (MARKET) Tj ET"],
      5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      6: ["/Type /XObject /Subtype /Image /Width 8 /Height 1", "(PIXELS) Tj"],
      7: ["", "30 0 -2 -7 28 31 d1 (GLYPH) Tj"],
      8: ["", "600 0 d0 (WIDTH) Tj"],
    }));
    expect(result).toEqual({ ok: true, text: "MARKET", pageCount: 1 });
  });

  it("reads a font name by each page's own fonts when two pages mean two fonts by it", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 >>",
      3: page(4, "/F1 5 0 R"),
      4: ["", "BT /F1 10 Tf 40 800 Td <0001> Tj ET"],
      5: glyphFont(6),
      6: toUnicode({ "0001": "M" }),
      7: glyphFont(8),
      8: toUnicode({ "0001": "Z" }),
      9: page(10, "/F1 7 0 R"),
      10: ["", "BT /F1 10 Tf 40 800 Td <0001> Tj ET"],
    }));
    expect(result.ok && result.text.split("\n").filter(Boolean)).toEqual(["M", "Z"]);
  });

  it("spaces Word's words by their widths when the size is in Tm and Tf says 1", async () => {
    const font = "<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 65 /LastChar 68 /Widths [500 500 500 500] >>";
    const words = (gap: number) => `BT /F1 1 Tf 10 0 0 10 40 800 Tm (AB) Tj ET BT /F1 1 Tf 10 0 0 10 ${50 + gap} 800 Tm (CD) Tj ET`;
    const read = async (gap: number) => {
      const result = await extractPdfText(pdfOf({ 1: CATALOG, 2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", 3: page(4, "/F1 5 0 R"), 4: ["", words(gap)], 5: font }));
      return result.ok && result.text.trim();
    };
    expect(await read(0), "AB ends at 50 only if its 5-unit glyphs are scaled by Tm").toBe("ABCD");
    expect(await read(4)).toBe("AB CD");
  });

  it("reads a form no page names alone in file order, and leaves any other stream no page shows unread", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      3: page(7, "/F1 5 0 R"),
      4: ["/Type /XObject /Subtype /Form", "BT /F1 10 Tf 40 700 Td (FORM) Tj ET"],
      5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      6: ["/Length1 40", "BT /F1 10 Tf 40 700 Td (FONT PROGRAM) Tj ET"],
      7: ["", "BT /F1 10 Tf 40 800 Td (KEPT) Tj ET"],
    }));
    expect(result.ok && result.text.split("\n").filter(Boolean)).toEqual(["FORM", "KEPT"]);
  });

  it("draws a page's streams with one text state, with the fonts its page tree hands down, and each stream once", async () => {
    const result = await extractPdfText(pdfOf({
      1: CATALOG,
      2: "<< /Type /Pages /Kids [11 0 R 12 0 R] /Count 3 >>",
      3: "<< /Type /Page /Parent 11 0 R /Contents [4 0 R 6 0 R] >>",
      4: ["", "BT /F1 10 Tf 40 800 Td <0001> Tj ET"],
      5: glyphFont(7),
      6: ["", "BT 40 780 Td <0002> Tj ET"],
      7: toUnicode({ "0001": "M", "0002": "G" }),
      8: "<< /Type /Page /Parent 14 0 R /Contents 9 0 R >>",
      9: "[10 0 R 15 0 R]",
      10: ["", "BT /F1 10 Tf 40 800 Td <0001> Tj ET"],
      11: "<< /Type /Pages /Parent 2 0 R /Kids [3 0 R 17 0 R] /Resources << /Font << /F1 5 0 R >> >> >>",
      12: "<< /Type /Pages /Parent 2 0 R /Kids [14 0 R] /Resources << /Font << /F1 13 0 R >> >> >>",
      13: glyphFont(16),
      14: "<< /Type /Pages /Parent 12 0 R /Kids [8 0 R] >>",
      15: ["", "BT 40 780 Td <0001> Tj ET"],
      16: toUnicode({ "0001": "Z" }),
      17: "<< /Type /Page /Parent 11 0 R /Contents 4 0 R >>",
      18: "<< /Type /Page /Parent 11 0 R /Contents 99 0 R >>",
    }));
    expect(result.ok && result.text.split("\n").filter(Boolean)).toEqual(["M", "G", "Z", "Z"]);
  });

  /** Each gap is 2.9 or 3.1 units, either side of a space: an advance read wrong by any amount moves one across. */
  describe("text placed by position", () => {
    const read = async (fonts: Record<number, string | [string, string]>, content: string) => {
      const result = await extractPdfText(pdfOf({ 1: CATALOG, 2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", 3: page(4, "/F1 5 0 R /F2 8 0 R"), 4: ["", content], ...fonts }));
      return result.ok ? result.text : result.reason;
    };

    it("advances by a simple font's widths from its first code, and moves the line by Td and TD", async () => {
      const font = { 5: "<< /Type /Font /Subtype /TrueType /FirstChar 65 /Widths 9 0 R >>", 9: "[500 1000]" };
      expect(await read(font, "BT /F1 10 Tf 0 700 Td (AB) Tj 17.9 0 Td (A) Tj 8.1 0 Td (B) Tj 0 -20 TD (A) Tj ET")).toBe("ABA B\nA");
    });

    it("advances by a glyph font's /W, as a list and as a range, and by /DW or 1000 for a code it does not list", async () => {
      const result = await read({
        5: "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R /DescendantFonts [7 0 R] >>",
        6: toUnicode({ "0001": "A", "0002": "B", "0003": "C", "0004": "D", "0009": "E" }),
        7: "<< /Type /Font /Subtype /CIDFontType2 /DW 250 /W [1 [500 1000] 3 4 2000] >>",
        8: "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R /DescendantFonts [10 0 R] >>",
        10: "<< /Type /Font /Subtype /CIDFontType2 /W [1 [500]] >>",
      }, "BT /F1 10 Tf 0 700 Td <0001> Tj 8.1 0 Td <0002> Tj 12.9 0 Td <0003> Tj 23.1 0 Td <0004> Tj 22.9 0 Td <0009> Tj 5.6 0 Td <0001> Tj /F2 10 Tf 1 0 0 1 0 600 Tm <0002> Tj 12.9 0 Td <0001> Tj ET");
      expect(result).toBe("A BC DE A\nBA");
    });

    it("adds Tc to every glyph and Tw to every space, scales by Tz, takes TJ's kerning off, and moves by Tm's scale", async () => {
      const widths = Array.from({ length: 34 }, (_, index) => (index === 0 ? 250 : index === 33 ? 500 : 0)).join(" ");
      const result = await read({ 5: `<< /Type /Font /Subtype /TrueType /FirstChar 32 /Widths [${widths}] >>` }, [
        "BT /F1 10 Tf 0 700 Td 2 Tc (AA) Tj 16.9 0 Td (A) Tj",
        "0 Tc 5 Tw 1 0 0 1 0 600 Tm (A A) Tj 20.4 0 Td (A) Tj",
        "0 Tw 50 Tz 1 0 0 1 0 500 Tm (AA) Tj 8.1 0 Td (A) Tj",
        "100 Tz 1 0 0 1 0 400 Tm [(A) -500 (A)] TJ 17.9 0 Td (A) Tj",
        "/F1 1 Tf 10 0 0 10 0 300 Tm (A) Tj 0.81 0 Td (A) Tj 0 -1 Td (A) Tj ET",
      ].join(" "));
      expect(result.split("\n")).toEqual(["AAA", "A AA", "AA A", "AAA", "A A", "A"]);
    });
  });
});

describe("reading a PDF's text layer", () => {
  it("reads an uncompressed text layer too", async () => {
    const result = await extractPdfText(makePdf(["NAKIT AVANS"], { compress: false }));
    expect(result.ok && result.text).toContain("NAKIT AVANS");
  });

  it("survives a literal string containing brackets and backslashes", async () => {
    const result = await extractPdfText(makePdf(["A (B) \\ C"]));
    expect(result.ok && result.text).toContain("A (B) \\ C");
  });
});

describe("refusing what it cannot read, with a reason", () => {
  it("names a file that is not a PDF at all", async () => {
    expect(await extractPdfText(new Uint8Array([1, 2, 3, 4, 5, 6]))).toEqual({ ok: false, reason: "not_a_pdf" });
    expect(await extractPdfText(new Uint8Array())).toEqual({ ok: false, reason: "not_a_pdf" });
  });

  it("names an encrypted statement rather than calling it a scan", async () => {
    expect(await extractPdfText(makePdf(["GIZLI"], { encrypt: true })))
      .toEqual({ ok: false, reason: "encrypted" });
  });

  /** A scan is an image: there is no text layer, and none may be invented. */
  it("names a scanned statement instead of returning nothing", async () => {
    const scanned = makePdf([], { compress: false });
    const result = await extractPdfText(scanned);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_text_layer");
  });

  it("refuses a file larger than a statement can plausibly be", async () => {
    const oversized = new Uint8Array(MAX_PDF_BYTES + 1);
    oversized.set(new TextEncoder().encode("%PDF-1.4"));
    expect(await extractPdfText(oversized)).toEqual({ ok: false, reason: "too_large" });
  });

  /** An encoding this cannot decode is skipped, never guessed at. */
  it("skips a stream compressed with a filter it does not implement", async () => {
    const result = await extractPdfText(makePdf(["GIZLENMIS"], { compress: false, filter: " /Filter /LZWDecode" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_text_layer");
  });

  it("does not hang or throw on a truncated stream", async () => {
    const whole = makePdf(["KESIK"]);
    const truncated = whole.slice(0, Math.floor(whole.length * 0.7));
    await expect(extractPdfText(truncated)).resolves.toEqual({ ok: false, reason: "no_text_layer" });
  });

  /** A stream that claims to inflate to gigabytes is refused, not allocated. */
  it("bounds the WORK a CMap can demand, not only the entries it may keep", async () => {
    // Sized to make the unguarded path unmistakably slow, so the budget is not load-sensitive.
    const started = performance.now();
    const result = await extractPdfText(makeCmapBombPdf(60_000));
    const elapsed = performance.now() - started;
    // Deliberately generous: the point is orders of magnitude, not milliseconds.
    expect(elapsed).toBeLessThan(1_500);
    // And it still reads the document rather than bailing out of it.
    expect(result.ok).toBe(true);
  });

  // Files whose shape is the attack, each sized to take over a second and a half on the reader it guards against.
  it.each<[shape: string, build: () => Uint8Array, expected: Partial<Awaited<ReturnType<typeof extractPdfText>>>]>([
    ["objects that never close", () => plainPdf("1 0 obj\n".repeat(200_000)), NO_TEXT],
    ["a run of digits no object header ends", () => plainPdf(`${"1".repeat(120_000)}\n`), NO_TEXT],
    ["headers that one endobj closes", () => plainPdf(`${Array.from({ length: 60_000 }, (_, i) => `${i + 1} 0 obj\n`).join("")}endobj\n`), NO_TEXT],
    ["an object stream whose offsets go back", () => {
      const head = `${Array.from({ length: 40_000 }, (_, i) => `${i + 1} ${i % 2 ? MEGABYTE.length : 0}`).join(" ")}\n`;
      const text = head + MEGABYTE;
      return plainPdf(`9 0 obj\n<< /Type /ObjStm /N 40000 /First ${head.length} /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`);
    }, NO_TEXT],
    ["a megabyte named as the font dictionary of every page", () => plainPdf(`5 0 obj\n<< /Filler (${MEGABYTE}) >>\nendobj\n6 0 obj\n<< ${"/Font 5 0 R ".repeat(12_000)} >>\nendobj\n`), NO_TEXT],
    ["a megabyte selected as a font by thousands of names", () => plainPdf(`5 0 obj\n<< /Filler (${MEGABYTE}) >>\nendobj\n6 0 obj\n<< /Font << ${Array.from({ length: 24_000 }, (_, i) => `/F${i} 5 0 R`).join(" ")} >> >>\nendobj\n`), NO_TEXT],
    ["streams that share one full CMap", () => {
      const cmap = "begincmap\nbeginbfrange\n<0000> <FFFF> <0041>\nendbfrange\nendcmap";
      const streams = Array.from({ length: 3_000 }, (_, i) => `${i + 10} 0 obj\n<< /Length 15 >>\nstream\nBT <0041> Tj ET\nendstream\nendobj\n`).join("");
      return plainPdf(`3 0 obj\n<< /Subtype /Type0 >>\nendobj\n4 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n${streams}`);
    }, { ok: true }],
    ["streams with no dictionary before them", () => plainPdf(`${MEGABYTE}\n${">>stream\nendstream\n".repeat(8_000)}`), NO_TEXT],
  ])("bounds the work of %s", async (_shape, build, expected) => {
    const bytes = build();
    const started = performance.now();
    const result = await extractPdfText(bytes);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result).toMatchObject(expected);
  });

  // A statement's text layer compresses very well; a fixed output estimate would cut it off mid-document.
  it("reads a text layer that compresses far better than any fixed estimate", async () => {
    const lines = Array.from({ length: 4_000 }, () => "MIGROS MARKET ODEME 1.234,56");
    const pdf = makePdf([...lines, "KAPANIS BAKIYESI 9.876,54"]);

    const result = await extractPdfText(pdf);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The last line is the assertion: truncation loses the tail, where the closing balance is.
    expect(result.text).toContain("KAPANIS BAKIYESI 9.876,54");
    expect(result.text.match(/MIGROS MARKET/g)).toHaveLength(4_000);
  });

  // An over-allocated output buffer would leak unzeroed memory into the text, so the check is exact.
  it("returns the stream's own bytes and nothing that was after them", async () => {
    const result = await extractPdfText(makePdf(["ILK SATIR", "SON SATIR"]));

    expect(result).toEqual({ ok: true, text: "ILK SATIR\nSON SATIR", pageCount: 1 });
  });

  /** A direct `/Length` ends the stream there; one that points at another object cannot be read, so the stream runs to `endstream`. */
  it("reads a stream to its declared length, or to endstream when the length is a reference", async () => {
    const stream = (length: string) => plainPdf(`4 0 obj\n<< ${length} >>\nstream\nBT (REAL) Tj ET\nBT (JUNK) Tj ET\nendstream\nendobj\n`);
    const own = "BT (REAL) Tj ET".length;
    for (const length of [`/Length ${own}`, `/Length  ${own}`]) {
      expect(await extractPdfText(stream(length)), length).toEqual({ ok: true, text: "REAL", pageCount: expect.any(Number) });
    }
    const referenced = await extractPdfText(stream("/Length 9  0 R"));
    expect(referenced.ok && referenced.text.split("\n")).toEqual(["REAL", "JUNK"]);
  });

  it("bounds what a single stream may expand to", async () => {
    const bomb = deflateSync(Buffer.alloc(2_000_000, 0x41));
    const parts: Buffer[] = [
      Buffer.from("%PDF-1.4\n4 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
      bomb,
      Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
    ];
    const started = Date.now();
    const result = await extractPdfText(new Uint8Array(Buffer.concat(parts)));
    expect(Date.now() - started).toBeLessThan(10_000);
    // It must decide rather than exhaust memory.
    expect(result).toEqual({ ok: false, reason: "no_text_layer" });
  });

  it("names a file of streams that each expand to the ceiling unreadable", async () => {
    // A refused stream must count towards the budget, or each is inflated in full again.
    const bomb = deflateSync(Buffer.alloc(25 * 1024 * 1024));
    const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
    for (let object = 10; object < 16; object += 1) {
      parts.push(Buffer.from(`${object} 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), bomb, Buffer.from("\nendstream\nendobj\n", "latin1"));
    }
    parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
    expect(await extractPdfText(new Uint8Array(Buffer.concat(parts)))).toEqual({ ok: false, reason: "unreadable" });
  });
});
