import { wallLength, type Point } from "@/domain/geometry";
import { doorSwingWorld, type DoorSwingGeometry } from "./door-swing";
import { openingSchema, wallSchema } from "./schema";
import { buildWallSolids } from "./spatial";
import type { Opening, Wall } from "./types";

export interface DoorWallCollision {
  readonly id: string;
  readonly doorId: string;
  readonly wallId: string;
  readonly point: Point;
}

// Metres, matching the model's wall/opening boundary tolerance. The diagnostic
// requires penetration past this tolerance; mere contact is not a collision.
const TOLERANCE = 1e-9;

interface SolidFootprint {
  points: Point[];
  bottom: number;
  top: number;
  bounds: DoorSwingGeometry["bounds"];
}

function compareIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

/** Clip a convex polygon against one coordinate's positive half-plane. */
function clipPositive(polygon: readonly Point[], axis: "x" | "y"): Point[] {
  const result: Point[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const aInside = a[axis] >= TOLERANCE;
    const bInside = b[axis] >= TOLERANCE;
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const t = (TOLERANCE - a[axis]) / (b[axis] - a[axis]);
      result.push({
        x: axis === "x" ? TOLERANCE : a.x + t * (b.x - a.x),
        y: axis === "y" ? TOLERANCE : a.y + t * (b.y - a.y),
      });
    }
  }
  return result;
}

function hasArea(polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  const origin = polygon[0];
  let twiceArea = 0;
  for (let index = 1; index < polygon.length - 1; index++) {
    const a = polygon[index];
    const b = polygon[index + 1];
    twiceArea += (a.x - origin.x) * (b.y - origin.y) -
      (a.y - origin.y) * (b.x - origin.x);
  }
  return Math.abs(twiceArea) > TOLERANCE * TOLERANCE;
}

function closestToOrigin(polygon: readonly Point[]): Point {
  let closest = polygon[0];
  let distance = Math.hypot(closest.x, closest.y);
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squaredLength = dx * dx + dy * dy;
    const t = squaredLength === 0 ? 0 : Math.max(0, Math.min(1,
      -(a.x * dx + a.y * dy) / squaredLength,
    ));
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const candidateDistance = Math.hypot(point.x, point.y);
    if (candidateDistance < distance) {
      closest = point;
      distance = candidateDistance;
    }
  }
  return closest;
}

function sectorIntersection(
  swing: DoorSwingGeometry,
  radius: number,
  solid: SolidFootprint,
): Point | null {
  const a = swing.bounds;
  const b = solid.bounds;
  if (
    Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) <= TOLERANCE ||
    Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) <= TOLERANCE
  ) return null;
  const closed = {
    x: (swing.closedEnd.x - swing.hinge.x) / radius,
    y: (swing.closedEnd.y - swing.hinge.y) / radius,
  };
  const opened = {
    x: (swing.openEnd.x - swing.hinge.x) / radius,
    y: (swing.openEnd.y - swing.hinge.y) / radius,
  };
  // In this orthonormal basis every hinge/side combination is the same quarter
  // disk: x >= 0, y >= 0, x² + y² <= radius². No rendered arc samples are used.
  const local = solid.points.map((point) => {
    const dx = point.x - swing.hinge.x;
    const dy = point.y - swing.hinge.y;
    return { x: dx * closed.x + dy * closed.y, y: dx * opened.x + dy * opened.y };
  });
  const clipped = clipPositive(clipPositive(local, "x"), "y");
  if (!hasArea(clipped)) return null;
  const closest = closestToOrigin(clipped);
  if (Math.hypot(closest.x, closest.y) >= radius - TOLERANCE) return null;
  return {
    x: swing.hinge.x + closest.x * closed.x + closest.y * opened.x,
    y: swing.hinge.y + closest.x * closed.y + closest.y * opened.y,
  };
}

function wallFootprints(wall: Wall, openings: readonly Opening[]): SolidFootprint[] {
  const length = wallLength(wall.start, wall.end);
  const ux = (wall.end.x - wall.start.x) / length;
  const uy = (wall.end.y - wall.start.y) / length;
  return buildWallSolids(wall, openings).map((solid) => {
    const points = [
      [solid.offset, -solid.thickness / 2],
      [solid.offset + solid.length, -solid.thickness / 2],
      [solid.offset + solid.length, solid.thickness / 2],
      [solid.offset, solid.thickness / 2],
    ].map(([along, normal]) => ({
      x: wall.start.x + along * ux - normal * uy,
      y: wall.start.y + along * uy + normal * ux,
    }));
    return {
      points,
      bottom: solid.bottom,
      top: solid.bottom + solid.height,
      bounds: {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
      },
    };
  });
}

/**
 * Nominal 0–90° swept door sectors against other walls' actual solid volumes.
 * Openings and vertical overlap are respected. The supporting wall, frames,
 * leaf thickness, other leaves and furniture are deliberately not assessed.
 * Results are ordered by door ID, then wall ID, independently of input order;
 * truncated means more pairs exist, never an inferred total collision count.
 */
export function analyzeDoorWallCollisions(
  walls: readonly Wall[],
  openings: readonly Opening[],
  limit = 100,
): { collisions: DoorWallCollision[]; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Лимит столкновений должен быть целым числом от 1 до 1000.");
  }
  if (walls.length > 1000 || openings.length > 1000) {
    throw new Error("Диагностика поддерживает не больше 1000 стен и 1000 проёмов.");
  }
  const ids = new Set<string>();
  for (const wall of walls) {
    if (!wallSchema.safeParse(wall).success) throw new Error("Некорректная стена для проверки открывания.");
    if (ids.has(wall.id)) throw new Error("Идентификаторы стен и проёмов должны быть уникальными.");
    ids.add(wall.id);
  }
  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  for (const opening of openings) {
    if (!openingSchema.safeParse(opening).success) throw new Error("Некорректный проём для проверки открывания.");
    if (ids.has(opening.id)) throw new Error("Идентификаторы стен и проёмов должны быть уникальными.");
    ids.add(opening.id);
    if (!wallsById.has(opening.wallId)) throw new Error("Стена проёма не найдена.");
  }
  const sortedWalls = [...walls].sort((a, b) => compareIds(a.id, b.id));
  // Validate every wall's openings before an early bounded return can occur.
  const footprints = new Map(sortedWalls.map((wall) => [wall.id, wallFootprints(wall, openings)]));
  const doors = openings.filter((opening) => opening.kind === "door")
    .sort((a, b) => compareIds(a.id, b.id))
    .map((door) => ({ door, swing: doorSwingWorld(wallsById.get(door.wallId)!, door)! }));
  const collisions: DoorWallCollision[] = [];
  for (const { door, swing } of doors) {
    for (const wall of sortedWalls) {
      if (wall.id === door.wallId) continue;
      let point: Point | null = null;
      for (const solid of footprints.get(wall.id)!) {
        if (Math.min(door.sillHeight + door.height, solid.top) -
          Math.max(door.sillHeight, solid.bottom) <= TOLERANCE) continue;
        point = sectorIntersection(swing, door.width, solid);
        if (point) break;
      }
      if (!point) continue;
      if (collisions.length === limit) return { collisions, truncated: true };
      collisions.push({
        id: `door-wall-collision:${JSON.stringify([door.id, wall.id])}`,
        doorId: door.id,
        wallId: wall.id,
        point,
      });
    }
  }
  return { collisions, truncated: false };
}
