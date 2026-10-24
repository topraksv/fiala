/**
 * Reading a box's code. No karekod is published to test against (F0.7), so
 * the samples are built by GS1's rules over real barcodes from TİTCK's list.
 */

import { describe, expect, it } from "vitest";
import {
  AMOUNT_MAX_MILLI,
  BOX_VIEWS,
  boxExpiry,
  catalogueFields,
  daysUntil,
  expiryState,
  foldName,
  formatAmount,
  formatDay,
  inView,
  lastOpenDay,
  localDay,
  matchesSearch,
  nearly,
  TYPO_FROM,
  normalGtin,
  parseAmount,
  parseDay,
  parseDays,
  printedGtin,
  readBoxCode,
  sortProducts,
  type BoxFacts,
  WARN_DAYS_MAX,
  type ProductSort,
} from "../../src/domain/boxes";

const GS = "\u001d";
const GTIN = "08699546090112";

describe("a GTIN", () => {
  it("is every length GS1 has, as 14 digits", () => {
    expect(normalGtin("8699546090112")).toBe(GTIN);
    expect(normalGtin(" 08699546090112 ")).toBe(GTIN);
    expect(normalGtin("96385074")).toBe("00000096385074");
    expect(normalGtin("036000291452")).toBe("00036000291452");
  });

  it("is shown as the box prints it", () => {
    expect([printedGtin(GTIN), printedGtin("00000096385074"), printedGtin("18699546090119")]).toEqual(["8699546090112", "0000096385074", "18699546090119"]);
  });

  it("is refused with a wrong check digit, a length GS1 does not have, or a letter", () => {
    for (const text of ["8699546090113", "8699546090", "869954609011X", "", "123456789012345"]) expect(normalGtin(text), text).toBeNull();
  });
});

describe("a karekod", () => {
  it("gives the GTIN, expiry, lot and serial, whatever their order", () => {
    const fields = { gtin: GTIN, expiresOn: "2027-03-31", lot: "B2401", serial: "ABC123456789" };
    expect(readBoxCode(`01${GTIN}21ABC123456789${GS}17270331${GS}10B2401`)).toEqual(fields);
    expect(readBoxCode(`01${GTIN}17270331${GS}10B2401${GS}21ABC123456789`)).toEqual(fields);
    expect(readBoxCode(`17270331${GS}10B2401${GS}21ABC123456789${GS}01${GTIN}`)).toEqual(fields);
  });

  it("reads past what scanners add or lose: a symbology prefix, a leading FNC1, a lost GS", () => {
    const fields = { gtin: GTIN, expiresOn: "2027-03-31", lot: "B2401", serial: "ABC123456789" };
    expect(readBoxCode(`]d201${GTIN}21ABC123456789${GS}17270331${GS}10B2401`)).toEqual(fields);
    expect(readBoxCode(`${GS}01${GTIN}21ABC123456789${GS}17270331${GS}10B2401`)).toEqual(fields);
    expect(readBoxCode(`01${GTIN}21ABC1234567891727033110B2401`)).toEqual(fields);
    expect(readBoxCode(`01${GTIN}10B24011727033121ABC123456789`)).toEqual({ ...fields });
    expect(readBoxCode(` ]d201${GTIN}17270331${GS}10B2401\n`), "whitespace around a prefixed code").toEqual({ ...fields, serial: null });
  });

  it("finds a lost GS no further than a serial can run, and never before its first character", () => {
    const twenty = "S".repeat(20);
    expect(readBoxCode(`01${GTIN}21${twenty}17270331`)).toEqual({ gtin: GTIN, expiresOn: "2027-03-31", lot: null, serial: twenty });
    // The rest reads as an expiry, but a serial is never empty: it is the serial.
    expect(readBoxCode(`01${GTIN}2117270331`)).toEqual({ gtin: GTIN, expiresOn: null, lot: null, serial: "17270331" });
    expect(readBoxCode(`01${GTIN}21AB]C1D${GS}17270331`)?.serial, "a bracket inside is no symbology prefix").toBe("AB]C1D");
  });

  it("holds a lot and a serial of twenty characters, GS1's longest", () => {
    const lot = "L".repeat(20);
    const serial = "S".repeat(20);
    expect(readBoxCode(`01${GTIN}10${lot}${GS}21${serial}`)).toEqual({ gtin: GTIN, expiresOn: null, lot, serial });
  });

  it("takes day 00 as the month's last, February's in a leap year too", () => {
    expect(readBoxCode(`01${GTIN}17270400`)?.expiresOn).toBe("2027-04-30");
    expect(readBoxCode(`01${GTIN}17280200`)?.expiresOn).toBe("2028-02-29");
    expect(readBoxCode(`01${GTIN}17271231`)?.expiresOn).toBe("2027-12-31");
    expect(readBoxCode(`01${GTIN}17270105`)?.expiresOn).toBe("2027-01-05");
  });

  it("keeps what it read before a field it does not know", () => {
    expect(readBoxCode(`01${GTIN}17270331${GS}714123456`)).toEqual({ gtin: GTIN, expiresOn: "2027-03-31", lot: null, serial: null });
  });

  it("names nothing it did not carry", () => {
    expect(readBoxCode(`01${GTIN}`)).toEqual({ gtin: GTIN, expiresOn: null, lot: null, serial: null });
    expect(readBoxCode(`01${GTIN}21${GS}10L1`)).toEqual({ gtin: GTIN, expiresOn: null, lot: "L1", serial: null });
  });

  it("is refused when it cannot be trusted: no GTIN, a bad check digit, a day not on the calendar, a field too long or cut short", () => {
    for (const code of [
      `17270331${GS}10B2401`,
      `0108699546090113`,
      `01${GTIN}17271301`,
      `01${GTIN}17270015`,
      `01${GTIN}1727033X`,
      `01${GTIN}17X70331`,
      `01${GTIN}17270230`,
      `01${GTIN}1727033`,
      `01${GTIN}10${"L".repeat(21)}`,
      `01${GTIN}21${"S".repeat(21)}${GS}17270331`,
      "0108699546X90112",
      "https://example.invalid/kutu",
    ]) {
      expect(readBoxCode(code), code).toBeNull();
    }
  });
});

