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
