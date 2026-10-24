// Helix's statement reader, kept alike in both (SPEC 13.9, F5.2). Hermes has no TextDecoder; PDF text is decoded by hand from Latin-1 and hex strings.

// fflate is loaded on demand: a static import added 34 KB to every session's entry chunk.
import type { Unzlib as UnzlibClass } from "fflate";

type UnzlibCtor = typeof UnzlibClass;

/** Bytes a statement may be. Larger is not a statement; it is a mistake. */
export const MAX_PDF_BYTES = 12 * 1024 * 1024;

/** Decompression-bomb guard: a larger stream is refused, not allocated. */
const MAX_STREAM_BYTES = 24 * 1024 * 1024;
/** The per-stream ceiling bounds one bomb, not a file of them, so the document gets a budget too. */
const MAX_INFLATED_BYTES = 8 * MAX_PDF_BYTES;
/** Total text kept. A statement's text layer is far smaller than this. */
const MAX_TEXT_LENGTH = 4_000_000;

export type PdfFailure =
  | "not_a_pdf"
  | "too_large"
  | "encrypted"
  | "no_text_layer"
  | "unmapped_font"
  | "unreadable";

type PdfTextResult =
  | { ok: true; text: string; pageCount: number }
  | { ok: false; reason: PdfFailure };

function bytesToLatin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  // Chunked: `String.fromCharCode(...array)` blows the argument limit on a
  // multi-megabyte document.
  for (let index = start; index < end; index += 8192) {
    const stop = Math.min(index + 8192, end);
    out += String.fromCharCode(...bytes.subarray(index, stop));
  }
  return out;
}

/** A hard gate: `_inflateRaw`-style inflaters can spin on non-deflate input and a synchronous call cannot be interrupted. */
function hasZlibHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const first = bytes[0]!;
  const second = bytes[1]!;
  // CMF method 8 with a valid window; the two-byte value must be a multiple of 31.
  return (first & 0x0f) === 8 && (first >> 4) <= 7 && ((first << 8) | second) % 31 === 0;
}

/** Small on purpose: the bomb limit is only checked between pushes, so one push is the overshoot (4 KB in is at most ~4 MB out). */
const INFLATE_STEP = 4096;