describe("a barcode", () => {
  it("is the GTIN alone", () => {
    expect(readBoxCode("8699546090112")).toEqual({ gtin: GTIN, expiresOn: null, lot: null, serial: null });
    expect(readBoxCode(" 8699546090112\n")).toEqual({ gtin: GTIN, expiresOn: null, lot: null, serial: null });
  });
});

describe("a typed amount", () => {
  it("is thousandths of the unit, with a comma or a point", () => {
    expect([parseAmount("20"), parseAmount("2,5"), parseAmount(" 2.25 "), parseAmount("0,001"), parseAmount("0")]).toEqual([20_000, 2500, 2250, 1, 0]);
    expect(parseAmount("1000000")).toBe(AMOUNT_MAX_MILLI);
  });

  it("is refused past three decimals, the ceiling, a sign or a word", () => {
    for (const text of ["2,5555", "1000000,001", "-1", "", "iki", "2,", ",5", "1 000"]) expect(parseAmount(text), text).toBeNull();
  });

  it("is written back as a person writes it", () => {
    expect([formatAmount(20_000), formatAmount(2500), formatAmount(2250), formatAmount(1), formatAmount(0)]).toEqual(["20", "2,5", "2,25", "0,001", "0"]);
  });
});

describe("a typed day", () => {
  it("is a month's last day for a month, and the day for a day", () => {
    expect(parseDay("03/2027")).toBe("2027-03-31");
    expect(parseDay("2.2028")).toBe("2028-02-29");
    expect(parseDay("31.03.2027")).toBe("2027-03-31");
    expect(parseDay("1/4/2027")).toBe("2027-04-01");
    expect(parseDay(" 2027-03 ")).toBe("2027-03-31");
    expect(parseDay("2027-03-15")).toBe("2027-03-15");
    expect([parseDay("01/2000"), parseDay("12/2099"), parseDay("01/2027")]).toEqual(["2000-01-31", "2099-12-31", "2027-01-31"]);
  });

  it("is refused off the calendar or out of the century", () => {
    for (const text of ["31.04.2027", "29.02.2027", "13/2027", "0/2027", "00.03.2027", "03/1999", "03/2100", "2027-3-1", "yarın", "", "x03/2027", "03/2027x", "x2027-03", "2027-03x"]) expect(parseDay(text), text).toBeNull();
  });

  it("is written back the Turkish way", () => {
    expect(formatDay("2027-03-31")).toBe("31.03.2027");
  });
});

