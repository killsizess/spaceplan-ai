import { countsInTotal, type FloorPlan, type Opening, type RoomKind, type Wall } from "./types";
import { resolveWallRoomLabels } from "./wall-room-labels";

const POSITION_TOLERANCE = 1e-9;
const KINDS: readonly RoomKind[] = ["living", "bedroom", "kitchen", "bathroom", "hall", "other", "balcony", "shaft"];

export interface CollectionDiff {
  /** IDs only in the second plan, in its order. */
  readonly added: readonly string[];
  /** IDs only in the first plan, in its order. */
  readonly removed: readonly string[];
  /** IDs in both plans whose stored fields differ, in the second plan's order. */
  readonly changed: readonly string[];
}

export interface PlanMetrics {
  /** Active room source: wall rooms in "walls" mode, rectangles in "manual" mode. */
  readonly roomMode: FloorPlan["roomMode"];
  readonly totalArea: number;
  readonly roomCount: number;
  readonly areaByKind: Readonly<Record<RoomKind, number>>;
  readonly roomsByKind: Readonly<Record<RoomKind, number>>;
  readonly wallCount: number;
  /** Sum of wall axis lengths, in metres. */
  readonly wallLength: number;
  readonly doorCount: number;
  readonly windowCount: number;
  /** False when wall rooms could not be computed; areas are then zero. */
  readonly roomsComputed: boolean;
}

export interface PlanDiff {
  readonly walls: CollectionDiff;
  readonly openings: CollectionDiff;
  readonly rooms: CollectionDiff;
  readonly wallRoomLabels: CollectionDiff;
  readonly requirements: CollectionDiff;
  /** Metrics of the first and the second plan. */
  readonly before: PlanMetrics;
  readonly after: PlanMetrics;
  /**
   * Volume of wall work in metres: removed walls at their old length, added
   * walls at their new length and changed walls at the larger of both.
   */
  readonly changedWallLength: number;
  /** Openings present in both plans whose plan position, size or host changed. */
  readonly movedOpenings: readonly string[];
  /** True when nothing stored in the plans differs (names and IDs aside). */
  readonly identical: boolean;
}

/** Stable comparison of plain JSON values, independent of key order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).sort(), keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) return false;
  return keysA.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function collection<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
  compared: (item: T) => unknown = (item) => item,
): CollectionDiff {
  const before = new Map(first.map((item) => [item.id, item]));
  const after = new Set(second.map((item) => item.id));
  return {
    added: second.filter((item) => !before.has(item.id)).map((item) => item.id),
    removed: first.filter((item) => !after.has(item.id)).map((item) => item.id),
    changed: second
      .filter((item) => before.has(item.id) && !same(compared(before.get(item.id)!), compared(item)))
      .map((item) => item.id),
  };
}

const wallLength = (wall: Wall) => Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

/** Plan coordinates of an opening's two edges, or null if its wall is missing. */
function openingSpan(opening: Opening, walls: ReadonlyMap<string, Wall>) {
  const wall = walls.get(opening.wallId);
  if (!wall) return null;
  const length = wallLength(wall);
  const at = (distance: number) => ({
    x: wall.start.x + ((wall.end.x - wall.start.x) / length) * distance,
    y: wall.start.y + ((wall.end.y - wall.start.y) / length) * distance,
  });
  return [at(opening.offset), at(opening.offset + opening.width)] as const;
}

/** Areas, counts and lengths of one plan, computed by the core (never stored). */
export function planMetrics(plan: FloorPlan): PlanMetrics {
  const areaByKind = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<RoomKind, number>;
  const roomsByKind = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<RoomKind, number>;
  let roomsComputed = true;
  const rooms: { kind: RoomKind; area: number }[] = [];
  if (plan.roomMode === "walls") {
    try {
      for (const room of resolveWallRoomLabels(plan).rooms) rooms.push({ kind: room.kind, area: room.area });
    } catch {
      roomsComputed = false;
    }
  } else {
    for (const room of plan.rooms) rooms.push({ kind: room.kind, area: room.width * room.height });
  }
  for (const room of rooms) {
    areaByKind[room.kind] += room.area;
    roomsByKind[room.kind] += 1;
  }
  return {
    roomMode: plan.roomMode,
    totalArea: rooms.filter((room) => countsInTotal(room.kind)).reduce((total, room) => total + room.area, 0),
    roomCount: rooms.length,
    areaByKind,
    roomsByKind,
    wallCount: plan.walls.length,
    wallLength: plan.walls.reduce((total, wall) => total + wallLength(wall), 0),
    doorCount: plan.openings.filter((opening) => opening.kind === "door").length,
    windowCount: plan.openings.filter((opening) => opening.kind === "window").length,
    roomsComputed,
  };
}

/**
 * Deterministic difference from `first` to `second`, matched by object IDs.
 * Swapping the arguments swaps added/removed and before/after; nothing is
 * stored. Plan ID, name and underlay are not compared: a variant is a copy.
 */
export function diffPlans(first: FloorPlan, second: FloorPlan): PlanDiff {
  const walls = collection(first.walls, second.walls);
  const openings = collection(first.openings, second.openings);
  const rooms = collection(first.rooms, second.rooms);
  // Anchors and boundary walls are rebound automatically after geometry edits;
  // only the user's attributes count as a change of room parameters.
  const wallRoomLabels = collection(first.wallRoomLabels, second.wallRoomLabels, ({ name, kind, color }) => ({ name, kind, color }));
  const requirements = collection(first.requirements, second.requirements);

  const wallsBefore = new Map(first.walls.map((wall) => [wall.id, wall]));
  const wallsAfter = new Map(second.walls.map((wall) => [wall.id, wall]));
  const changedWallLength =
    walls.removed.reduce((total, id) => total + wallLength(wallsBefore.get(id)!), 0) +
    walls.added.reduce((total, id) => total + wallLength(wallsAfter.get(id)!), 0) +
    walls.changed.reduce((total, id) => total + Math.max(wallLength(wallsBefore.get(id)!), wallLength(wallsAfter.get(id)!)), 0);

  const openingsBefore = new Map(first.openings.map((opening) => [opening.id, opening]));
  const movedOpenings = second.openings.flatMap((opening) => {
    const previous = openingsBefore.get(opening.id);
    if (!previous) return [];
    const a = openingSpan(previous, wallsBefore), b = openingSpan(opening, wallsAfter);
    const moved = !a || !b ||
      previous.wallId !== opening.wallId ||
      a.some((point, index) => Math.hypot(point.x - b[index].x, point.y - b[index].y) > POSITION_TOLERANCE) ||
      previous.height !== opening.height || previous.sillHeight !== opening.sillHeight;
    return moved ? [opening.id] : [];
  });

  const empty = (diff: CollectionDiff) => !diff.added.length && !diff.removed.length && !diff.changed.length;
  return {
    walls,
    openings,
    rooms,
    wallRoomLabels,
    requirements,
    before: planMetrics(first),
    after: planMetrics(second),
    changedWallLength,
    movedOpenings,
    identical: [walls, openings, rooms, wallRoomLabels, requirements].every(empty) && first.roomMode === second.roomMode,
  };
}