/** Inflate a zlib stream exactly. Streaming, because `unzlibSync` into a too-small buffer truncates silently instead of refusing. */
function inflate(bytes: Uint8Array, Unzlib: UnzlibCtor, budget: { left: number }): Uint8Array | null {
  if (!hasZlibHeader(bytes)) return null;
  const limit = Math.min(MAX_STREAM_BYTES, budget.left);
  const parts: Uint8Array[] = [];
  let written = 0;
  let overflowed = false;
  const stream = new Unzlib((chunk) => {
    if (overflowed) return;
    written += chunk.length;
    if (written > limit) {
      overflowed = true;
      return;
    }
    parts.push(chunk);
  });
  let corrupt = false;
  try {
    for (let at = 0; at < bytes.length && !overflowed; at += INFLATE_STEP) {
      const end = Math.min(at + INFLATE_STEP, bytes.length);
      stream.push(bytes.subarray(at, end), end === bytes.length);
    }
  } catch {
    // Corrupt or not deflate.
    corrupt = true;
  }
  budget.left -= written;
  // Thrown, not skipped: past the budget the file is a file of bombs and is reported unreadable.
  if (budget.left < 0) throw new Error("PDF inflate budget exceeded");
  if (corrupt || overflowed) return null;
  const out = new Uint8Array(written);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `/Length 1234` from a stream's own dictionary, when it declares one. */
function declaredLength(dictionary: string): number | null {
  const match = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface PdfStreams {
  /** Page content, in file order. */
  content: string[];
  /** The object number each content stream is, by the same index. */
  owners: number[];
  /** Whether each is a form XObject, drawn on a page from outside its `/Contents`. */
  forms: boolean[];
  /** Every `ToUnicode` CMap, in file order. */
  cmaps: string[];
  /** The same CMaps by the object number a font names them with. */
  cmapByObject: Map<number, string>;
  /** Type3 glyph drawings by object number. */
  glyphs: Map<number, string>;
  /**
   * Object streams. PDF 1.5 packs font and page dictionaries into them, where a
   * search of the file's bytes cannot see them — and a Type0 font nobody can see
   * is read as single bytes, which is garbage that looks like text.
   */
  packed: { dictionary: string; text: string }[];
}

/**
 * Only what this can decode. An LZW stream or an unfiltered binary blob is
 * skipped rather than guessed at, and so is an image, by its subtype, because
 * it is deflated exactly as page content is.
 */
function notText(dictionary: string, isFlate: boolean): boolean {
  const hasOtherFilter = /\/Filter\s*(?:\[\s*)?\/(?!FlateDecode)[A-Za-z]/.test(dictionary);
  return (hasOtherFilter && !isFlate) || /\/Subtype\s*\/Image\b/.test(dictionary);
}

/** A Type3 glyph's drawing opens with `d0` or `d1`, and is no more page text than an image is. */
const GLYPH_DRAWING = /^\s*(?:-?[\d.]+\s+){2}d0\b|^\s*(?:-?[\d.]+\s+){6}d1\b/;

/**
 * Every content stream in the file, inflated where it says it is compressed.
 * Found by `>>` followed by `stream`, not the bare word: embedded font and image data contain it, and inflating those fed garbage to the inflater.
 */
function contentStreams(bytes: Uint8Array, haystack: string, Unzlib: UnzlibCtor): PdfStreams {
  const found: PdfStreams = { content: [], owners: [], forms: [], cmaps: [], cmapByObject: new Map(), glyphs: new Map(), packed: [] };
  let total = 0;
  const budget = { left: MAX_INFLATED_BYTES };
  const opener = />>\s*stream\r?\n?/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(haystack)) !== null) {
    const start = match.index + match[0].length;
    const close = haystack.indexOf("endstream", start);
    if (close === -1) break;
    opener.lastIndex = close + "endstream".length;

    // Looked for only in the 2000 characters before the keyword: a whole-file search was quadratic.
    const before = haystack.slice(Math.max(0, match.index - 2000), match.index);
    const opensAt = before.lastIndexOf("<<");
    const dictionary = opensAt === -1 ? before : before.slice(opensAt);
    const dictionaryStart = opensAt === -1 ? -1 : match.index - before.length + opensAt;

    const isFlate = /\/Filter\s*(?:\[\s*)?\/FlateDecode/.test(dictionary);
    if (notText(dictionary, isFlate)) continue;

    const declared = declaredLength(dictionary);
    const end = declared != null && start + declared <= close ? start + declared : close;
    const raw = bytes.subarray(start, end);
    const decoded = isFlate ? inflate(raw, Unzlib, budget) : raw;
    if (!decoded) continue;
    const text = bytesToLatin1(decoded);
    total += text.length;
    if (total > MAX_TEXT_LENGTH) break;
    const owner = Number(/(\d+)\s+\d+\s+obj\s*$/.exec(haystack.slice(Math.max(0, dictionaryStart - 32), Math.max(0, dictionaryStart)))?.[1]);
    if (/\/Type\s*\/ObjStm\b/.test(dictionary)) {
      found.packed.push({ dictionary, text });
    } else if (GLYPH_DRAWING.test(text)) {
      found.glyphs.set(owner, text);
    } else if (text.includes("begincmap")) {
      // A CMap is not page content: its hex body would be read as words.
      found.cmaps.push(text);
      found.cmapByObject.set(owner, text);
    } else {
      found.content.push(text);
      found.owners.push(owner);
      found.forms.push(/\/Subtype\s*\/Form\b/.test(dictionary));
    }
  }
  return found;
}

/** Every object's text by number, linear in the file: each boundary is searched once and no two bodies overlap. */
function objectBodies(document: string, packed: PdfStreams["packed"]): Map<number, string> {
  const bodies = new Map<number, string>();
  // `(?<!\d)`: without it every digit of a long run began a backtracking match.
  const header = /(?<!\d)(\d+)\s+\d+\s+obj\b/g;
  const terminator = /\b(?:stream|endobj)\b/g;
  let terminatorAt = 0;
  let match = header.exec(document);
  while (match !== null) {
    const start = match.index + match[0].length;
    if (terminatorAt < start) {
      terminator.lastIndex = start;
      terminatorAt = terminator.exec(document)?.index ?? Infinity;
    }
    const next = header.exec(document);
    bodies.set(Number(match[1]), document.slice(start, Math.min(terminatorAt, next?.index ?? document.length)));
    match = next;
  }
  for (const stream of packed) unpackObjects(stream, bodies);
  return bodies;
}

/** How many objects one object stream may claim to hold. */
const MAX_PACKED_OBJECTS = 100_000;

/** The objects one object stream packs. Stops at an offset that goes back: past one, bodies could each be the rest of the stream. */
function unpackObjects({ dictionary, text }: PdfStreams["packed"][number], bodies: Map<number, string>): void {
  const count = Number(/\/N\s+(\d+)/.exec(dictionary)?.[1]);
  const first = Number(/\/First\s+(\d+)/.exec(dictionary)?.[1]);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(first) || count > MAX_PACKED_OBJECTS) return;
  const header = text.slice(0, first).trim().split(/\s+/).map(Number);
  for (let index = 0; index < count; index += 1) {
    const number = header[index * 2]!;
    const offset = header[index * 2 + 1]!;
    const end = header[index * 2 + 3] ?? text.length - first;
    if (!Number.isSafeInteger(number) || !Number.isSafeInteger(offset) || !(end >= offset)) return;
    bodies.set(number, text.slice(first + offset, first + end));
  }
}

/** What a `Tf` selects: how that font's shown strings become text. */
interface FontDecoder {
  /** Two-byte glyph ids (a Type0 font, or an Identity encoding) rather than one byte a character. */
  cid: boolean;
  toUnicode: ToUnicodeMap | null;
  /**
   * A Type3 font with no map: its glyph codes are the producer's own, so reading them as bytes returns accented noise reported as ok.
   */
  unnamed?: boolean;
  /** Advance per code at size 1, for a font whose text is placed by position. */
  widths?: Map<number, number>;
  /** The advance of a code `widths` does not list. */
  defaultWidth?: number;
}

/** A font's advances at size 1, from `/Widths` or, for a Type0 font, its descendant's `/W`; none when it states none. */
function fontWidths(body: string, bodies: Map<number, string>): Pick<FontDecoder, "widths" | "defaultWidth"> {
  const numbers = (text: string) => (text.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const descendant = /(\d+)\s+\d+\s+R/.exec(entryValue(body, "DescendantFonts", bodies))?.[1];
  if (descendant == null) {
    const advances = numbers(entryValue(body, "Widths", bodies));
    if (advances.length === 0) return {};
    const first = Number(/\/FirstChar\s+(\d+)/.exec(body)?.[1] ?? 0);
    return { widths: new Map(advances.map((advance, index) => [first + index, advance / 1000])) };
  }
  const font = bodies.get(Number(descendant)) ?? "";
  const widths = new Map<number, number>();
  // `c [w1 w2 …]` gives codes from c on; `first last w` one advance to a range.
  const tokens = entryValue(font, "W", bodies).slice(1, -1).match(/\[[^\]]*\]|-?\d*\.?\d+/g) ?? [];
  for (let index = 0; index + 1 < tokens.length && widths.size < MAX_CMAP_ENTRIES;) {
    const first = Number(tokens[index]);
    if (tokens[index + 1]!.startsWith("[")) {
      numbers(tokens[index + 1]!).forEach((advance, offset) => widths.set(first + offset, advance / 1000));
      index += 2;
    } else {
      const last = Math.min(Number(tokens[index + 1]), first + MAX_CMAP_ENTRIES);
      for (let code = first; code <= last; code += 1) widths.set(code, Number(tokens[index + 2]) / 1000);
      index += 3;
    }
  }
  return { widths, defaultWidth: Number(/\/DW\s+(-?\d*\.?\d+)/.exec(font)?.[1] ?? 1000) / 1000 };
}

/** EBCDIC code page 037, the codes a mainframe page format (AFP) sets Latin text in. */
const EBCDIC_037 = "\uFFFD".repeat(64) + "  âäàáãåçñ¢.<(+|&éêëèíîïìß!$*);¬-/ÂÄÀÁÃÅÇÑ¦,%_>?øÉÊËÈÍÎÏÌ`:#@'=\"Øabcdefghi«»ðýþ±°jklmnopqrªºæ¸Æ¤µ~stuvwxyz¡¿ÐÝÞ®^£¥·©§¶¼½¾[]¯¨´×{ABCDEFGHI\u00ADôöòóõ}JKLMNOPQR¹ûüùúÿ\\÷STUVWXYZ²ÔÖÒÓÕ0123456789³ÛÜÙÚ\uFFFD";

/** A Turkish letter drawn as a Latin letter's body with marks: base letter, marks above, marks below. */
const MARKED_LETTERS: Readonly<Record<string, string>> = {
  i00: "ı", I10: "İ", g10: "ğ", G10: "Ğ", s01: "ş", S01: "Ş", c01: "ç", C01: "Ç", o20: "ö", O20: "Ö", u20: "ü", U20: "Ü",
};

const MAX_GLYPH_PIXELS = 65_536;

/** A 1-bit glyph drawing's largest connected part, and how many separate marks sit above and below it. */
interface GlyphShape {
  body: string;
  above: number;
  below: number;
}

function glyphShape(drawing: string | undefined): GlyphShape | null {
  const image = drawing && /BI\s*\/W\s+(\d+)\s*\/H\s+(\d+)\s*\/BPC\s+1\s*\/IM\s+true\s*(\/D\s*\[\s*1\s+0\s*\])?\s*ID\s/.exec(drawing);
  if (!image) return null;
  const width = Number(image[1]);
  const height = Number(image[2]);
  if (width * height > MAX_GLYPH_PIXELS) return null;
  const data = drawing.slice(image.index + image[0].length);
  const ink = image[3] ? 1 : 0;
  const stride = Math.ceil(width / 8);
  const pixels = new Set<number>();
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const byte = data.charCodeAt(row * stride + (column >> 3));
      if (((byte >> (7 - (column & 7))) & 1) === ink) pixels.add((height - 1 - row) * width + column);
    }
  }
  const [body, ...marks] = connectedParts(pixels, width).sort((a, b) => b.length - a.length);
  if (!body) return null;
  const ys = (part: number[]) => part.map((pixel) => Math.floor(pixel / width));
  const top = Math.max(...ys(body));
  const bottom = Math.min(...ys(body));
  const left = Math.min(...body.map((pixel) => pixel % width));
  return {
    body: body.map((pixel) => `${(pixel % width) - left},${Math.floor(pixel / width) - bottom}`).sort().join(" "),
    above: marks.filter((mark) => Math.min(...ys(mark)) > top).length,
    below: marks.filter((mark) => Math.max(...ys(mark)) < bottom).length,
  };
}