describe("a box's expiry against today", () => {
  it("is today on the device's calendar, not UTC's", () => {
    expect(localDay(new Date(2027, 0, 5, 23, 59))).toBe("2027-01-05");
    expect(localDay(new Date(2027, 11, 31, 0, 1))).toBe("2027-12-31");
  });

  it("counts whole days across months and years", () => {
    expect([daysUntil("2027-03-01", "2027-02-28"), daysUntil("2027-01-01", "2026-12-31"), daysUntil("2027-01-01", "2027-01-02")]).toEqual([1, 1, -1]);
  });

  it("is still good on its last day, soon within thirty days, and unknown without one", () => {
    const today = "2027-03-01";
    expect([
      expiryState("2027-02-28", today),
      expiryState("2027-03-01", today),
      expiryState("2027-03-31", today),
      expiryState("2027-04-01", today),
      expiryState(null, today),
    ]).toEqual(["expired", "soon", "soon", "ok", "unknown"]);
    expect([expiryState("2027-03-08", today, 7), expiryState("2027-03-09", today, 7)], "a shorter notice").toEqual(["soon", "ok"]);
  });
});

describe("an opened box", () => {
  it("is good for its days counting the day it was opened, and its end is unknown until both are given", () => {
    expect([lastOpenDay("2027-01-01", 28), lastOpenDay("2027-02-20", 10), lastOpenDay("2028-02-28", 2), lastOpenDay("2027-01-01", 1)]).toEqual(["2027-01-28", "2027-03-01", "2028-02-29", "2027-01-01"]);
    expect([lastOpenDay(null, 28), lastOpenDay("2027-01-01", null)]).toEqual([null, null]);
  });

  it("takes its days as a whole number from one to ten years", () => {
    expect(["1", " 28 ", "3650"].map((typed) => parseDays(typed))).toEqual([1, 28, 3650]);
    expect([parseDays("365", WARN_DAYS_MAX), parseDays("366", WARN_DAYS_MAX)], "a notice ahead of an expiry is a year at most").toEqual([365, null]);
    expect(["0", "3651", "2,5", "-3", "28 gün", "", "12345", "1e3", "0x1C"].map((typed) => parseDays(typed))).toEqual([null, null, null, null, null, null, null, null, null]);
  });

  it("ends at the nearer of its printed day and its opened days, with a week's notice for the opened ones", () => {
    const today = "2027-03-01";
    const box = (expiresOn: string | null, openedOn: string | null, useWithinDays: number | null) => boxExpiry({ expiresOn, soonDays: null, openedOn, useWithinDays }, today);
    expect([
      box("2028-01-31", "2027-02-01", 28),
      box("2028-01-31", "2027-02-23", 14),
      box("2028-01-31", "2027-02-24", 14),
      box("2027-02-28", "2027-02-23", 14),
      box("2027-03-15", "2027-02-01", 365),
      box(null, "2027-02-01", 365),
      box(null, null, null),
      box("2028-01-31", null, 28),
    ]).toEqual(["expired", "soon", "ok", "expired", "soon", "ok", "unknown", "ok"]);
  });

  it("is near its expiry as many days ahead as it, or its owner, was given", () => {
    const today = "2027-03-01";
    const soon = (expiresOn: string, soonDays: number | null) => boxExpiry({ expiresOn, soonDays, openedOn: null, useWithinDays: null }, today);
    expect([soon("2027-03-31", null), soon("2027-04-01", null), soon("2027-05-30", 90), soon("2027-05-31", 90), soon("2027-03-08", 7), soon("2027-03-09", 7)]).toEqual(["soon", "ok", "soon", "ok", "soon", "ok"]);
  });
});

