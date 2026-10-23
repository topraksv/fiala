import { describe, expect, it } from "vitest";

import { checkImportRow, IMPORT_MAX_ROWS, readImportFile, repeatedInFile, type ImportRaw } from "../../src/domain/import";

const UNITS = ["adet", "tablet", "kapsul", "ml", "doz", "tup"] as const;

describe("reading a file of boxes", () => {
  it("reads a Turkish spreadsheet's CSV: semicolons, a BOM, CRLF, headers in any case and order", () => {
    const file = readImportFile("﻿İlaç Adı;SKT;Miktar;Seri No.\r\nParol;03/2027;20;S1\r\n\r\nArveles;31.12.2026;2,5;\r\n");
    expect(file).toEqual({
      ok: true,
      rows: [
        { name: "Parol", expiresOn: "03/2027", amount: "20", serial: "S1" },
        { name: "Arveles", expiresOn: "31.12.2026", amount: "2,5" },
      ],
      ignored: [],
    });
  });

  it("reads commas and tabs, and quotes as a spreadsheet writes them", () => {
    expect(readImportFile('name,note\n"Parol, 500 mg","say ""two""\nat night"')).toEqual({
      ok: true,
      rows: [{ name: "Parol, 500 mg", note: 'say "two"\nat night' }],
      ignored: [],
    });
    expect(readImportFile("Ad\tBirim\nParol\ttablet")).toMatchObject({ ok: true, rows: [{ name: "Parol", unit: "tablet" }] });
    expect(readImportFile("Ad;Not,Renk\nParol;x"), "a tie is the semicolon's").toEqual({ ok: true, rows: [{ name: "Parol" }], ignored: ["Not,Renk"] });
    expect(readImportFile("Ad;SKT;Not\nParol\n ; ;\nArveles;03/2027"), "a short row, a row of nothing").toMatchObject({ ok: true, rows: [{ name: "Parol" }, { name: "Arveles", expiresOn: "03/2027" }] });
    expect(readImportFile("Ad")).toEqual({ ok: false, reason: "empty" });
  });

  it("names the headers it left out, and reads the first of a header given twice", () => {
    expect(readImportFile("Ad;Renk;; ;Ad\nParol;mavi;x;y;Arveles\n;;;;Majezik")).toEqual({
      ok: true,
      rows: [{ name: "Parol" }, { name: "Majezik" }],
      ignored: ["Renk"],
    });
  });

  it("reads a JSON list of objects, numbers as text", () => {
    expect(readImportFile(' [{"ad":"Parol","miktar":20,"x":true},{"name":"Arveles","barkod":8699546090112}]')).toEqual({
      ok: true,
      rows: [{ name: "Parol", amount: "20" }, { name: "Arveles", barcode: "8699546090112" }],
      ignored: ["x"],
    });
  });

  it("says why a file is no list of boxes", () => {
    expect(readImportFile("")).toEqual({ ok: false, reason: "empty" });
    expect(readImportFile("﻿  \n")).toEqual({ ok: false, reason: "empty" });
    expect(readImportFile(";;;\n;"), "separators alone").toEqual({ ok: false, reason: "empty" });
    expect(readImportFile("[{")).toEqual({ ok: false, reason: "unreadable" });
    expect(readImportFile('[{"ad":"Parol"}, 1]')).toEqual({ ok: false, reason: "unreadable" });
    expect(readImportFile('[{"ad":"Parol"}, null]')).toEqual({ ok: false, reason: "unreadable" });
    expect(readImportFile('[{"ad":"Parol"}, ["Parol"]]')).toEqual({ ok: false, reason: "unreadable" });
    expect(readImportFile("[]")).toEqual({ ok: false, reason: "noName" });
    expect(readImportFile("Marka;SKT\nAtabay;03/2027")).toEqual({ ok: false, reason: "noName" });
    expect(readImportFile(`Ad\n${"Parol\n".repeat(IMPORT_MAX_ROWS)}`)).toMatchObject({ ok: true });
    expect(readImportFile(`Ad\n${"Parol\n".repeat(IMPORT_MAX_ROWS + 1)}`)).toEqual({ ok: false, reason: "tooMany" });
  });
});

describe("a header", () => {
  it("is found by any of its spellings, Turkish letters, case and punctuation aside", () => {
    const spellings: Record<string, readonly string[]> = {
      name: ["Ad", "İlaç", "İlaç Adı", "Ürün", "Ürün adı", "name"],
      brand: ["Marka", "brand"],
      activeSubstance: ["Etken Madde", "Etkin madde", "substance", "Active substance"],
      strength: ["Güç", "strength"],
      form: ["Form"],
      pack: ["Ambalaj", "pack"],
      manufacturer: ["Üretici", "Ruhsat Sahibi", "manufacturer"],
      barcode: ["Barkod", "Karekod", "GTIN", "barcode"],
      unit: ["Birim", "unit"],
      expiresOn: ["SKT", "Son kullanma", "Son Kullanma Tarihi", "expiry"],
      openedOn: ["Açılma", "Açılma tarihi", "opened"],
      amount: ["Miktar", "Kalan", "amount", "quantity"],
      person: ["Kişi", "Sahip", "Kimin", "person", "owner"],
      place: ["Yer", "Konum", "place", "location"],
      serial: ["Seri", "Seri No.", "serial"],
      lot: ["Parti", "Parti no", "lot"],
      nickname: ["Takma ad", "nickname"],
      note: ["Not", "note"],
    };
    for (const [field, headers] of Object.entries(spellings)) {
      for (const header of headers) {
        const read = field === "name" ? readImportFile(`${header}\nParol`) : readImportFile(`Ad;${header}\nParol;x`);
        expect(read, header).toEqual({ ok: true, rows: [field === "name" ? { name: "Parol" } : { name: "Parol", [field]: "x" }], ignored: [] });
      }
    }
    expect(readImportFile("Ad;Adet\nParol;3"), "a unit names no column").toMatchObject({ ignored: ["Adet"] });
  });
});