function connectedParts(pixels: Set<number>, width: number): number[][] {
  const parts: number[][] = [];
  const unvisited = new Set(pixels);
  for (const start of pixels) {
    if (!unvisited.delete(start)) continue;
    const part = [start];
    for (let index = 0; index < part.length; index += 1) {
      const pixel = part[index]!;
      const column = pixel % width;
      for (const dy of [-width, 0, width]) {
        for (const dx of [-1, 0, 1]) {
          const neighbour = pixel + dy + dx;
          if (column + dx >= 0 && column + dx < width && unvisited.delete(neighbour)) part.push(neighbour);
        }
      }
    }
    parts.push(part);
  }
  return parts;
}

/** The `<< … >>` or `[ … ]` that opens at `at`, what it nests included; empty when it never closes. */
function enclosedAt(text: string, at: number): string {
  const [open, close] = text.startsWith("<<", at) ? ["<<", ">>"] : ["[", "]"];
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    if (text.startsWith(open, index)) depth += 1;
    else if (text.startsWith(close, index)) depth -= 1;
    else continue;
    index += open.length - 1;
    if (depth === 0) return text.slice(at, index + 1);
  }
  return "";
}

/** A dictionary entry's value: the object it references, or the dictionary or array written in place; empty when it is absent. */
function entryValue(body: string, key: string, bodies: Map<number, string>): string {
  const reference = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body);
  if (reference) return bodies.get(Number(reference[1])) ?? "";
  const inline = new RegExp(`/${key}\\s*(?=<<|\\[)`).exec(body);
  return inline ? enclosedAt(body, inline.index + inline[0].length) : "";
}