describe("the cabinet's views of a box", () => {
  const today = "2027-03-01";
  const box = (facts: Partial<BoxFacts>): BoxFacts => ({ expiresOn: "2028-01-31", soonDays: null, openedOn: null, useWithinDays: null, lowMilli: null, remainingMilli: 10_000, counted: true, disposition: null, ...facts });
  const views = (facts: Partial<BoxFacts>) => BOX_VIEWS.filter((view) => inView(view, box(facts), today));

  it("reads open, empty, low, near and past its end, and undated from what the box holds and its days", () => {
    expect(views({})).toEqual(["home", "unopened"]);
    expect(views({ openedOn: "2027-02-01" })).toEqual(["home", "open"]);
    expect(views({ openedOn: "2027-02-01", remainingMilli: 0 }), "an empty box is not open").toEqual(["home", "empty"]);
    expect(views({ remainingMilli: 0, counted: false }), "nor is one never counted empty").toEqual(["home", "unopened"]);
    expect(views({ lowMilli: 10_000 }), "low at its threshold").toEqual(["home", "unopened", "low"]);
    expect(views({ lowMilli: 9_999 })).toEqual(["home", "unopened"]);
    expect(views({ lowMilli: 10_000, remainingMilli: 0 }), "an empty box is empty, not low").toEqual(["home", "unopened", "empty"]);
    expect(views({ lowMilli: 10_000, counted: false }), "nor low uncounted").toEqual(["home", "unopened"]);
    expect(views({ expiresOn: "2027-02-28" })).toEqual(["home", "unopened", "expired"]);
    expect(views({ openedOn: "2027-01-01", useWithinDays: 28 }), "or expired once opened too long").toEqual(["home", "open", "expired"]);
    expect(views({ expiresOn: "2027-03-31" })).toEqual(["home", "unopened", "soon"]);
    expect(views({ expiresOn: "2028-01-31", openedOn: "2027-02-20", useWithinDays: 14 }), "or near its end once opened").toEqual(["home", "open", "soon"]);
    expect(views({ expiresOn: null }), "undated: no printed day, opened or not").toEqual(["home", "unopened", "undated"]);
    expect(views({ expiresOn: null, openedOn: "2027-01-01", useWithinDays: 28 })).toEqual(["home", "open", "expired", "undated"]);
  });

  it("keeps a box that left the cabinet out of every view but its own", () => {
    for (const disposition of ["lost", "disposed", "archived"]) expect(views({ disposition, expiresOn: "2027-02-28", remainingMilli: 0 }), disposition).toEqual(["gone"]);
  });
});

describe("searching the cabinet", () => {
  it("folds case and Turkish letters, and finds every word in any field, in any order", () => {
    expect(foldName("  İBUPROFEN   Şurup ")).toBe("ibuprofen surup");
    expect(foldName("IŞIK")).toBe("isik");
    const parol = ["Parol", "500 mg", "parasetamol", "Atabay", "08699546090112"];
    for (const query of ["parol", "PAROL 500", "500 parol", "parasetamol", "atabay", "8699546090112", ""]) expect(matchesSearch(parol, query), query).toBe(true);
    for (const query of ["aspirin", "parol 1000"]) expect(matchesSearch(parol, query), query).toBe(false);
    expect(matchesSearch(["Parol", null, undefined], "parol")).toBe(true);
    expect([matchesSearch(["Parol", null], "null"), matchesSearch(["Parol", "Atabay"], "parolatabay")], "a missing field or a field's edge is not text").toEqual([false, false]);
  });

  it("forgives one slip in a word of four letters or more", () => {
    const majezik = ["Majezik", "100 mg", "flurbiprofen"];
    for (const query of ["majezk", "majezikk", "mjaezik", "majesik", "majez", "majeik", "flurbi", "flrubi", "flurrbi", "mjae", "majez 100"]) expect(matchesSearch(majezik, query), query).toBe(true);
    for (const query of ["majzk", "mjzk", "mjz", "mja", "kezaj", "majezik 200"]) expect(matchesSearch(majezik, query), query).toBe(false);
    expect(TYPO_FROM).toBe(4);
    expect(matchesSearch(["Parol"], "paro"), "a word's start is no slip").toBe(true);
    expect(matchesSearch(["Parl"], "parol"), "one missing from the whole word").toBe(true);
    expect(matchesSearch(["Parolin"], "pxrol"), "one changed at the start's middle").toBe(true);
    expect(matchesSearch(["Ab"], "abcd"), "two past a short word").toBe(false);
  });

  it("knows one letter's slip from two", () => {
    for (const [a, b] of [["abcd", "abcd"], ["abcd", "abxd"], ["abcd", "abd"], ["abd", "abcd"], ["abcd", "bacd"], ["abcd", "abdc"], ["", "a"]]) expect(nearly(a!, b!), `${a} ${b}`).toBe(true);
    for (const [a, b] of [["abcd", "axyd"], ["abcd", "ab"], ["abcd", "badc"], ["abcd", "acbx"], ["abcd", "xbcda"], ["abcd", "abdcx"], ["abc", "bca"], ["abcd", "axbd"]]) expect(nearly(a!, b!), `${a} ${b}`).toBe(false);
  });
});

