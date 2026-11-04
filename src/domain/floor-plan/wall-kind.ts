import type { FloorPlan, Wall, WallKind } from "./types";

/** Wall types in the order the editor offers them. */
export const WALL_KINDS: readonly WallKind[] = ["unknown", "partition", "bearing"];

export const WALL_KIND_LABELS: Readonly<Record<WallKind, string>> = {
  unknown: "Не указано",
  partition: "Перегородка",
  bearing: "Несущая",
};

/** The type of a wall; an absent field means "unknown", never a guess. */
export function wallKindOf(wall: Pick<Wall, "kind">): WallKind {
  return wall.kind ?? "unknown";
}

export const isBearing = (wall: Pick<Wall, "kind">): boolean => wall.kind === "bearing";

/**
 * Sets the type of one wall. `unknown` removes the field, so a plan that never
 * used wall types stays byte-identical in its walls.
 */
export function withWallKind(wall: Wall, kind: WallKind): Wall {
  const { kind: _previous, ...rest } = wall;
  void _previous;
  return kind === "unknown" ? rest : { ...rest, kind };
}

/** IDs of the walls marked bearing, in plan order. */
export function bearingWallIds(plan: Pick<FloorPlan, "walls">): string[] {
  return plan.walls.filter(isBearing).map((wall) => wall.id);
}

/** The bearing walls among the given wall IDs, in plan order. */
export function bearingAmong(plan: Pick<FloorPlan, "walls">, wallIds: readonly string[]): Wall[] {
  const ids = new Set(wallIds);
  return plan.walls.filter((wall) => ids.has(wall.id) && isBearing(wall));
}

/** What happened to a wall that was bearing before an edit. `unmarked`: it is still there but no longer bearing. */
export type BearingChange = "deleted" | "moved" | "thickness" | "unmarked";

export interface BearingWallChange {
  readonly wallId: string;
  /** 1-based position of the wall in the plan before the edit (what the editor calls "Стена N"). */
  readonly number: number;
  readonly change: BearingChange;
}

const TOLERANCE = 1e-9;
const same = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= TOLERANCE;

/**
 * The bearing walls of `before` that `after` deletes, moves, thickens or stops marking
 * bearing. It compares plans, not actions, so every way of editing a wall (drag, offset,
 * node move, room resize, connect, delete, type change) is covered the same way.
 * A wall whose axis is the same in either direction counts as unmoved.
 */
export function bearingWallChanges(
  before: Pick<FloorPlan, "walls">,
  after: Pick<FloorPlan, "walls">,
): BearingWallChange[] {
  const changes: BearingWallChange[] = [];
  before.walls.forEach((wall, index) => {
    if (!isBearing(wall)) return;
    const next = after.walls.find((item) => item.id === wall.id);
    let change: BearingChange | undefined;
    if (!next) change = "deleted";
    else if (
      !((same(next.start, wall.start) && same(next.end, wall.end)) ||
        (same(next.start, wall.end) && same(next.end, wall.start)))
    ) change = "moved";
    else if (Math.abs(next.thickness - wall.thickness) > TOLERANCE) change = "thickness";
    else if (!isBearing(next)) change = "unmarked";
    if (change) changes.push({ wallId: wall.id, number: index + 1, change });
  });
  return changes;
}