interface AfpFont {
  /** Glyph drawing object by code. */
  glyphs: Map<number, number>;
  widths: Map<number, number>;
}

/** An encoding's glyph drawings by code, when every glyph is named `C` and its own code in hex. */
function glyphsNamedForCodes(differences: string, drawings: Map<string, number>): Map<number, number> | null {
  const glyphs = new Map<number, number>();
  let code = 0;
  for (const token of differences.match(/\d+|\/[^\s/]+/g) ?? []) {
    if (!token.startsWith("/")) {
      code = Number(token);
      continue;
    }
    const drawing = drawings.get(token.slice(1));
    if (drawing == null || !/^\/C[0-9A-Fa-f]{1,2}$/.test(token) || Number.parseInt(token.slice(2), 16) !== code) return null;
    glyphs.set(code, drawing);
    code += 1;
  }
  return glyphs.size > 0 ? glyphs : null;
}

/**
 * A Type3 font converted from a mainframe page format: every glyph is named
 * `C` and its own code in hex, and no map says which letter it draws.
 */
function afpFont(body: string, bodies: Map<number, string>): AfpFont | null {
  if (!/\/Subtype\s*\/Type3\b/.test(body) || /\/ToUnicode\b/.test(body)) return null;
  const drawings = new Map([...entryValue(body, "CharProcs", bodies).matchAll(/\/(\S+?)\s+(\d+)\s+\d+\s+R/g)].map((m) => [m[1]!, Number(m[2])]));
  const glyphs = glyphsNamedForCodes(/\/Differences\s*\[([^\]]*)\]/.exec(entryValue(body, "Encoding", bodies))?.[1] ?? "", drawings);
  if (!glyphs) return null;
  const first = Number(/\/FirstChar\s+(\d+)/.exec(body)?.[1] ?? 0);
  const scale = Number(/\/FontMatrix\s*\[\s*([-\d.]+)/.exec(body)?.[1] ?? 1);
  const advances = entryValue(body, "Widths", bodies).match(/-?\d*\.?\d+/g) ?? [];
  return { glyphs, widths: new Map(advances.map((advance, index) => [first + index, Number(advance) * scale])) };
}

/** Latin text is EBCDIC 037; letters that code page lacks are drawn from a supplement font and recognised by glyph shape. */
function afpDecoders(fonts: AfpFont[], drawings: Map<number, string>): FontDecoder[] {
  const shapes = fonts.map((font) => new Map([...font.glyphs].map(([code, object]) => [code, glyphShape(drawings.get(object))])));
  const bases = new Map<string, string>();
  for (const glyphs of shapes) {
    for (const [code, shape] of glyphs) {
      const letter = EBCDIC_037[code]!;
      if (shape && "iIsScCgGoOuU".includes(letter) && shape.above === Number(letter === "i") && shape.below === 0) bases.set(shape.body, letter);
    }
  }
  return fonts.map((font, index) => {
    const inked = [...shapes[index]!].filter(([, shape]) => shape != null);
    const turkish = new Map(inked.flatMap(([code, shape]) => {
      const letter = MARKED_LETTERS[`${bases.get(shape!.body)}${shape!.above}${shape!.below}`];
      return letter ? [[code, letter] as const] : [];
    }));
    // A font drawn mostly as marked letters is the supplement; what it draws unrecognised is not guessed.
    const supplement = turkish.size > 0 && turkish.size * 2 >= inked.length;
    const letterOf = (code: number) => supplement ? turkish.get(code) ?? (shapes[index]!.get(code) ? "\uFFFD" : "") : EBCDIC_037[code]!;
    return { cid: false, toUnicode: new Map([...font.glyphs.keys()].map((code) => [code, letterOf(code)])), widths: font.widths };
  });
}

/** Every name a font dictionary gives an object, in file order. Each referenced dictionary is read once. */
function fontEntries(bodies: Map<number, string>): [string, number][] {
  const dictionaries: string[] = [];
  const referenced = new Set<number>();
  for (const body of bodies.values()) {
    for (const inline of body.matchAll(/\/Font\s*<<([^<>]*)>>/g)) dictionaries.push(inline[1]!);
    for (const reference of body.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) referenced.add(Number(reference[1]));
  }
  for (const object of referenced) dictionaries.push(bodies.get(object) ?? "");
  return dictionaries.flatMap((dictionary) => [...dictionary.matchAll(/\/([^\s/[\]()<>{}%]+)\s+(\d+)\s+\d+\s+R/g)].map((entry) => [entry[1]!, Number(entry[2])] as [string, number]));
}

