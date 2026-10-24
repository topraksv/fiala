/**
 * The KVKK notice, held to what makes it real: it can be reached from every
 * screen that collects something, before an account exists, and it names
 * every party the code sends data to. The rest is prose, reviewed by reading.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { tr } from "../../src/i18n/tr";
import { OPEN_SOURCE } from "../../src/ui/open-source";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the privacy notice", () => {
  it("names a controller and a channel, with no placeholder left in either", () => {
    expect(tr.legal.controllerName.trim().length).toBeGreaterThan(3);
    expect(tr.legal.contactEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    for (const value of [tr.legal.controllerName, tr.legal.contactEmail]) expect(value).not.toMatch(/TODO|TBD|example\.com|placeholder/i);
  });

  it("is reachable from sign-up, from feedback and from Ayarlar", () => {
    for (const file of ["src/app/feedback.tsx", "src/app/(tabs)/settings.tsx"]) expect(read(file), file).toContain('"/privacy"');
    // Sign-up opens it over the form: a push would cost what was typed.
    expect(read("src/app/(auth)/sign-in.tsx")).toContain("<LegalNoticeSheet");
  });

  it("opens before an account exists", () => {
    const layout = read("src/app/_layout.tsx");
    const screen = layout.indexOf('<Stack.Screen name="privacy" />');
    expect(screen).toBeGreaterThan(-1);
    expect(layout.lastIndexOf("</Stack.Protected>", screen)).toBeGreaterThan(layout.lastIndexOf("<Stack.Protected", screen));
  });

  it("is one body in two frames, so the copy read before consent is the copy Ayarlar shows", () => {
    for (const file of ["src/app/privacy.tsx", "src/ui/legal-notice.tsx"]) expect(read(file), file).toContain("<LegalNoticeBody");
    expect(read("src/app/privacy.tsx")).not.toContain("tr.legal.");
  });

  it("holds sign-up until the notice is accepted at its end, and says why on the form", () => {
    const signIn = read("src/app/(auth)/sign-in.tsx");
    expect(signIn).toContain("tr.legal.signUpNotice");
    expect(signIn).toContain("<LegalConsentControl");
    // Consent belongs to the attempt: the form holds it, and a mode switch drops it.
    expect(signIn).toMatch(/useState\(false\)[\s\S]*consented/);
    expect(read("src/auth/session.ts")).not.toMatch(/consented/);
    const notice = read("src/ui/legal-notice.tsx");
    expect(notice.indexOf("tr.legal.consentLabel")).toBeGreaterThan(notice.indexOf("<LegalNoticeBody />"));
    expect(tr.legal.signUpNotice).toMatch(/hesap oluşturduğunda/i);
  });

  it("asks for health data apart from the notice, before the first box or document is written, and says how to take it back", () => {
    for (const [file, write] of [["src/app/add-box.tsx", "await addPackage("], ["src/app/add-document.tsx", "await addDocument("]]) {
      const form = read(file!);
      expect(form.indexOf("hasHealthConsent(")).toBeGreaterThan(-1);
      expect(form.indexOf("giveHealthConsent()")).toBeLessThan(form.indexOf(write!));
    }
    expect(tr.legal.purposes.find((purpose) => /sağlık verisi/.test(purpose))).toMatch(/KVKK m\. 6/);
    expect(tr.legal.selfService.join(" ")).toMatch(/rızayı geri almak[\s\S]*Verileri Sıfırla → Dolap/);
    expect(tr.addBox.consentBody).toMatch(/Verileri Sıfırla → Dolap/);
  });

  it("letters the Article 11 rights as the statute does", () => {
    expect(read("src/ui/legal-notice.tsx")).toContain('["a", "b", "c", "ç", "d", "e", "f", "g"]');
    expect(tr.legal.rights).toHaveLength(8);
  });

  /**
   * Each host the code reaches, and whom the notice names for it: a host added
   * to the web's policy or to a fetch fails here until the notice says who
   * receives what.
   */
  const DISCLOSED_AS: Record<string, string | null> = {
    // The web build's own address: the site itself.
    "topraksv.github.io": "GitHub Pages",
  };

  it("names every party the code sends data to, and where the store is", () => {
    const hosts = new Set<string>();
    for (const file of ["src/app/+html.tsx", "src/domain/web-security.ts"]) {
      for (const [, host] of read(file).matchAll(/https:\/\/([A-Za-z0-9.-]+\.[a-z]{2,})/g)) hosts.add(host!);
    }
    expect(hosts.size, "discovery stopped finding the URLs").toBeGreaterThanOrEqual(1);
    expect([...hosts].filter((host) => !(host in DISCLOSED_AS)), "a host with no decision recorded").toEqual([]);
    const transfers = tr.legal.transfers.join(" ");
    for (const name of [...Object.values(DISCLOSED_AS), "Supabase", "Gmail", "Expo"]) expect(transfers).toContain(name);
    expect(transfers).toMatch(/Frankfurt/);
  });

  it("gives every store an end", () => {
    const retention = tr.legal.retention.join(" ");
    for (const store of [/[Cc]ihaz/, /[Bb]ulut/, /[Gg]eri bildirim/]) expect(retention).toMatch(store);
  });

  it("carries every item Article 10 enumerates, numbered in order", () => {
    const titles = [
      tr.legal.controllerTitle,
      tr.legal.collectedTitle,
      tr.legal.methodTitle,
      tr.legal.purposeTitle,
      tr.legal.transferTitle,
      tr.legal.retentionTitle,
      tr.legal.rightsTitle,
      tr.legal.selfServiceTitle,
      tr.legal.contactTitle,
    ];
    expect(titles.map((title) => title.split(".")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const purpose of tr.legal.purposes) expect(purpose).toMatch(/Hukuki sebep: KVKK m\. [56]/);
    expect(tr.legal.methodBody).toMatch(/doğrudan sizden/);
    expect(tr.legal.transferNote).toMatch(/m\. 9/);
    expect(tr.legal.contactBody(tr.legal.contactEmail)).toMatch(/Kişisel Verileri Koruma Kurulu/);
  });
});

