/**
 * Durum's cards (`docs/TASKS.md` F1.26): the order and the hidden set this
 * device keeps, read back whatever was stored, and the filter a card hands
 * Dolabım, taken once.
 */

import { describe, expect, it, vi } from "vitest";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("expo-router", () => ({ router: { navigate: (to: string) => void navigated.push(to) } }));
vi.mock("../../src/services/kv", () => {
  const stored = new Map<string, string>();
  return { kv: { get: async (key: string) => stored.get(key) ?? null, set: async (key: string, value: string) => void stored.set(key, value) } };
});

const { DEFAULT_HIDDEN, STATUS_CARDS, layoutFrom, moveCard, readCardLayout, saveCardLayout } = await import("../../src/ui/status-cards");
const { openCabinet, takeCabinetFilter } = await import("../../src/ui/cabinet-link");

describe("the card layout", () => {
  it("is every card in the default order, the four that ask for something shown, until one is stored or when what is stored cannot be read", async () => {
    const all = { order: [...STATUS_CARDS], hidden: [...DEFAULT_HIDDEN] };
    expect(STATUS_CARDS.filter((card) => !DEFAULT_HIDDEN.includes(card))).toEqual(["doses", "lists", "expired", "soon"]);
    for (const stored of [null, "", "not json", "null", "5", JSON.stringify({ order: "lists", hidden: {} })]) expect(layoutFrom(stored), String(stored)).toEqual(all);
    expect(await readCardLayout()).toEqual(all);
  });

  it("keeps what was saved, drops an unknown or repeated card, and adds a card this build brought at the end, shown", async () => {
    const saved = { order: ["recent", "lists", "recent", "weather", 3], hidden: ["people", "people", "weather"] };
    expect(layoutFrom(JSON.stringify(saved))).toEqual({ order: ["recent", "lists", ...STATUS_CARDS.filter((card) => card !== "recent" && card !== "lists")], hidden: ["people"] });
    const layout = { order: [...STATUS_CARDS].reverse(), hidden: ["boxes" as const] };
    await saveCardLayout(layout);
    expect(await readCardLayout()).toEqual(layout);
  });

  it("moves a card one place, and leaves it at either end", () => {
    const order = ["lists", "expired", "soon"] as const;
    expect(moveCard(order, "expired", -1)).toEqual(["expired", "lists", "soon"]);
    expect(moveCard(order, "expired", 1)).toEqual(["lists", "soon", "expired"]);
    expect(moveCard(order, "lists", -1)).toEqual(order);
    expect(moveCard(order, "soon", 1)).toEqual(order);
  });
});

describe("a card's way into Dolabım", () => {
  it("hands over its filter once, everyone's boxes at home unless it says otherwise", () => {
    expect(takeCabinetFilter(), "opened by its tab").toBeNull();
    openCabinet({ view: "expired" });
    expect(navigated).toEqual(["/cabinet"]);
    expect(takeCabinetFilter()).toEqual({ view: "expired", person: null });
    expect(takeCabinetFilter()).toBeNull();
    openCabinet({ person: "p" });
    expect(takeCabinetFilter()).toEqual({ view: "home", person: "p" });
  });
});
