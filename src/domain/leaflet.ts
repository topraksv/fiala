/**
 * A Kullanma Talimatı in its five sections (`docs/TASKS.md` F5.2, SPEC
 * 13.9), read from the text of the person's own copy of it on the device:
 * TİTCK's leaflets are "all rights reserved", so the app copies none, and a
 * PDF the person keeps as a document is read as they could read it. The
 * template names the sections twice, in its contents and over each body;
 * the bodies are the last run of them in order. Nothing is inferred: a text
 * without three of the five is not a leaflet here.
 */

export type LeafletSection = { number: 1 | 2 | 3 | 4 | 5; paragraphs: string[] };
export type Leaflet = { sections: LeafletSection[]; approvedOn: string | null };

/** Fewer found is a text that only mentions a heading, not a leaflet. */
const LEAST_SECTIONS = 3;

/** A Turkish i in either case, as fonts and capitals write it: `i` alone folds neither `ı` nor `İ`. */
const turkish = (phrase: string) => phrase.replace(/[ıi]/gu, "[ıiIİ]").replace(/ /gu, String.raw`\s+`);

const HEADINGS = ["nedir ve ne için kullanılır", "kullanmadan önce dikkat edilmesi gerekenler", "nasıl kullanılır", "olası yan etkiler", "saklanması"].map(turkish);

/** Where the leaflet's own text ends: the holder's address and the approval follow section 5. `[ \t]`, not `\s`: from every line of a run of blank ones, `\s*` would walk the rest of it. */
const AFTER_BODIES = new RegExp(String.raw`^[ \t]*(?:${turkish("ruhsat sahibi")}|${turkish("bu kullanma talimatı")}\s.*${turkish("onaylanmıştır")})`, "imu");
const APPROVED = new RegExp(String.raw`${turkish("bu kullanma talimatı")}\s+(\d{1,2})[./](\d{1,2})[./](\d{4})\s+${turkish("tarihinde onaylanmıştır")}`, "iu");

/**
 * Older Turkish fonts are read through Windows' Western code page, so `ı`
 * arrives as `ý` or `õ`, `ş` as `þ`, `ğ` as `ð`; none of these is Turkish.
 * Symbol's bullet is a private-use character.
 */
const MISREAD: Record<string, string> = { ý: "ı", õ: "ı", Ý: "İ", þ: "ş", Þ: "Ş", ð: "ğ", Ð: "Ğ" };
const repaired = (text: string) => text.replace(/[ýõÝþÞðÐ]/gu, (letter) => MISREAD[letter]!).replace(/[-]/gu, "•");

/** Each heading, where its number starts and its line ends; a number never reaches past the next one. */
function headingsOf(text: string, number: number): { start: number; end: number }[] {
  const found = new RegExp(String.raw`(?<![\d.,])${number}\.\s(?:(?!\d\.\s)[^]){0,80}?${HEADINGS[number - 1]}[^\n]*`, "giu");
  return [...text.matchAll(found)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** A page's footer, `Sayfa 2/6` or `4 /5`, is not the leaflet's text. */
const FOOTER = /^(?:sayfa\s*)?\d+\s*\/\s*\d+$/iu;

/** Lines a PDF broke for width joined again; a blank line, a bullet or a sentence ending a line starts a paragraph. */
function paragraphsOf(body: string): string[] {
  const paragraphs: string[] = [];
  let open = false;
  for (const line of body.split("\n").map((each) => each.trim())) {
    if (!line || FOOTER.test(line)) {
      open = open && !!line;
      continue;
    }
    const item = /^[•\-–]\s*/u.exec(line);
    if (item) paragraphs.push(`• ${line.slice(item[0].length)}`);
    else if (open) paragraphs[paragraphs.length - 1] += ` ${line}`;
    else paragraphs.push(line);
    open = !/[.!?:]$/u.test(line);
  }
  return paragraphs;
}

export function leafletOf(raw: string): Leaflet | null {
  const text = repaired(raw);
  const found = [1, 2, 3, 4, 5].map((number) => headingsOf(text, number));
  // From the last section back, each the last heading before the next: the contents come first.
  let before = text.length;
  const chosen = [...found].reverse().map((headings) => {
    const heading = headings.filter(({ start }) => start < before).at(-1) ?? null;
    if (heading) before = heading.start;
    return heading;
  }).reverse();
  // A later section named between this heading and the next body found is the contents, not a body.
  const sections: { number: LeafletSection["number"]; start: number; end: number }[] = [];
  chosen.forEach((heading, at) => {
    if (!heading) return;
    const next = chosen.slice(at + 1).find(Boolean)?.start ?? text.length;
    const contents = found.slice(at + 1).some((later) => later.some(({ start }) => start > heading.start && start < next));
    if (!contents) sections.push({ number: (at + 1) as LeafletSection["number"], ...heading });
  });
  if (sections.length < LEAST_SECTIONS) return null;
  const date = APPROVED.exec(text);
  return {
    sections: sections.map(({ number, end }, index) => {
      const body = text.slice(end, sections[index + 1]?.start ?? text.length);
      const cut = index === sections.length - 1 ? AFTER_BODIES.exec(body)?.index : undefined;
      return { number, paragraphs: paragraphsOf(body.slice(0, cut)) };
    }),
    approvedOn: date ? `${date[3]}-${date[2]!.padStart(2, "0")}-${date[1]!.padStart(2, "0")}` : null,
  };
}
