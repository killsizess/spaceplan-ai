import { addOpening, addWallsAndOpenings, deleteObject, updateOpening, updateWall } from "@/domain/floor-plan/construction";
import { floorPlanSchema } from "@/domain/floor-plan/schema";
import type { FloorPlan, WallRoomLabel } from "@/domain/floor-plan/types";
import { reconcileWallRoomLabels, resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import { tr } from "@/lib/i18n";
import { buyerBase } from "./buyer-guard";

/**
 * Undoes one change of a buyer's copy, any one, leaving the others: `wall:<id>`,
 * `opening:<id>` or `room:<labelId>`, the ids Proof and the journal use. A change that other
 * changes stand on cannot be undone alone, and the error says which comes first.
 */
export function revertChange(plan: FloorPlan, changeId: string): FloorPlan {
  const base = buyerBase(plan);
  if (!base) throw new Error(tr`Отменять изменения по одному можно только в квартире покупателя.`);
  const [kind, id] = [changeId.slice(0, changeId.indexOf(":")), changeId.slice(changeId.indexOf(":") + 1)];
  let next: FloorPlan;
  try {
    if (kind === "wall") next = revertWall(plan, base, id);
    else if (kind === "opening") next = revertOpening(plan, base, id);
    else if (kind === "room") next = revertRoom(plan, base, id);
    else throw new Error(tr`Неизвестное изменение.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    throw new Error(tr`Это изменение не отменяется отдельно: на нём держатся другие. Сначала отмените изменения рядом с ним. ${reason}`.trim());
  }
  const parsed = floorPlanSchema.safeParse(next);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "";
    throw new Error(tr`Это изменение не отменяется отдельно: на нём держатся другие. Сначала отмените изменения рядом с ним. ${message}`.trim());
  }
  return parsed.data as FloorPlan;
}

function restoreLabels(previous: FloorPlan, plan: FloorPlan, base: FloorPlan): FloorPlan {
  // Labels the template had and the plan lost come back; the buyer's own that no longer
  // name a room go, so a room is not named twice.
  const present = new Set(plan.wallRoomLabels.map((label) => label.id));
  const missing = base.wallRoomLabels.filter((label) => !present.has(label.id));
  let next: FloorPlan = missing.length ? { ...plan, wallRoomLabels: [...plan.wallRoomLabels, ...missing.map((label) => structuredClone(label))] } : plan;
  next = reconcileWallRoomLabels(previous, next);
  try {
    const unassigned = new Set(resolveWallRoomLabels(next).unassigned.map((label) => label.id));
    const baseIds = new Set(base.wallRoomLabels.map((label) => label.id));
    const kept = next.wallRoomLabels.filter((label: WallRoomLabel) => !(unassigned.has(label.id) && !baseIds.has(label.id)));
    if (kept.length !== next.wallRoomLabels.length) next = { ...next, wallRoomLabels: kept };
  } catch {
    // Rooms that cannot be computed: the schema check after this says so.
  }
  return next;
}

function revertWall(plan: FloorPlan, base: FloorPlan, id: string): FloorPlan {
  const before = base.walls.find((wall) => wall.id === id);
  const now = plan.walls.find((wall) => wall.id === id);
  let next: FloorPlan;
  if (before && !now) {
    const openings = base.openings.filter((opening) => opening.wallId === id && !plan.openings.some((item) => item.id === opening.id));
    next = addWallsAndOpenings(plan, [structuredClone(before)], openings.map((opening) => structuredClone(opening)));
  } else if (before && now) {
    next = updateWall(plan, { ...now, start: { ...before.start }, end: { ...before.end }, thickness: before.thickness, height: before.height, ...(before.kind ? { kind: before.kind } : {}) }, true);
  } else if (now) {
    next = deleteObject(plan, id);
  } else {
    throw new Error(tr`Этой стены нет ни в шаблоне, ни в плане.`);
  }
  return restoreLabels(plan, reconcileWallRoomLabels(plan, next), base);
}

function revertOpening(plan: FloorPlan, base: FloorPlan, id: string): FloorPlan {
  const before = base.openings.find((opening) => opening.id === id);
  const now = plan.openings.find((opening) => opening.id === id);
  if (before && !plan.walls.some((wall) => wall.id === before.wallId)) {
    const number = base.walls.findIndex((wall) => wall.id === before.wallId) + 1;
    throw new Error(tr`Сначала верните стену ${number}: проём стоит в ней.`);
  }
  if (before && !now) return addOpening(plan, structuredClone(before));
  if (before && now) return updateOpening(plan, structuredClone(before));
  if (now) return deleteObject(plan, id);
  throw new Error(tr`Этого проёма нет ни в шаблоне, ни в плане.`);
}

function revertRoom(plan: FloorPlan, base: FloorPlan, id: string): FloorPlan {
  const before = base.wallRoomLabels.find((label) => label.id === id);
  if (!before) return { ...plan, wallRoomLabels: plan.wallRoomLabels.filter((label) => label.id !== id) };
  const exists = plan.wallRoomLabels.some((label) => label.id === id);
  const labels = exists
    ? plan.wallRoomLabels.map((label) => (label.id === id ? { ...label, name: before.name, kind: before.kind, color: before.color } : label))
    : [...plan.wallRoomLabels, structuredClone(before)];
  return reconcileWallRoomLabels(plan, { ...plan, wallRoomLabels: labels });
}