/** The font object each name selects across the document, or null when one name means two fonts: then only a page's own resources say which. */
function fontObjectsByName(entries: [string, number][]): Map<string, number> | null {
  const fontByName = new Map<string, number>();
  for (const [name, object] of entries) {
    const known = fontByName.get(name);
    if (known != null && known !== object) return null;
    fontByName.set(name, object);
  }
  return fontByName;
}

/** Each font object's decoder. Fonts and CMaps are read once however many names and pages share them. */
function fontDecoders(bodies: Map<number, string>, streams: PdfStreams, objects: Iterable<number>): Map<number, FontDecoder> {
  const unique = [...new Set(objects)];
  const parsed = new Map<number, ToUnicodeMap>();
  const decoders = new Map<number, FontDecoder>();
  const afp = unique.flatMap((object) => {
    const font = afpFont(bodies.get(object) ?? "", bodies);
    return font ? [[object, font] as const] : [];
  });
  afpDecoders(afp.map(([, font]) => font), streams.glyphs).forEach((decoder, index) => decoders.set(afp[index]![0], decoder));
  for (const object of unique) {
    if (decoders.has(object)) continue;
    const body = bodies.get(object) ?? "";
    const reference = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body);
    const cmapObject = reference ? Number(reference[1]) : -1;
    const cmap = streams.cmapByObject.get(cmapObject);
    if (cmap != null && !parsed.has(cmapObject)) parsed.set(cmapObject, parseToUnicode(cmap));
    const toUnicode = parsed.get(cmapObject) ?? null;
    decoders.set(object, {
      cid: /\/Subtype\s*\/Type0\b/.test(body) || /\/Encoding\s*\/Identity-[HV]\b/.test(body),
      toUnicode,
      unnamed: toUnicode == null && /\/Subtype\s*\/Type3\b/.test(body),
      ...fontWidths(body, bodies),
    });
  }
  return decoders;
}

const named = (fontByName: Map<string, number>, decoders: Map<number, FontDecoder>) =>
  new Map([...fontByName].map(([name, object]) => [name, decoders.get(object)!] as const));

/** Bounds a page tree that names itself as its parent. */
const MAX_TREE_DEPTH = 32;

/**
 * A page as it is drawn: its content streams in order, which share one text
 * state, so a font a first stream selects shows a second's strings; and the
 * fonts its own resources name, inherited down the page tree. Word writes `/F1`
 * on every page for a different font each time.
 */
interface Page {
  contents: number[];
  fonts: Map<string, number> | null;
}

function pagesOf(bodies: Map<number, string>): Page[] {
  const pages: Page[] = [];
  for (const body of bodies.values()) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue;
    const listed = /\/Contents\s*(\[[^\]]*\]|(\d+)\s+\d+\s+R)/.exec(body);
    const array = listed?.[2] != null ? bodies.get(Number(listed[2])) ?? "" : "";
    const contents = [...((/^\s*\[/.test(array) ? array : listed?.[1]) ?? "").matchAll(/(\d+)\s+\d+\s+R/g)].map((reference) => Number(reference[1]));
    let fonts: Map<string, number> | null = null;
    let node: string | undefined = body;
    for (let depth = 0; node != null && depth < MAX_TREE_DEPTH; depth += 1) {
      if (/\/Resources\b/.test(node)) {
        const dictionary = entryValue(entryValue(node, "Resources", bodies), "Font", bodies);
        fonts = new Map([...dictionary.matchAll(/\/([^\s/[\]()<>{}%]+)\s+(\d+)\s+\d+\s+R/g)].map((entry) => [entry[1]!, Number(entry[2])]));
        break;
      }
      const parent = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(node);
      node = parent ? bodies.get(Number(parent[1])) : undefined;
    }
    pages.push({ contents, fonts });
  }
  return pages;
}

/**
 * What is read as one: a page's streams joined, with the page's fonts, and each
 * form no page names alone, with the document's; in file order. Once a page is
 * found, a stream that is neither is a font program or a cross-reference table,
 * whose bytes would be read as strings; with none found, every stream is read.
 */
function readingUnits(streams: PdfStreams, pages: Page[], decoders: Map<number, FontDecoder>, documentFonts: Map<string, FontDecoder> | null) {
  const indexOf = new Map(streams.owners.map((owner, index) => [owner, index]));
  const claimed = new Set<number>();
  const units: { first: number; text: string; fonts: Map<string, FontDecoder> | null }[] = [];
  for (const page of pages) {
    const indexes = page.contents.map((object) => indexOf.get(object));
    if (indexes.length === 0 || indexes.some((index) => index == null || claimed.has(index))) continue;
    for (const index of indexes) claimed.add(index!);
    units.push({ first: Math.min(...(indexes as number[])), text: indexes.map((index) => streams.content[index!]).join("\n"), fonts: page.fonts ? named(page.fonts, decoders) : documentFonts });
  }
  streams.content.forEach((text, index) => {
    if (!claimed.has(index) && (claimed.size === 0 || streams.forms[index])) units.push({ first: index, text, fonts: documentFonts });
  });
  return units.sort((a, b) => a.first - b.first);
}

