/**
 * Dose plans and their answers on the device (`docs/TASKS.md` F3.7, F3.8). A
 * plan is in its product's cabinet, so the household reads a plan of the
 * household's medicine; an answer is in its plan's. A dose taken from a plan
 * that names a live box comes out of that box as a move, in the same write,
 * and goes back into it when the answer changes.
 */

import { uuidv7 } from "uuidv7";
import { getSqliteAsync } from "../db/client";
import { deterministicId, naturalKeys } from "../db/ids";
import { deleteRows, editRow, findRow, fromDbShape, nowIso, writeRows, writeUndoable, type RowSnapshot, type RowsWritten, type RowWrite } from "../db/mutations";
import type { DoseStatus, PackageUnit } from "../db/schema";
import { isTime, SNOOZE_MINUTES, TIMES_MAX, type DoseAnswer, type PlanFacts } from "../domain/doses";
import { inLiveCabinet } from "./cabinet";

export interface DosePlanFields {
  productId: string;
  packageId: string | null;
  personId: string | null;
  amountMilli: number;
  times: readonly string[];
  weekdays: number;
  startsOn: string;
  endsOn: string | null;
  instructions: string | null;
}

export interface CabinetDosePlan extends PlanFacts {
  cabinetId: string;
  productId: string;
  packageId: string | null;
  personId: string | null;
  amountMilli: number;
  instructions: string | null;
  createdBy: string | null;
  /** Its product's, for the words. */
  name: string;
  strength: string | null;
  /** Its box's, while the box is live: a box gone takes nothing from a dose. */
  nickname: string | null;
  unit: PackageUnit | null;
}

/** The times as a plan keeps them: each a time of day, once, earliest first; anything else is refused. */
function storedTimes(times: readonly string[]): string {
  const kept = [...new Set(times)].sort();
  if (kept.length === 0 || kept.length > TIMES_MAX || !kept.every(isTime)) throw new Error("Not a plan's times");
  return JSON.stringify(kept);
}

/** Add a plan in its product's cabinet; its new id. */
export async function addDosePlan(fields: DosePlanFields): Promise<string> {
  const id = uuidv7();
  await writeRows(async () => {
    const product = await findRow("products", fields.productId);
    if (!product || product.deleted_at != null) throw new Error("No such product");
    return [{ table: "dose_plans", row: { id, cabinetId: String(product.cabinet_id), ...fields, times: storedTimes(fields.times), paused: false, createdBy: null } }];
  });
  return id;
}

/** Change a plan, pause it or take it up again; one write an undo takes back. */
export async function editDosePlan(id: string, patch: Partial<Omit<DosePlanFields, "productId">> & { paused?: boolean }): Promise<RowsWritten> {
  return writeUndoable(async () => {
    const there = await findRow("dose_plans", id);
    if (!there || there.deleted_at != null) return [];
    return editRow("dose_plans", there, patch.times ? { ...patch, times: storedTimes(patch.times) } : patch);
  });
}

export const deleteDosePlans = (ids: readonly string[]) => deleteRows("dose_plans", ids);

/** The plan's box, while it is live and counted: a box nobody counted has no stock to take from, and a move would make its first count a dose short. */
async function countedBox(packageId: string): Promise<RowSnapshot | null> {
  const box = await findRow("packages", packageId);
  if (!box || box.deleted_at != null) return null;
  const sqlite = await getSqliteAsync();
  return (await sqlite.getFirstAsync("SELECT 1 FROM package_moves WHERE package_id = ? AND deleted_at IS NULL LIMIT 1", [packageId])) ? box : null;
}

/**
 * The move a dose answered `taken` holds, and the writes that leave it the
 * only one: its id is the dose's and the box's, so two devices saying "taken"
 * offline write one move, where an id of each device's own took it twice.
 * Whatever move the dose held that is not the one wanted now goes: answered
 * otherwise, or its box changed.
 */
async function doseMove(plan: RowSnapshot, dose: { dueOn: string; dueTime: string }, held: string | null, taken: boolean): Promise<{ moveId: string | null; writes: RowWrite[] }> {
  const packageId = (plan.package_id as string | null) ?? null;
  const key = packageId ? await deterministicId(naturalKeys.doseMove(String(plan.id), dose.dueOn, dose.dueTime, packageId)) : null;
  const box = taken && packageId ? await countedBox(packageId) : null;
  const moveId = box ? key : null;
  const writes: RowWrite[] = [];
  for (const id of new Set([held, key])) {
    const move = id && id !== moveId ? await findRow("package_moves", id) : null;
    if (move && move.deleted_at == null) writes.push({ table: "package_moves", row: { ...fromDbShape("package_moves", move), deletedAt: nowIso() } });
  }
  if (box && moveId) {
    const move = await findRow("package_moves", moveId);
    const quantityMilli = -Number(plan.amount_milli);
    if (!move) writes.push({ table: "package_moves", row: { id: moveId, cabinetId: String(box.cabinet_id), packageId: box.id, quantityMilli, reason: "use", createdBy: null } });
    else if (move.deleted_at != null) writes.push(...editRow("package_moves", move, { deletedAt: null, quantityMilli }));
  }
  return { moveId, writes };
}

