// Synthetic leaflets on the template's headings: a real one is "all rights reserved" and never belongs here.
import { describe, expect, it } from "vitest";

import { leafletOf } from "../../src/domain/leaflet";

const CONTENTS = [
  "Bu Kullanma Talimatında:",
  "1. ARAX nedir ve ne için kullanılır?",
  "2. ARAX’ı kullanmadan önce dikkat edilmesi gerekenler",
  "3. ARAX nasıl kullanılır?",
  "4. Olası yan etkiler nelerdir?",
  "5. ARAX’ın saklanması",
  "Başlıkları yer almaktadır.",
];
const BODIES = [
  "1. ARAX nedir ve ne için kullanılır?",
  "ARAX bir ağrı kesicidir ve",
  "baş ağrısında kullanılır.",
  "2. ARAX’ı kullanmadan önce dikkat edilmesi gerekenler",
  " Alerjiniz varsa",
  "- Hamileyseniz",
  "Sayfa 1/3",
  "3 /3",
  "3. ARAX nasıl kullanılır?",
  "Günde iki kez.",
  "Yemekten sonra.",
  "4. Olası yan etkiler nelerdir?",
  "Uyku hali.",
  "",
  "Baş dönmesi.",
  "5. ARAX’ın saklanması",
  "25°C altında saklayınız.",
  "Ruhsat sahibi: Örnek İlaç A.Ş.",
  "Bu kullanma talimatı 9/2/2024 tarihinde onaylanmıştır.",
];
const leaflet = (...lines: string[]) => leafletOf(lines.join("\n"));

describe("a leaflet in its sections", () => {
  it("takes the bodies after the contents, each to the next heading, and the day it was approved", () => {
    expect(leaflet(...CONTENTS, ...BODIES)).toEqual({
      sections: [
        { number: 1, paragraphs: ["ARAX bir ağrı kesicidir ve baş ağrısında kullanılır."] },
        { number: 2, paragraphs: ["• Alerjiniz varsa", "• Hamileyseniz"] },
        { number: 3, paragraphs: ["Günde iki kez.", "Yemekten sonra."] },
        { number: 4, paragraphs: ["Uyku hali.", "Baş dönmesi."] },
        { number: 5, paragraphs: ["25°C altında saklayınız."] },
      ],
      approvedOn: "2024-02-09",
    });
  });

  it("reads headings in capitals, through a Western code page, and broken across lines", () => {
    const sections = leaflet(
      "1. ARAX NEDİR VE NE İÇİN KULLANILIR?",
      "Ağrıda.",
      "2. ARAX kullanmadan önce dikkat edilmesi gerekenler",
      "Alerjide kullanmayýnýz, þiþede ðÝÐÞ.",
      "3. ARAX",
      "",
      "nasõl kullanõlõr?",
      "Ağızdan.",
    )?.sections;
    expect(sections?.map(({ number, paragraphs }) => [number, paragraphs])).toEqual([
      [1, ["Ağrıda."]],
      [2, ["Alerjide kullanmayınız, şişede ğİĞŞ."]],
      [3, ["Ağızdan."]],
    ]);
  });

  it("drops a heading the contents alone name, rather than reading the contents as its body", () => {
    const sections = leaflet(...CONTENTS, ...BODIES.slice(3))?.sections;
    expect(sections?.map(({ number }) => number)).toEqual([2, 3, 4, 5]);
  });

  it("is no leaflet below three sections, and no number glued to another is a heading", () => {
    expect(leaflet("3. ARAX nasıl kullanılır?", "Ağızdan.", "4. Olası yan etkiler", "Yok.")).toBeNull();
    expect(leaflet("13. ARAX nedir ve ne için kullanılır?", "2,4. kullanmadan önce dikkat edilmesi gerekenler", "1.5. nasıl kullanılır", "x")).toBeNull();
    expect(leafletOf("")).toBeNull();
  });

  it("knows no approval day it was not given, and cuts the last body at the approval", () => {
    const read = leaflet(...BODIES.slice(0, 17), "Bu kullanma talimatı ......... tarihinde onaylanmıştır.");
    expect(read?.approvedOn).toBeNull();
    expect(read?.sections.at(-1)?.paragraphs).toEqual(["25°C altında saklayınız."]);
  });

  it("reads a crafted run of blank lines with no end after it in linear time", () => {
    const started = performance.now();
    expect(leaflet(...BODIES.slice(0, 17), "\n".repeat(200_000), "son")?.sections.at(-1)?.paragraphs).toEqual(["25°C altında saklayınız.", "son"]);
    expect(performance.now() - started, "a quadratic walk takes seconds here").toBeLessThan(500);
  });

  it("takes no numbered item, no heading quoted in a body and no footer for the leaflet's own, and joins only what a PDF broke", () => {
    const sections = leaflet(
      "1. ARAX nedir ve ne için kullanılır?",
      "ARAX bir ağrı kesicidir ve",
      "Sayfa1/12",
      "baş ağrısında kullanılır.  ",
      "Örn. diş ağrısında",
      "da kullanılır.",
      "2. ARAX’ı kullanmadan önce dikkat edilmesi gerekenler",
      "•Hamileyseniz.",
      "Ağrı-kesici ilaç alıyorsanız.",
      "12/ 16",
      "3. ARAX nasıl kullanılır?",
      "1. Sabah bir tablet.",
      "2. Öğlen bir tablet.",
      "3. Akşam bir tablet.",
      "4. Gece bir tablet.",
      "5. Gerekirse yarım tablet.",
      "Ayrıca bkz. 1. ARAX nedir ve ne için kullanılır bölümü.",
      "1/2 tablet de alınabilir.",
      "Günde en çok 1/2",
      "",
      "Çocuklarda kullanılmaz.",
      "4. Olası yan etkiler nelerdir?",
      "Ruhsat sahibi firmaya bildiriniz.",
      "5. ARAX’ın saklanması",
      "Bkz. 2. ARAX’ı kullanmadan önce dikkat edilmesi gerekenler.",
    )?.sections;
    expect(sections?.map(({ paragraphs }) => paragraphs)).toEqual([
      ["ARAX bir ağrı kesicidir ve baş ağrısında kullanılır.", "Örn. diş ağrısında da kullanılır."],
      ["• Hamileyseniz.", "Ağrı-kesici ilaç alıyorsanız."],
      ["1. Sabah bir tablet.", "2. Öğlen bir tablet.", "3. Akşam bir tablet.", "4. Gece bir tablet.", "5. Gerekirse yarım tablet.", "Ayrıca bkz. 1. ARAX nedir ve ne için kullanılır bölümü.", "1/2 tablet de alınabilir.", "Günde en çok 1/2", "Çocuklarda kullanılmaz."],
      ["Ruhsat sahibi firmaya bildiriniz."],
      ["Bkz. 2. ARAX’ı kullanmadan önce dikkat edilmesi gerekenler."],
    ]);
  });

  it("keeps a number reaching the next heading's number from swallowing it", () => {
    const sections = leaflet("1. ARAX", "2. ARAX nedir ve ne için kullanılır?", ...BODIES.slice(3))?.sections;
    expect(sections?.map(({ number }) => number)).toEqual([2, 3, 4, 5]);
  });
});