/**
 * The font a stream is read with before it selects one, or by a name the
 * resource graph did not resolve: the whole document's single CMap when it uses
 * glyph ids and ships exactly one, and nothing at all — a refusal — when it
 * ships several.
 */
function documentFont(usesGlyphIds: boolean, cmaps: string[]): FontDecoder | null {
  if (!usesGlyphIds) return { cid: false, toUnicode: null };
  return cmaps.length === 1 ? { cid: true, toUnicode: parseToUnicode(cmaps[0]!) } : null;
}

/** A `ToUnicode` CMap: which character each glyph id is. Identity-H text is glyph indexes; without it extraction returns meaningless text that looks readable. */
type ToUnicodeMap = Map<number, string>;

/** `<0041>` → 0x41. Bounded so a malformed CMap cannot allocate. */
function hexValue(token: string): number | null {
  const digits = token.replace(/[<>\s]/g, "");
  if (digits.length === 0 || digits.length > 8 || !/^[0-9A-Fa-f]+$/.test(digits)) return null;
  return Number.parseInt(digits, 16);
}

/** `<0041 0042>` → "AB": a destination may be several UTF-16 code units. */
function hexToString(token: string): string {
  const digits = token.replace(/[<>\s]/g, "");
  let out = "";
  for (let index = 0; index + 3 < digits.length + 1; index += 4) {
    const unit = Number.parseInt(digits.slice(index, index + 4), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/** Caps memory and work: loops stop at this size too, since refused inserts alone once froze the thread for seconds. */
const MAX_CMAP_ENTRIES = 65_536;

/** Read `beginbfchar` and `beginbfrange` sections, including the array form of a range. */
function parseToUnicode(text: string): ToUnicodeMap {
  const map: ToUnicodeMap = new Map();
  const add = (code: number, value: string) => {
    if (map.size < MAX_CMAP_ENTRIES && value !== "") map.set(code, value);
  };
  const full = () => map.size >= MAX_CMAP_ENTRIES;
  for (const section of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of section.match(/<[0-9A-Fa-f\s]+>\s*<[0-9A-Fa-f\s]*>/g) ?? []) {
      if (full()) return map;
      const [source, destination] = pair.match(/<[0-9A-Fa-f\s]*>/g)!;
      const code = hexValue(source!);
      if (code != null) add(code, hexToString(destination!));
    }
  }
  for (const section of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const entry of section.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(\[[\s\S]*?\]|<[0-9A-Fa-f\s]*>)/g)) {
      if (full()) return map;
      addRange(entry, add, full);
    }
  }
  return map;
}

/** One `bfrange` entry: an array of destinations, or one destination counted up across the range. */
function addRange(entry: RegExpMatchArray, add: (code: number, value: string) => void, full: () => boolean): void {
  const low = hexValue(entry[1]!);
  const high = hexValue(entry[2]!);
  if (low == null || high == null || high < low || high - low > MAX_CMAP_ENTRIES) return;
  const destination = entry[3]!;
  if (destination.startsWith("[")) {
    (destination.match(/<[0-9A-Fa-f\s]*>/g) ?? []).forEach((value, offset) => add(low + offset, hexToString(value)));
    return;
  }
  const base = hexToString(destination);
  if (base.length !== 1) return;
  for (let code = low; code <= high && !full(); code += 1) add(code, String.fromCharCode(base.charCodeAt(0) + code - low));
}

/** Two-byte big-endian glyph ids, mapped through the document's own CMap. */
function decodeCids(raw: string, toUnicode: ToUnicodeMap): string {
  let out = "";
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const cid = (raw.charCodeAt(index) << 8) | raw.charCodeAt(index + 1);
    out += toUnicode.get(cid) ?? "";
  }
  return out;
}

/** Unescape a PDF literal string body. */
function unescapeLiteral(body: string): string {
  return body.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_match, code: string) => {
    switch (code) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "(": return "(";
      case ")": return ")";
      case "\\": return "\\";
      default: return String.fromCharCode(Number.parseInt(code, 8));
    }
  });
}

/**
 * One shown string as text under the selected font, or null when that font's
 * glyphs cannot be named.
 *
 * Under a glyph-id font a literal string is two-byte ids too, so it goes
 * through the map rather than being taken at face value. A hex string under a
 * plain font keeps only printable bytes: two digits a byte, and a control code
 * is not a character anyone printed.
 */
function decodeShown(raw: string, font: FontDecoder | null, fromHex: boolean): string | null {
  if (font == null || font.unnamed) return null;
  if (font.cid) return font.toUnicode != null && font.toUnicode.size > 0 ? decodeCids(raw, font.toUnicode) : null;
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const mapped = font.toUnicode?.get(code);
    if (mapped != null) out += mapped;
    else if (!fromHex || code >= 32 || code === 10) out += raw[index];
  }
  return out;
}

/** `<48 65 6C>` → the bytes it spells; a trailing odd digit is followed by 0. */
function hexBytes(hex: string): string {
  const digits = hex.replace(/\s+/g, "");
  let out = "";
  for (let index = 0; index < digits.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(index, index + 2).padEnd(2, "0"), 16));
  }
  return out;
}

