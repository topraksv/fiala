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

/** Whether the person may change what is in a cabinet: the screens' `writes`. A move in a cabinet they only read would be refused, and wait as a dead letter. */
export type Writes = (cabinetId: string) => boolean;

const everywhere: Writes = () => true;

/** The plan's box, while it is live, counted and the person's to change: a box nobody counted has no stock to take from, and a move would make its first count a dose short. */
async function countedBox(packageId: string, writes: Writes): Promise<RowSnapshot | null> {
  const box = await findRow("packages", packageId);
  if (!box || box.deleted_at != null || !writes(String(box.cabinet_id))) return null;
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
async function doseMove(plan: RowSnapshot, dose: { dueOn: string; dueTime: string }, held: string | null, taken: boolean, may: Writes): Promise<{ moveId: string | null; writes: RowWrite[] }> {
  const key = await planMoveId(plan, dose);
  const packageId = (plan.package_id as string | null) ?? null;
  const box = taken && packageId ? await countedBox(packageId, may) : null;
  const moveId = box ? key : null;
  const writes: RowWrite[] = [];
  for (const id of new Set([held, key])) {
    const move = id && id !== moveId ? await findRow("package_moves", id) : null;
    if (move && move.deleted_at == null && may(String(move.cabinet_id))) writes.push({ table: "package_moves", row: { ...fromDbShape("package_moves", move), deletedAt: nowIso() } });
  }
  if (box && moveId) {
    const move = await findRow("package_moves", moveId);
    const quantityMilli = -Number(plan.amount_milli);
    if (!move) writes.push({ table: "package_moves", row: { id: moveId, cabinetId: String(box.cabinet_id), packageId: box.id, quantityMilli, reason: "use", createdBy: null } });
    else if (move.deleted_at != null) writes.push(...editRow("package_moves", move, { deletedAt: null, quantityMilli }));
  }
  return { moveId, writes };
}

/** The id of the move a dose of `plan` takes from the box it names now; `null` when it names none. */
function planMoveId(plan: RowSnapshot, dose: { dueOn: string; dueTime: string }): Promise<string | null> {
  const packageId = (plan.package_id as string | null) ?? null;
  return packageId ? deterministicId(naturalKeys.doseMove(String(plan.id), dose.dueOn, dose.dueTime, packageId)) : Promise.resolve(null);
}

/**
 * Answer a dose, or with `null` take the answer back. Taken, a plan naming a
 * live, counted box takes one dose out of it; answered otherwise afterwards,
 * the move goes. Put off, it is said again `SNOOZE_MINUTES` from `now`. One
 * write an undo takes back; nothing for a plan that is gone.
 */
export async function answerDose(
  planId: string,
  dose: { dueOn: string; dueTime: string },
  status: DoseStatus | null,
  { now = new Date(), writes: may = everywhere }: { now?: Date; writes?: Writes } = {},
): Promise<RowsWritten> {
  const id = await deterministicId(naturalKeys.doseLog(planId, dose.dueOn, dose.dueTime));
  return writeUndoable(async () => {
    const plan = await findRow("dose_plans", planId);
    if (!plan || plan.deleted_at != null) return [];
    const there = await findRow("dose_logs", id);
    const live = there?.deleted_at == null ? there : null;
    const { moveId, writes } = await doseMove(plan, dose, (live?.move_id as string | null | undefined) ?? null, status === "taken", may);
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

/**
 * After a pull, each answer the server's copy replaced gets the move its
 * answer wants. Two phones answering one dose offline write the answer and
 * the move apart, and last-write-wins settles each on its own: "taken" on one
 * and "skipped" later on the other left the first one's move standing. So the
 * answer decides: not taken, no move of its dose stays live; taken, the move
 * it names comes back if another phone's answer had removed it. A taken
 * answer that names none, its box uncounted where it was given, leaves a move
 * another phone counted alone. Every phone that pulls the answer writes the
 * same rows, so they settle, and an answer already in step writes nothing.
 */
export async function settleDoseMoves(logIds: readonly string[], may: Writes): Promise<void> {
  await writeRows(async () => (await Promise.all(logIds.map((logId) => settledMoves(logId, may)))).flat());
}

async function settledMoves(logId: string, may: Writes): Promise<RowWrite[]> {
  const log = await findRow("dose_logs", logId);
  const plan = log && (await findRow("dose_plans", String(log.plan_id)));
  if (!log || !plan) return [];
  const held = (log.move_id as string | null) ?? null;
  const key = await planMoveId(plan, { dueOn: String(log.due_on), dueTime: String(log.due_time) });
  const kept = log.deleted_at == null && log.status === "taken" ? (held ?? key) : null;
  return (await Promise.all([...new Set([held, key])].map((id) => settledMove(id, held, kept, may)))).flat();
}

/** One of an answer's moves made what its answer wants: live where kept, a tombstone otherwise; brought back only when the answer names it. */
async function settledMove(id: string | null, held: string | null, kept: string | null, may: Writes): Promise<RowWrite[]> {
  const move = id ? await findRow("package_moves", id) : null;
  if (!move || !may(String(move.cabinet_id))) return [];
  if (id !== kept) return move.deleted_at == null ? editRow("package_moves", move, { deletedAt: nowIso() }) : [];
  return id === held ? editRow("package_moves", move, { deletedAt: null }) : [];
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