describe("sorting the cabinet", () => {
  const box = (id: string, fields: { expiresOn?: string; remainingMilli?: number; counted?: boolean; personId?: string } = {}) => ({
    id,
    expiresOn: fields.expiresOn ?? null,
    remainingMilli: fields.remainingMilli ?? 0,
    counted: fields.counted ?? false,
    personId: fields.personId ?? null,
  });
  const products = [
    { name: "Dolorex", boxes: [box("01e", { expiresOn: "2027-05-31", remainingMilli: 3000, counted: true, personId: "p-seyma" }), box("009", { remainingMilli: 4000, counted: true, personId: "p-suna" })] },
    { name: "Benical", boxes: [box("01c", { expiresOn: "2027-08-31", personId: "p-sungur" }), box("01d", { expiresOn: "2026-12-31", remainingMilli: 0, counted: true })] },
    { name: "Çinko", boxes: [box("01b")] },
    { name: "Ecopirin", boxes: [box("008", { personId: "p-zeynep" })] },
    { name: "Arveles", boxes: [box("01a", { expiresOn: "2027-05-31", remainingMilli: 9000, counted: true, personId: "p-sule" })] },
  ];
  // Turkish order puts S before Ş, which the root order reads as one letter.
  const names: Partial<Record<string, string>> = { "p-sule": "Şule", "p-sungur": "Sungur", "p-seyma": "Şeyma", "p-suna": "Suna", "p-zeynep": "Zeynep" };
  const order = (sort: ProductSort, given = products) => sortProducts(given, sort, (id) => (id ? names[id] : undefined)).map((product) => product.name);

  it("puts what is unknown last, and a tie by name", () => {
    expect(order("name"), "in Turkish order").toEqual(["Arveles", "Benical", "Çinko", "Dolorex", "Ecopirin"]);
    expect(order("expiry"), "a product's soonest box").toEqual(["Benical", "Arveles", "Dolorex", "Çinko", "Ecopirin"]);
    expect(order("added"), "a product's newest box").toEqual(["Dolorex", "Benical", "Çinko", "Arveles", "Ecopirin"]);
    expect(order("amount"), "what was counted, summed").toEqual(["Benical", "Dolorex", "Arveles", "Çinko", "Ecopirin"]);
    expect(order("owner"), "a product's first owner, in Turkish order").toEqual(["Dolorex", "Benical", "Arveles", "Ecopirin", "Çinko"]);
    expect(order("owner", [...products].reverse()), "whichever way they arrive").toEqual(["Dolorex", "Benical", "Arveles", "Ecopirin", "Çinko"]);
    expect(products.map((product) => product.name), "the list it was given").toEqual(["Dolorex", "Benical", "Çinko", "Ecopirin", "Arveles"]);
  });
});

