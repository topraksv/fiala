/**
 * Dose plans and answers over the real write layer (`src/data/doses.ts`): a
 * plan lives where its medicine does, an answer is one row per dose, and a
 * dose taken from a box comes out of it until the answer changes.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("../../src/db/client", async () => {
  const { sqliteClientMock } = await import("../helpers");
  return sqliteClientMock(() => harness.db!);
});

vi.mock("expo-crypto", async () => (await import("../helpers")).expoCryptoMock);

const { addDosePlan, answerDose, deleteDosePlans, editDosePlan, readDoseAnswers, readDosePlans } = await import("../../src/data/doses");
const { addPackage, moveBox, openHousehold } = await import("../../src/data/cabinet");
const { deleteRows, undoRows } = await import("../../src/db/mutations");
const { migratedDatabase } = await import("../helpers");

const all = (sql: string) => harness.db!.prepare(sql).all() as Record<string, unknown>[];
const held = (box: string) => Number(all(`SELECT COALESCE(SUM(quantity_milli), 0) AS n FROM package_moves WHERE package_id = '${box}' AND deleted_at IS NULL`)[0]!.n);
const DOSE = { dueOn: "2026-10-20", dueTime: "08:00" };

async function boxAndPlan(withBox = true) {
  const box = await addPackage("me", { name: "Coraspin", strength: "100 mg" }, { unit: "tablet" }, 30_000);
  const productId = String(all("SELECT product_id FROM packages")[0]!.product_id);
  const plan = await addDosePlan({ productId, packageId: withBox ? box : null, personId: null, amountMilli: 1000, times: ["20:00", "08:00"], weekdays: 127, startsOn: "2026-10-19", endsOn: null, instructions: "Tok karnına" });
  return { box, productId, plan };
}

beforeEach(() => {
  harness.db = migratedDatabase();
});

describe("a dose plan", () => {
  it("is kept in its medicine's cabinet with its times once each, earliest first, and read with its box", async () => {
    const { box, productId, plan } = await boxAndPlan();
    expect(all("SELECT cabinet_id, times, paused FROM dose_plans")).toEqual([{ cabinet_id: "me", times: '["08:00","20:00"]', paused: 0 }]);
    expect(await readDosePlans()).toEqual([
      expect.objectContaining({ id: plan, productId, packageId: box, name: "Coraspin", strength: "100 mg", nickname: null, unit: "tablet", instructions: "Tok karnına", paused: false, createdBy: null }),
    ]);
    await deleteRows("packages", [box]);
    expect((await readDosePlans())[0]!.unit, "a box gone names no unit").toBeNull();
  });

  it("refuses times that are none, too many or not times of day, and a medicine that is gone", async () => {
    const { productId } = await boxAndPlan();
    const fields = { productId, packageId: null, personId: null, amountMilli: 1000, weekdays: 127, startsOn: "2026-10-19", endsOn: null, instructions: null };
    for (const times of [[], ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"], ["8:00"], ["08:00", "8:00"]]) {
      await expect(addDosePlan({ ...fields, times })).rejects.toThrow("Not a plan's times");
    }
    await expect(addDosePlan({ ...fields, times: Array(9).fill("08:00") as string[] }), "the same time nine times is one").resolves.toBeTruthy();
    await expect(addDosePlan({ ...fields, times: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"] }), "eight is the most").resolves.toBeTruthy();
    await expect(addDosePlan({ ...fields, productId: "0190c000-0000-7000-8000-000000000000", times: ["08:00"] })).rejects.toThrow("No such product");
    await deleteRows("products", [productId]);
    await expect(addDosePlan({ ...fields, times: ["08:00"] })).rejects.toThrow("No such product");
  });

  it("is edited, paused and taken up again, each undone, and nothing reaches a deleted one", async () => {
    const { plan } = await boxAndPlan();
    await editDosePlan(plan, { times: ["21:00", "07:30"], instructions: null });
    expect(all("SELECT times, instructions FROM dose_plans")).toEqual([{ times: '["07:30","21:00"]', instructions: null }]);
    const paused = await editDosePlan(plan, { paused: true });
    expect((await readDosePlans())[0]!.paused).toBe(true);
    await undoRows(paused);
    expect((await readDosePlans())[0]!.paused).toBe(false);
    const deleted = (await deleteDosePlans([plan]))!;
    expect(await readDosePlans()).toEqual([]);
    expect((await editDosePlan(plan, { paused: true })).writes).toEqual([]);
    await undoRows(deleted);
    expect(await readDosePlans()).toHaveLength(1);
  });

  it("takes its doses from the box where the box went", async () => {
    const { box, plan } = await boxAndPlan();
    const house = await openHousehold("me", "Ev");
    const { id: moved, written } = (await moveBox(box, house))!;
    expect((await readDosePlans())[0]).toMatchObject({ id: plan, packageId: moved, cabinetId: "me" });
    await answerDose(plan, DOSE, "taken");
    expect(held(moved)).toBe(29_000);
    expect(all("SELECT cabinet_id FROM package_moves WHERE quantity_milli = -1000"), "the move is the box's cabinet's").toEqual([{ cabinet_id: house }]);
    await undoRows((await answerDose(plan, DOSE, null)));
    await answerDose(plan, DOSE, null);
    await undoRows(written);
    expect((await readDosePlans())[0]!.packageId).toBe(box);
  });
});

describe("a dose's answer", () => {
  it("takes a dose out of the plan's box, puts it back when it was not taken after all, and is one row however often it is given", async () => {
    const { box, plan } = await boxAndPlan();
    await answerDose(plan, DOSE, "taken");
    await answerDose(plan, DOSE, "taken");
    expect(held(box), "taken twice is one dose").toBe(29_000);
    const evening = await answerDose(plan, { ...DOSE, dueTime: "20:00" }, "taken");
    expect([held(box), all("SELECT COUNT(*) AS n FROM dose_logs")[0]!.n], "another dose is its own answer and its own move").toEqual([28_000, 2]);
    await undoRows(evening);
    await answerDose(plan, DOSE, "skipped");
    expect(held(box)).toBe(30_000);
    await answerDose(plan, DOSE, "taken");
    expect(held(box)).toBe(29_000);
    expect(all("SELECT plan_id, due_on, due_time, status, cabinet_id, answered_by FROM dose_logs WHERE deleted_at IS NULL")).toEqual([
      { plan_id: plan, due_on: "2026-10-20", due_time: "08:00", status: "taken", cabinet_id: "me", answered_by: null },
    ]);
    await answerDose(plan, DOSE, null);
    expect(held(box)).toBe(30_000);
    expect(await readDoseAnswers("2026-10-20", "2026-10-20"), "taken back, it is no answer").toEqual([]);
    await answerDose(plan, DOSE, "missed");
    expect(await readDoseAnswers("2026-10-20", "2026-10-20")).toEqual([{ planId: plan, ...DOSE, status: "missed", snoozedUntil: null, answeredBy: null, cabinetId: "me", name: "Coraspin", personId: null }]);
  });

  it("is undone whole, the box's dose with it", async () => {
    const { box, plan } = await boxAndPlan();
    const taken = await answerDose(plan, DOSE, "taken");
    const skipped = await answerDose(plan, DOSE, "skipped");
    await undoRows(skipped);
    expect(held(box)).toBe(29_000);
    expect(all("SELECT status FROM dose_logs")).toEqual([{ status: "taken" }]);
    await undoRows(taken);
    expect(held(box)).toBe(30_000);
    expect(await readDoseAnswers("2026-10-19", "2026-10-21")).toEqual([]);
  });

  it("is put off for half an hour, and takes nothing from a plan with no box, a box gone or a box nobody counted", async () => {
    const { box, plan } = await boxAndPlan(false);
    await answerDose(plan, DOSE, "snoozed", new Date("2026-10-20T05:00:00.000Z"));
    expect(all("SELECT status, snoozed_until FROM dose_logs")).toEqual([{ status: "snoozed", snoozed_until: "2026-10-20T05:30:00.000Z" }]);
    await answerDose(plan, DOSE, "taken");
    expect(all("SELECT status, snoozed_until, move_id FROM dose_logs")).toEqual([{ status: "taken", snoozed_until: null, move_id: null }]);
    expect(held(box)).toBe(30_000);
    const { plan: boxed, box: gone } = await boxAndPlan();
    await deleteRows("packages", [gone]);
    await answerDose(boxed, DOSE, "taken");
    const uncounted = await addPackage("me", { id: String(all(`SELECT product_id FROM packages WHERE id = '${gone}'`)[0]!.product_id) }, { unit: "tablet" }, 0);
    await editDosePlan(boxed, { packageId: uncounted });
    await answerDose(boxed, { ...DOSE, dueTime: "20:00" }, "taken");
    expect(all("SELECT COUNT(*) AS n FROM package_moves WHERE quantity_milli < 0")).toEqual([{ n: 0 }]);
  });

  it("is not given to a plan that is gone, and a day's answers are read by the days asked", async () => {
    const { plan } = await boxAndPlan(false);
    await answerDose(plan, { dueOn: "2026-10-19", dueTime: "20:00" }, "taken");
    await answerDose(plan, { dueOn: "2026-10-22", dueTime: "08:00" }, "skipped");
    expect((await readDoseAnswers("2026-10-20", "2026-10-22")).map((each) => each.dueOn)).toEqual(["2026-10-22"]);
    await deleteDosePlans([plan]);
    expect((await readDoseAnswers("2026-10-22", "2026-10-22"))[0], "a plan deleted keeps its answers, and their names").toMatchObject({ name: "Coraspin", status: "skipped" });
    expect((await answerDose(plan, DOSE, "taken")).writes).toEqual([]);
    expect((await answerDose("0190c000-0000-7000-8000-000000000000", DOSE, "taken")).writes).toEqual([]);
  });
});