/** A string, a name, an array bracket, a number (group 1) or a text operator (group 2). */
const TEXT_TOKEN = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\/[^\s/[\]()<>{}%]+|\[|\]|(-?\d*\.?\d+)|(T[JjdDfmz*cw]|ET|'|")/g;

interface TextOperation {
  operator: string;
  /** The numbers, last name and strings written since the previous operator. */
  numbers: number[];
  name: string;
  strings: { raw: string; hex: boolean }[];
}

/** A content stream's text operators in order; strings after the last one come with an empty operator. */
function* textOperations(stream: string): Generator<TextOperation> {
  let operation: TextOperation = { operator: "", numbers: [], name: "", strings: [] };
  for (const match of stream.matchAll(TEXT_TOKEN)) {
    const token = match[0];
    if (token.startsWith("(")) operation.strings.push({ raw: unescapeLiteral(token.slice(1, -1)), hex: false });
    else if (token.startsWith("<")) operation.strings.push({ raw: hexBytes(token.slice(1, -1)), hex: true });
    else if (token.startsWith("/")) operation.name = token.slice(1);
    else if (match[1] !== undefined) operation.numbers.push(Number(match[1]));
    else if (match[2] !== undefined) {
      yield { ...operation, operator: match[2] };
      operation = { operator: "", numbers: [], name: operation.name, strings: [] };
    }
  }
  if (operation.strings.length > 0) yield operation;
}

/** The strings an operation shows, decoded, and their advance at `scale`; null in a font it cannot name. */
function shownText(strings: TextOperation["strings"], font: FontDecoder | null, scale: number): { text: string; advance: number; glyphs: number; spaces: number } | null {
  let text = "";
  let advance = 0;
  let glyphs = 0;
  let spaces = 0;
  const step = font?.cid ? 2 : 1;
  for (const { raw, hex } of strings) {
    const shown = decodeShown(raw, font, hex);
    if (shown == null) return null;
    text += shown;
    for (let index = 0; index < raw.length; index += step) {
      const code = step === 2 ? (raw.charCodeAt(index) << 8) | raw.charCodeAt(index + 1) : raw.charCodeAt(index);
      advance += (font?.widths?.get(code) ?? font?.defaultWidth ?? 0) * scale;
      glyphs += 1;
      // Word spacing is the single-byte space's alone (PDF 32000 9.3.3).
      if (step === 1 && code === 32) spaces += 1;
    }
  }
  return { text, advance, glyphs, spaces };
}

/**
 * The strings of one content stream in reading order, or null when a string is
 * shown in a font whose glyphs cannot be named. `Tf` selects the font; a
 * vertical `Td` and `T*`, `ET`, `'`, `"` break the line, so a table's rows stay
 * separate lines — which is what makes a statement line parseable at all.
 */
function showText(stream: string, fonts: Map<string, FontDecoder> | null, documentDefault: FontDecoder | null): string | null {
  let out = "";
  let font = documentDefault;
  for (const { operator, numbers, name, strings } of textOperations(stream)) {
    const shown = shownText(strings, font, 0);
    if (!shown) return null;
    out += shown.text;
    if (operator === "Tf") font = fonts?.get(name) ?? documentDefault;
    else if (operator === "Td" || operator === "TD") out += numbers.at(-1) ? "\n" : " ";
    else if (["T*", "ET", "'", '"'].includes(operator)) out += "\n";
  }
  return out;
}

// Runs this close in height (points) share a row; a wider gap between runs is a space.
const ROW_TOLERANCE = 3;
const WORD_GAP = 3;

interface TextRun {
  x: number;
  y: number;
  end: number;
  size: number;
  text: string;
}

/**
 * A page that sets each glyph group at a position, read back as rows: by
 * height, then left to right, a gap wider than a space's share of the size
 * being a space. Stream order says nothing about reading order there. `Td` and
 * `Tm` move the line's start; what is shown moves the pen along it by its
 * advance, its `TJ` kerning and its `Tc` and `Tw` spacing (PDF 32000 9.4.4).
 */
/** Where the pen is and what it writes with, as `positionedText` walks a stream. */
interface Pen {
  font: FontDecoder | null;
  size: number;
  scale: number;
  charSpacing: number;
  wordSpacing: number;
  lineX: number;
  lineY: number;
  x: number;
  // `Tm`'s own scale, its a and d: Word sets `1 Tf` and the size in the matrix, which then scales every move and advance.
  matrixA: number;
  matrixD: number;
}

/** What one operator changes of the pen; showing text moves it in `positionedText`. */
function penAfter(pen: Pen, operator: string, numbers: number[], name: string, fonts: Map<string, FontDecoder>): void {
  const [last = 0, beforeLast = 0] = numbers.slice(-2).reverse();
  if (operator === "Tf") [pen.font, pen.size] = [fonts.get(name) ?? null, last];
  else if (operator === "Tz") pen.scale = last / 100;
  else if (operator === "Tc") pen.charSpacing = last;
  else if (operator === "Tw") pen.wordSpacing = last;
  else if (operator === "Tm") [pen.matrixA, pen.matrixD, pen.lineX, pen.lineY, pen.x] = [numbers.at(-6) ?? 1, numbers.at(-3) ?? 1, beforeLast, last, beforeLast];
  else if (operator === "Td" || operator === "TD") [pen.lineX, pen.lineY, pen.x] = [pen.lineX + beforeLast * pen.matrixA, pen.lineY + last * pen.matrixD, pen.lineX + beforeLast * pen.matrixA];
}

function positionedText(stream: string, fonts: Map<string, FontDecoder>): string | null {
  const runs: TextRun[] = [];
  const pen: Pen = { font: null, size: 0, scale: 1, charSpacing: 0, wordSpacing: 0, lineX: 0, lineY: 0, x: 0, matrixA: 1, matrixD: 1 };
  for (const { operator, numbers, name, strings } of textOperations(stream)) {
    const scaled = pen.size * pen.scale;
    const shown = shownText(strings, pen.font, scaled);
    if (!shown) return null;
    const kerning = operator === "TJ" ? (numbers.reduce((sum, value) => sum + value, 0) / 1000) * scaled : 0;
    const advance = (shown.advance + (shown.glyphs * pen.charSpacing + shown.spaces * pen.wordSpacing) * pen.scale - kerning) * pen.matrixA;
    if (shown.text) runs.push({ x: pen.x, y: pen.lineY, end: pen.x + advance, size: pen.size * pen.matrixD, text: shown.text });
    pen.x += advance;
    penAfter(pen, operator, numbers, name, fonts);
  }
  return rowsOf(runs);
}

function rowsOf(runs: TextRun[]): string {
  const rows: TextRun[][] = [];
  for (const run of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && row[0]!.y - run.y <= ROW_TOLERANCE) row.push(run);
    else rows.push([run]);
  }
  return rows
    .map((row) => row.sort((a, b) => a.x - b.x).map((run, index) => (index > 0 && run.x - row[index - 1]!.end > WORD_GAP ? " " : "") + run.text).join(""))
    .join("\n");
}