/**
 * Apple's declaration and the KVKK notice are
 * one set of facts in two files, the pair that drifts: a new collection lands
 * in one and the other becomes a false statement.
 */
describe("the privacy manifest", () => {
  const manifest = JSON.parse(read("app.json")).expo.ios.privacyManifests;

  it("declares no tracking, as an app with no analytics", () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
  });

  it("marks every collected type as linked, never tracking, for the app's own use", () => {
    // Every synced row carries the account id, so "not linked" would be false.
    for (const entry of manifest.NSPrivacyCollectedDataTypes) {
      expect(entry.NSPrivacyCollectedDataTypeLinked, entry.NSPrivacyCollectedDataType).toBe(true);
      expect(entry.NSPrivacyCollectedDataTypeTracking, entry.NSPrivacyCollectedDataType).toBe(false);
      expect(entry.NSPrivacyCollectedDataTypePurposes).toEqual(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]);
    }
  });

  it("declares the same collection the notice describes", () => {
    const declared = new Set<string>(manifest.NSPrivacyCollectedDataTypes.map((e: { NSPrivacyCollectedDataType: string }) => e.NSPrivacyCollectedDataType));
    const notice = tr.legal.collected.join(" ");
    for (const [type, described] of [
      ["NSPrivacyCollectedDataTypeEmailAddress", /E-posta adresiniz/],
      ["NSPrivacyCollectedDataTypeName", /görünen adınız/],
      ["NSPrivacyCollectedDataTypeOtherUserContent", /Ayar verisi/],
      ["NSPrivacyCollectedDataTypePhotosorVideos", /Görsel veri/],
      ["NSPrivacyCollectedDataTypeCustomerSupport", /[Gg]eri bildirim/],
      ["NSPrivacyCollectedDataTypeHealth", /Sağlık verisi/],
    ] as const) {
      expect(declared.has(type), `${type} must be declared to Apple`).toBe(true);
      expect(notice, `${type} must also be described in the notice`).toMatch(described);
    }
    expect(declared.size, "a type declared to Apple and not in Turkish would slip past the rows above").toBe(6);
  });

  it("declares only the required-reason API the app's own binary drives", () => {
    // The bundled libraries that touch these APIs ship their own manifests;
    // SQLite stats the database file and `expo-sqlite` carries none.
    expect(manifest.NSPrivacyAccessedAPITypes).toEqual([
      { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp", NSPrivacyAccessedAPITypeReasons: ["C617.1"] },
    ]);
  });
});

describe("Yardım's licence list", () => {
  it("names every dependency under the licence its package declares, and every bundled typeface under the OFL", () => {
    const { "SIL OFL 1.1": fonts, ...packages } = OPEN_SOURCE;
    const named = Object.entries(packages).flatMap(([licence, names]) => names.map((name) => [name, licence] as const));
    expect(named.map(([name]) => name).sort()).toEqual(Object.keys(JSON.parse(read("package.json")).dependencies).sort());
    for (const [name, licence] of named) expect(JSON.parse(read(`node_modules/${name}/package.json`)).license, name).toBe(licence);
    const ofl = readdirSync(join(root, "assets/fonts")).filter((file) => file.endsWith("-OFL.txt"));
    expect(fonts).toHaveLength(ofl.length);
    for (const file of ofl) expect(read(`assets/fonts/${file}`)).toContain("SIL Open Font License, Version 1.1");
  });
});
