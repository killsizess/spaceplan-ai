import { assertPoint, type Point } from "@/domain/geometry";
import type { Opening, Wall } from "./types";

export type WallEndpoint = "start" | "end";

const NODE_TOLERANCE = 1e-9;

/** Coincident endpoints are within 1e-9 m Euclidean distance; gaps stay separate. */
export function sameWallNode(a: Point, b: Point): boolean {
  return (
    [a.x, a.y, b.x, b.y].every(Number.isFinite) &&
    Math.hypot(a.x - b.x, a.y - b.y) <= NODE_TOLERANCE
  );
}

/** Only endpoints participate: touching the middle of a wall creates no node. */
export function connectedWallIds(
  walls: readonly Wall[],
  point: Point,
): string[] {
  assertPoint(point);
  return [...new Set(
    walls
      .filter((wall) =>
        sameWallNode(wall.start, point) || sameWallNode(wall.end, point),
      )
      .map((wall) => wall.id),
  )].sort();
}

function equalPoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function selectedWall(walls: readonly Wall[], wallId: string): Wall {
  if (wallId.length < 1 || wallId.length > 100)
    throw new Error("Некорректный идентификатор стены.");
  const matches = walls.filter((wall) => wall.id === wallId);
  if (matches.length === 0) throw new Error("Стена не найдена.");
  if (matches.length !== 1)
    throw new Error("Идентификаторы стен должны быть уникальными.");
  return matches[0];
}

/**
 * Geometry-only preview: preserve untouched references and match all connections
 * against the original endpoints, so moving both ends never cascades.
 * Full plan validation belongs to the committed construction operation.
 */
export function previewWallUpdate(
  walls: readonly Wall[],
  wall: Wall,
  connectEndpoints = true,
): readonly Wall[] {
  const original = selectedWall(walls, wall.id);
  assertPoint(wall.start);
  assertPoint(wall.end);
  for (const item of walls) {
    assertPoint(item.start);
    assertPoint(item.end);
  }
  const startChanged = !equalPoint(original.start, wall.start);
  const endChanged = !equalPoint(original.end, wall.end);
  if (
    !startChanged &&
    !endChanged &&
    original.thickness === wall.thickness &&
    original.height === wall.height
  ) return walls;

  function movedEndpoint(point: Point): Point {
    if (startChanged && sameWallNode(point, original.start)) return wall.start;
    if (endChanged && sameWallNode(point, original.end)) return wall.end;
    return point;
  }

  return walls.map((item) => {
    if (item.id === wall.id) return wall;
    if (!connectEndpoints) return item;
    const start = movedEndpoint(item.start);
    const end = movedEndpoint(item.end);
    return equalPoint(start, item.start) && equalPoint(end, item.end)
      ? item
      : { ...item, start, end };
  });
}

/** Change of the stored offset that keeps an opening where the rules below place it. */
function openingShift(original: Wall, wall: Wall): number {
  const startX = wall.start.x - original.start.x;
  const startY = wall.start.y - original.start.y;
  // A rigid translation carries hosted openings along with the wall.
  if (
    Math.hypot(startX - (wall.end.x - original.end.x), startY - (wall.end.y - original.end.y)) <=
    NODE_TOLERANCE
  ) return 0;
  const oldLength = Math.hypot(original.end.x - original.start.x, original.end.y - original.start.y);
  const newLength = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const ux = (wall.end.x - wall.start.x) / newLength;
  const uy = (wall.end.y - wall.start.y) / newLength;
  const oldUx = (original.end.x - original.start.x) / oldLength;
  const oldUy = (original.end.y - original.start.y) / oldLength;
  // Unchanged direction: each opening keeps its coordinate along the wall axis.
  if (Math.abs(oldUx * uy - oldUy * ux) * newLength <= NODE_TOLERANCE && oldUx * ux + oldUy * uy > 0) {
    return -(startX * ux + startY * uy);
  }
  // A rotation about the unmoved end keeps the distance from that end.
  return equalPoint(original.end, wall.end) ? newLength - oldLength : 0;
}

/**
 * Re-measures opening offsets after wall edits so that a door never slides along
 * a wall because of the wall's hidden start-to-end direction. Translating a whole
 * wall carries its openings; changing a wall without turning it keeps each
 * opening's position along the axis; turning it about one unmoved end keeps the
 * distance from that end. Other rotations keep the stored offset. Offsets that
 * leave the wall are returned as they are, so the committed edit is rejected
 * rather than silently clamped; only sub-nanometre roundoff becomes zero.
 * Returns the input array when no opening changes.
 */
export function rebaseOpenings(
  previous: readonly Wall[],
  next: readonly Wall[],
  openings: readonly Opening[],
): readonly Opening[] {
  const before = new Map(previous.map((wall) => [wall.id, wall]));
  const shifts = new Map<string, number>();
  for (const wall of next) {
    const original = before.get(wall.id);
    if (!original || (equalPoint(original.start, wall.start) && equalPoint(original.end, wall.end)))
      continue;
    const shift = openingShift(original, wall);
    if (Number.isFinite(shift) && shift !== 0) shifts.set(wall.id, shift);
  }
  if (shifts.size === 0) return openings;
  return openings.map((opening) => {
    const shift = shifts.get(opening.wallId);
    if (shift === undefined) return opening;
    const offset = opening.offset + shift;
    return { ...opening, offset: offset < 0 && offset >= -NODE_TOLERANCE ? 0 : offset };
  });
}

/** Allows a transient collapsed wall; the final move must validate the plan. */
export function previewWallNode(
  walls: readonly Wall[],
  wallId: string,
  endpoint: WallEndpoint,
  point: Point,
  connectEndpoints = true,
): readonly Wall[] {
  if (endpoint !== "start" && endpoint !== "end")
    throw new Error("Некорректная вершина стены.");
  const wall = selectedWall(walls, wallId);
  return previewWallUpdate(walls, { ...wall, [endpoint]: point }, connectEndpoints);
}