/**
 * Undo per-glyph positioning (`S o n Ö d e m e`). A real word boundary arrives as two spaces,
 * an intra-word gap as one. Only for lines mostly of one-character tokens, so normal text is untouched.
 */
function collapseGlyphSpacing(line: string): string {
  const tokens = line.split(" ");
  const printable = tokens.filter((token) => token.length > 0);
  if (printable.length < 6) return line;
  const singles = printable.filter((token) => token.length === 1).length;
  if (singles / printable.length < 0.7) return line;
  // An empty token is the doubled space, i.e. the word boundary.
  let out = "";
  for (const token of tokens) out += token.length === 0 ? " " : token;
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * The text layer of a PDF, or a reason it could not be read.
 *
 * A failure is always a NAMED reason, never an empty string: the review flow
 * has to tell the owner "this is a scan" apart from "this is not a PDF" apart
 * from "this is locked", and each of those has a different next step.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, reason: "too_large" };
  if (bytes.byteLength < 5) return { ok: false, reason: "not_a_pdf" };
  const header = bytesToLatin1(bytes, 0, Math.min(1024, bytes.byteLength));
  if (!header.startsWith("%PDF-")) return { ok: false, reason: "not_a_pdf" };

  let streams: PdfStreams;
  let raw: string;
  try {
    const { Unzlib } = await import("fflate");
    raw = bytesToLatin1(bytes);
    streams = contentStreams(bytes, raw, Unzlib);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  // Before "no text", so a locked file is not reported as a scan.
  const tail = bytesToLatin1(bytes, Math.max(0, bytes.byteLength - 4096), bytes.byteLength);
  if (/\/Encrypt\b/.test(tail)) return { ok: false, reason: "encrypted" };

  const document = [raw, ...streams.packed.map((object) => object.text)].join("\n");
  const pageCount = (document.match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  // Each `Tf` picks its font's own CMap; otherwise the single document CMap serves; several or none is refused, not guessed.
  const usesGlyphIds = /\/Encoding\s*\/Identity-[HV]/.test(document) || /\/Subtype\s*\/Type0/.test(document);
  const bodies = objectBodies(raw, streams.packed);
  const entries = fontEntries(bodies);
  const pages = pagesOf(bodies);
  const decoders = fontDecoders(bodies, streams, [...entries.map(([, object]) => object), ...pages.flatMap((page) => [...(page.fonts?.values() ?? [])])]);
  const byName = fontObjectsByName(entries);
  const units = readingUnits(streams, pages, decoders, byName ? named(byName, decoders) : null);
  // Once, not per stream: re-parsing a full CMap per stream was seconds.
  const fallback = documentFont(usesGlyphIds, streams.cmaps);
  const positioned = ({ text, fonts }: (typeof units)[number]) => [...text.matchAll(/\/([^\s/[\]()<>{}%]+)\s+[-\d.]+\s+Tf/g)].some((m) => fonts?.get(m[1]!)?.widths);
  const shown = units.map((unit) => positioned(unit) ? positionedText(unit.text, unit.fonts!) : showText(unit.text, unit.fonts, fallback));
  if (shown.some((stream) => stream == null)) return { ok: false, reason: "unmapped_font" };

  const text = shown
    .join("\n")
    .split("\n")
    // Before the whitespace collapse, which destroys the doubled space that marks a word boundary.
    .map((line) => collapseGlyphSpacing(line.replace(/\t/g, " ")))
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .trim();
  if (text.length === 0) return { ok: false, reason: "no_text_layer" };
  return { ok: true, text, pageCount: Math.max(1, pageCount) };
}