describe("checking a row", () => {
  const full: ImportRaw = {
    name: " Parol ",
    brand: "Atabay",
    activeSubstance: "parasetamol",
    strength: "500 mg",
    form: "tablet",
    pack: "20 tablet",
    manufacturer: "Atabay",
    barcode: "8699546090112",
    unit: "Tablet",
    expiresOn: "03/2027",
    openedOn: "15.01.2026",
    amount: "12,5",
    person: "Zeynep",
    place: "Mutfak",
    serial: "S1",
    lot: "L1",
    nickname: "Benim",
    note: "Aç karnına",
  };

  it("makes a box of every field it is given", () => {
    expect(checkImportRow(full, UNITS)).toEqual({
      box: {
        product: { name: "Parol", brand: "Atabay", activeSubstance: "parasetamol", strength: "500 mg", form: "tablet", pack: "20 tablet", manufacturer: "Atabay", gtin: "08699546090112" },
        box: { unit: "tablet", expiresOn: "2027-03-31", openedOn: "2026-01-15", serial: "S1", lot: "L1", nickname: "Benim", note: "Aç karnına" },
        amountMilli: 12_500,
        person: "Zeynep",
        place: "Mutfak",
      },
      problems: [],
    });
  });

  it("leaves what is not given unknown: the first unit, nothing counted", () => {
    expect(checkImportRow({ name: "Parol", unit: " ", amount: "" }, UNITS)).toEqual({
      box: {
        product: { name: "Parol", brand: null, activeSubstance: null, strength: null, form: null, pack: null, manufacturer: null, gtin: null },
        box: { unit: "adet", expiresOn: null, openedOn: null, serial: null, lot: null, nickname: null, note: null },
        amountMilli: 0,
        person: null,
        place: null,
      },
      problems: [],
    });
    expect(checkImportRow({ name: "Parol", unit: "Kapsül" }, UNITS).box?.box.unit, "a unit is read with its Turkish letters").toBe("kapsul");
  });

  it("fills a karekod's expiry, lot and serial into the cells left empty", () => {
    const karekod = "010869954609011217270331" + "10B2401\u001d21ABC123";
    expect(checkImportRow({ name: "Parol", barcode: karekod }, UNITS).box?.box).toMatchObject({ expiresOn: "2027-03-31", lot: "B2401", serial: "ABC123" });
    expect(checkImportRow({ name: "Parol", barcode: karekod, expiresOn: "01/2028", lot: "X", serial: "Y" }, UNITS).box?.box).toMatchObject({ expiresOn: "2028-01-31", lot: "X", serial: "Y" });
  });

  it("names each field it cannot take, once", () => {
    expect(checkImportRow({ name: " ", barcode: "8,69955E+12", unit: "kutu", expiresOn: "13/2027", openedOn: "dün", amount: "-1" }, UNITS)).toEqual({
      box: null,
      problems: ["name", "barcode", "unit", "expiresOn", "openedOn", "amount"],
    });
    expect(checkImportRow({ name: "x".repeat(201) }, UNITS).problems).toEqual(["name"]);
    expect(checkImportRow({ name: "x".repeat(200), serial: "s".repeat(21), note: "n".repeat(2000) }, UNITS).problems).toEqual(["serial"]);
    for (const [field, longest] of [["brand", 200], ["activeSubstance", 500], ["strength", 100], ["form", 100], ["pack", 100], ["manufacturer", 200], ["person", 80], ["place", 80], ["lot", 20], ["nickname", 80], ["note", 2000]] as const) {
      expect(checkImportRow({ name: "Parol", [field]: "x".repeat(longest) }, UNITS).problems, field).toEqual([]);
      expect(checkImportRow({ name: "Parol", [field]: "x".repeat(longest + 1) }, UNITS).problems, field).toEqual([field]);
    }
  });
});

describe("a box named twice in one file", () => {
  it("is the later row, by GTIN and serial", () => {
    const box = (gtin: string | null, serial: string | null) => ({ product: { gtin }, box: { serial } }) as never;
    expect(repeatedInFile([box("1", "a"), box("1", "a"), box("1", "b"), box("2", "a"), null, box(null, "a"), box(null, "a"), box("1", null), box("1", null), box("1", "a")])).toEqual([
      false, true, false, false, false, false, false, false, false, true,
    ]);
  });
});
