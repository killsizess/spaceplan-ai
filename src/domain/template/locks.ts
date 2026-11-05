import type { ApartmentTemplate, FloorPlan, Wall } from "@/domain/floor-plan/types";
import { resolveWallRoomLabels, type ResolvedWallRoom } from "@/domain/floor-plan/wall-room-labels";
import { tr } from "@/lib/i18n";

/** The plan's rooms with their saved parameters; none when they cannot be determined. */
export function labelledRooms(plan: FloorPlan): ResolvedWallRoom[] {
  if (plan.roomMode !== "walls") return [];
  try {
    return resolveWallRoomLabels(plan).rooms;
  } catch {
    return [];
  }
}

/** Rooms (saved parameters) the developer fixed: wet zones and rooms with a riser. */
export const fixedRoomIds = (template: ApartmentTemplate): Set<string> =>
  new Set(template.fixed.flatMap((item) => (item.kind === "entrance-door" ? [] : [item.roomLabelId])));

export const entranceDoorIds = (template: ApartmentTemplate): Set<string> =>
  new Set(template.fixed.flatMap((item) => (item.kind === "entrance-door" ? [item.openingId] : [])));

const EPSILON = 1e-6;

/**
 * The wall of `base` that `wall` lies along, if it is a piece of one: joining walls splits a
 * wall into pieces with new ids, and a piece is as locked as the wall it came from.
 */
export function baseWallOf(base: Pick<FloorPlan, "walls">, wall: Wall): Wall | undefined {
  const same = base.walls.find((item) => item.id === wall.id);
  if (same) return same;
  return base.walls.find((item) => {
    const length = Math.hypot(item.end.x - item.start.x, item.end.y - item.start.y);
    if (length <= EPSILON || Math.abs(item.thickness - wall.thickness) > EPSILON) return false;
    const ux = (item.end.x - item.start.x) / length, uy = (item.end.y - item.start.y) / length;
    const across = (point: { x: number; y: number }) => Math.abs((point.x - item.start.x) * -uy + (point.y - item.start.y) * ux);
    const along = (point: { x: number; y: number }) => (point.x - item.start.x) * ux + (point.y - item.start.y) * uy;
    return [wall.start, wall.end].every((point) => across(point) <= EPSILON && along(point) >= -EPSILON && along(point) <= length + EPSILON);
  });
}

export interface WallLock {
  locked: boolean;
  /** Why, in a sentence a buyer reads. Empty for a wall the buyer may change. */
  reason: string;
}

/**
 * Whether a buyer may move or remove a wall of the template, and why not. The order is
 * the order of importance: a bearing wall is locked as bearing even if it bounds a wet zone.
 * A wall the template does not have is the buyer's own and is theirs to change.
 */
export function wallLock(
  template: ApartmentTemplate,
  base: FloorPlan,
  wall: Wall,
  rooms: readonly ResolvedWallRoom[] = labelledRooms(base),
): WallLock {
  const source = baseWallOf(base, wall);
  if (!source) return { locked: false, reason: "" };
  const kind = source.kind ?? "unknown";
  if (kind === "bearing") {
    return { locked: true, reason: tr`Несущая стена: менять её нельзя. Решения о несущих конструкциях принимает специалист по проекту.` };
  }
  if (kind === "unknown") {
    return { locked: true, reason: tr`Тип этой стены застройщик не указал: она может оказаться несущей, поэтому менять её нельзя.` };
  }
  const fixed = fixedRoomIds(template);
  const wet = rooms.find((room) => room.labelId && fixed.has(room.labelId) && room.boundaryWallIds.includes(source.id));
  if (wet) return { locked: true, reason: tr`Стена помещения «${wet.name}», которое застройщик зафиксировал: мокрая зона или стояк остаются на месте.` };
  if (!template.buyerWalls.includes(source.id)) {
    return { locked: true, reason: tr`Застройщик не разрешил менять эту стену. Разрешённые стены отмечены на плане.` };
  }
  return { locked: false, reason: "" };
}

/** Ids of walls of `plan` a buyer may not change, so the screen can lock them up front. */
export function lockedWallIds(plan: FloorPlan, base: FloorPlan, template: ApartmentTemplate): Set<string> {
  const rooms = labelledRooms(base);
  return new Set(plan.walls.filter((wall) => wallLock(template, base, wall, rooms).locked).map((wall) => wall.id));
}
