/**
 * The last sign-in's device: named from a browser's agent, and chosen across every
 * device's own row, with this device's present session never counted.
 */

import { describe, expect, it } from "vitest";
import { LOGIN_KEY_PREFIX, deviceFromAgent, deviceLogins, deviceName, lastLogin } from "../../src/domain/logins";

const row = (device: string, login: unknown) => ({ key: LOGIN_KEY_PREFIX + device, value: JSON.stringify(login) });

describe("deviceFromAgent", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", "iPad · Chrome"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "Android · Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Mac · Safari"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "Windows · Edge"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OPR/115.0", "Windows · Opera"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Linux · Firefox"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15", "iPhone · Firefox"],
    ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 EdgA/130.0", "Android · Edge"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "ChromeOS · Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Mac · Chrome"],
  ])("names %s", (agent, device) => {
    expect(deviceFromAgent(agent)).toBe(device);
  });

  it("names what it can, and nothing from nothing", () => {
    expect(deviceFromAgent("SomeBot/1.0 (Windows)")).toBe("Windows");
    expect(deviceFromAgent("Safari/604.1")).toBe("Safari");
    expect(deviceFromAgent("curl/8.0")).toBeNull();
  });
});

describe("lastLogin", () => {

  it("is another device's latest sign-in when it came after this device's last", () => {
    const settings = [
      row("here", { at: "2026-09-27T10:00:00Z", previous: "2026-09-20T10:00:00Z", device: "Mac · Safari" }),
      row("phone", { at: "2026-09-25T08:00:00Z", previous: null, device: "iPhone · Safari" }),
      row("old", { at: "2026-09-01T08:00:00Z", previous: null, device: "Windows · Edge" }),
    ];
    expect(lastLogin(settings, "here")).toEqual({ at: "2026-09-25T08:00:00Z", device: "iPhone · Safari", here: false });
  });

  it("is this device's own sign-in before the present one, never the present one", () => {
    const settings = [
      row("here", { at: "2026-09-27T10:00:00Z", previous: "2026-09-26T10:00:00Z", device: "Mac · Safari" }),
      row("phone", { at: "2026-09-25T08:00:00Z", previous: null, device: null }),
    ];
    expect(lastLogin(settings, "here")).toEqual({ at: "2026-09-26T10:00:00Z", device: "Mac · Safari", here: true });
  });

  it("is nothing on the first sign-in anywhere, and ignores what is not a sign-in", () => {
    expect(lastLogin([row("here", { at: "2026-09-27T10:00:00Z", previous: null, device: "Mac" })], "here")).toBeNull();
    expect(lastLogin([{ key: "member_name", value: JSON.stringify({ at: "2026-09-27T10:00:00Z" }) }], "here")).toBeNull();
  });

  it("skips a row it cannot read rather than failing the screen", () => {
    const settings = [
      { key: LOGIN_KEY_PREFIX + "broken", value: "{" },
      { key: LOGIN_KEY_PREFIX + "null", value: "null" },
      row("dateless", { device: "Mac" }),
      row("bare", { at: "2026-09-24T08:00:00Z" }),
    ];
    expect(lastLogin(settings, "here")).toEqual({ at: "2026-09-24T08:00:00Z", device: null, here: false });
  });

  it("gives way to this device's memory while the rows lag it, and to the rows once they catch up", () => {
    const settings = [row("phone", { at: "2026-09-25T08:00:00Z", previous: null, device: "iPhone" })];
    expect(lastLogin(settings, "here", "2026-09-26T08:00:00Z")).toEqual({ at: "2026-09-26T08:00:00Z", device: null, here: false });
    expect(lastLogin(settings, "here", "2026-09-25T08:00:00Z")).toEqual({ at: "2026-09-25T08:00:00Z", device: "iPhone", here: false });
    expect(lastLogin(settings, null, "2026-09-20T08:00:00Z"), "before the device id is read").toEqual({ at: "2026-09-20T08:00:00Z", device: null, here: false });
    expect(lastLogin(settings, null)).toBeNull();
  });
});

describe("deviceLogins", () => {
  it("lists every device's own sign-in, newest first, this one's present session among them, and skips what it cannot read", () => {
    const settings = [
      row("phone", { at: "2026-09-25T08:00:00Z", previous: null, device: "iPhone" }),
      row("here", { at: "2026-09-26T08:00:00Z", previous: "2026-09-20T08:00:00Z", device: "Mac · Safari" }),
      row("old", { at: "2026-09-01T08:00:00Z", previous: null, device: null }),
      { key: LOGIN_KEY_PREFIX + "broken", value: "{" },
      { key: "account_frozen", value: "false" },
    ];
    expect(deviceLogins(settings, "here")).toEqual([
      { at: "2026-09-26T08:00:00Z", device: "Mac · Safari", here: true },
      { at: "2026-09-25T08:00:00Z", device: "iPhone", here: false },
      { at: "2026-09-01T08:00:00Z", device: null, here: false },
    ]);
    expect(deviceLogins(settings, null).some((login) => login.here), "before this device's id is read").toBe(false);
    expect(deviceLogins([], "here")).toEqual([]);
  });
});

describe("deviceName", () => {
  it("is the browser on the web, and the phone in the app", () => {
    const agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    expect(deviceName({ os: "web", isPad: false, agent })).toBe("Mac · Safari");
    expect(deviceName({ os: "web", isPad: false })).toBeNull();
    expect(deviceName({ os: "ios", isPad: false, agent })).toBe("iPhone");
    expect(deviceName({ os: "ios", isPad: true })).toBe("iPad");
    expect(deviceName({ os: "android", isPad: false, model: "Pixel 8" })).toBe("Android · Pixel 8");
    expect(deviceName({ os: "android", isPad: false })).toBe("Android");
  });
});