/**
 * Answer a dose, or with `null` take the answer back. Taken, a plan naming a
 * live, counted box takes one dose out of it; answered otherwise afterwards,
 * the move goes. Put off, it is said again `SNOOZE_MINUTES` from `now`. One
 * write an undo takes back; nothing for a plan that is gone.
 */
export async function answerDose(planId: string, dose: { dueOn: string; dueTime: string }, status: DoseStatus | null, now = new Date()): Promise<RowsWritten> {
  const id = await deterministicId(naturalKeys.doseLog(planId, dose.dueOn, dose.dueTime));
  return writeUndoable(async () => {
    const plan = await findRow("dose_plans", planId);
    if (!plan || plan.deleted_at != null) return [];
    const there = await findRow("dose_logs", id);
    const live = there?.deleted_at == null ? there : null;
    const { moveId, writes } = await doseMove(plan, dose, (live?.move_id as string | null | undefined) ?? null, status === "taken");
    if (status == null) {
      if (live) writes.push({ table: "dose_logs", row: { ...fromDbShape("dose_logs", live), moveId: null, deletedAt: nowIso() } });
      return writes;
    }
    const snoozedUntil = status === "snoozed" ? new Date(now.getTime() + SNOOZE_MINUTES * 60_000).toISOString() : null;
    const row = { id, cabinetId: String(plan.cabinet_id), planId, dueOn: dose.dueOn, dueTime: dose.dueTime, status, snoozedUntil, moveId, deletedAt: null };
    writes.push(...(there ? editRow("dose_logs", there, row) : [{ table: "dose_logs" as const, row: { ...row, answeredBy: null } }]));
    return writes;
  });
}

/** Every live plan on the device, by its medicine's name. */
export async function readDosePlans(): Promise<CabinetDosePlan[]> {
  const sqlite = await getSqliteAsync();
  const rows = await sqlite.getAllAsync<Record<string, unknown>>(
    `SELECT d.*, p.name AS name, p.strength AS strength, b.nickname AS nickname, b.unit AS unit
       FROM dose_plans d
       JOIN products p ON p.id = d.product_id
       LEFT JOIN packages b ON b.id = d.package_id AND b.deleted_at IS NULL
      WHERE d.deleted_at IS NULL AND ${inLiveCabinet("d.cabinet_id")}
      ORDER BY p.name, d.created_at`,
  );
  return rows.map((row) => {
    const { name, strength, nickname, unit, ...plan } = row;
    return { ...(fromDbShape("dose_plans", plan) as unknown as Omit<CabinetDosePlan, "name" | "strength" | "nickname" | "unit">), name: String(name), strength: (strength as string | null) ?? null, nickname: (nickname as string | null) ?? null, unit: (unit as PackageUnit | null) ?? null };
  });
}

/** An answer as the calendar reads it, with its plan's medicine and person: a plan deleted since keeps its answers' names. */
export interface ReadDoseAnswer extends DoseAnswer {
  answeredBy: string | null;
  cabinetId: string;
  name: string | null;
  personId: string | null;
}

/** The live answers to doses due from one local day to another, both included. */
export async function readDoseAnswers(from: string, to: string): Promise<ReadDoseAnswer[]> {
  const sqlite = await getSqliteAsync();
  return sqlite.getAllAsync(
    `SELECT l.plan_id AS planId, l.due_on AS dueOn, l.due_time AS dueTime, l.status, l.snoozed_until AS snoozedUntil, l.answered_by AS answeredBy,
            l.cabinet_id AS cabinetId, p.name AS name, d.person_id AS personId
       FROM dose_logs l
       LEFT JOIN dose_plans d ON d.id = l.plan_id
       LEFT JOIN products p ON p.id = d.product_id
      WHERE l.deleted_at IS NULL AND l.due_on BETWEEN ? AND ? AND ${inLiveCabinet("l.cabinet_id")}`,
    [from, to],
  );
}