describe("a catalogue name split into the form's fields", () => {
  const split = (listed: string) => Object.values(catalogueFields(listed));

  it("reads name, strength, form and pack as TİTCK writes them", () => {
    expect(split("PAROL 500 MG TABLET, 20 ADET")).toEqual(["Parol", "500 mg", "tablet", "20 adet"]);
    expect(split("ARVELES 50 MG/2 ML IM/IV ENJEKSİYONLUK ÇÖZELTİ, 10 AMPUL")).toEqual(["Arveles", "50 mg/2 ml", "im/iv enjeksiyonluk çözelti", "10 ampul"]);
    expect(split("MAJEZIK % 0.25 ORAL SPREY, ÇÖZELTİ, 30 ML"), "the last comma's").toEqual(["Majezik", "% 0.25", "oral sprey, çözelti", "30 ml"]);
    expect(split("Nimejel Plus %1+ %5 Jel, 50 G")).toEqual(["Nimejel Plus", "%1+ %5", "jel", "50 g"]);
    expect(split("PAROL-K 500 MG/10MG TABLET (20 TABLET)"), "a pack in parentheses").toEqual(["Parol-K", "500 mg/10mg", "tablet", "20 tablet"]);
    expect(split("PAROL 10 MG/ML INFUZYON SOLUSYONU"), "no pack").toEqual(["Parol", "10 mg/ml", "infuzyon solusyonu", null]);
  });

  it("lowers a Latin I to i, and capitalises each word of the name the Turkish way", () => {
    expect(split("ADVIL LIQUI-GELS 200 MG KAPSUL, 20 ADET")).toEqual(["Advil Liqui-Gels", "200 mg", "kapsul", "20 adet"]);
    expect(split("İBUPROFEN 400 MG FİLM TABLET, 20 TABLET")).toEqual(["İbuprofen", "400 mg", "film tablet", "20 tablet"]);
  });

  it("calls a number without a unit no strength, and leaves whole a name with no name before its number", () => {
    expect(split("PAROL HOT 12 POSET GRANUL")).toEqual(["Parol Hot", null, "12 poset granul", null]);
    expect(split("% 0,4 LIDODEKS İÇİNDE ÇÖZELTİ,  250 ML")).toEqual(["% 0,4 Lidodeks İçinde Çözelti", null, null, "250 ml"]);
    expect(split("BEPANTHEN KREM")).toEqual(["Bepanthen Krem", null, null, null]);
    expect(split("ASPIRIN 100 MG")).toEqual(["Aspirin", "100 mg", null, null]);
  });

  it("reads past stray spaces, a pack's own and a bracket's with none before it, and a form that begins like a unit", () => {
    expect(split("  PAROL  500 MG   TABLET , 20 ADET ")).toEqual(["Parol", "500 mg", "tablet", "20 adet"]);
    expect(split("PAROL 500 MG TABLET( 20 TABLET )")).toEqual(["Parol", "500 mg", "tablet", "20 tablet"]);
    expect(split("KLORHEKSIDIN %0,2 GARGARA, 200 ML"), "G is a unit, GARGARA is not").toEqual(["Klorheksidin", "%0,2", "gargara", "200 ml"]);
    expect(split("VITAMIN D3 1000 IU DAMLA, 50 ML"), "a digit inside the name").toEqual(["Vitamin D3", "1000 iu", "damla", "50 ml"]);
  });

  it("takes a bare number after the unit, before the form, as the pack's count", () => {
    expect(split("ACYL 200 MG 25 TABLET")).toEqual(["Acyl", "200 mg", "tablet", "25 tablet"]);
    expect(split("ADRENALIN BIOFARMA 1 MG/1 ML 100 AMPUL")).toEqual(["Adrenalin Biofarma", "1 mg/1 ml", "ampul", "100 ampul"]);
    expect(split("ACYL 200 MG 25 TABLET, 25 ADET"), "a written pack wins").toEqual(["Acyl", "200 mg", "tablet", "25 adet"]);
    expect(split("VITAMIN 10 MG 20"), "a count with no form after it").toEqual(["Vitamin", "10 mg", null, "20"]);
    expect(split("AUGMENTIN 500 MG + 125 MG TABLET"), "after a plus it is a strength").toEqual(["Augmentin", "500 mg + 125 mg", "tablet", null]);
    expect(split("ACYL 200 MG X25 TABLET"), "a number with a letter before it is not a count").toEqual(["Acyl", "200 mg", "x25 tablet", null]);
    expect(split("ACYL 200 MG 25X TABLET"), "nor with a letter after it").toEqual(["Acyl", "200 mg", "25x tablet", null]);
    expect(split("ZOLED 4 MG 5 ML FLAKON"), "before a unit it is a strength").toEqual(["Zoled", "4 mg 5 ml", "flakon", null]);
  });
});
