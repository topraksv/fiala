import { describe, expect, it } from "vitest";

import { isEmail } from "../../src/domain/names";

describe("an address a form will send", () => {
  it("is anything with a name, an @ and a dotted domain, spaces around it forgiven", () => {
    expect(isEmail(" ayse@ev.com ")).toBe(true);
    // The pattern `send-feedback` holds a signed-out address to, so a slip is caught before a send is spent.
    for (const typed of ["", "ayse", "ayse@", "ayse@ev", "@ev.com", "ayse@ev.", "ay se@ev.com", "x y@ev.com", "ayse@ev.com x", "ay@se@ev.com", "\"ayse\"@ev.com", "<ayse>@ev.com", "ayse@e v.com", "ayse@ev.c om"]) {
      expect(isEmail(typed), typed).toBe(false);
    }
  });
});
