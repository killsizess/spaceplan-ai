import { assertPoint, wallLength, type Point } from "@/domain/geometry";
import type { Wall } from "./types";

export interface WallIntersectionDiagnostic {
  readonly id: string;
  readonly wallIds: readonly [string, string];
  readonly point: Point;
}

const NODE_TOLERANCE = 1e-9;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Proper crossing of two wall axes strictly inside both walls, or null. Points
 * within 1e-9 m of either wall's ends, parallel axes and collinear overlaps are
 * not crossings. Shared by the crossing list and the wall topology.
 */
export function axisCrossing(first: Wall, second: Wall): Point | null {
  const rx = first.end.x - first.start.x;
  const ry = first.end.y - first.start.y;
  const sx = second.end.x - second.start.x;
  const sy = second.end.y - second.start.y;
  const positive = rx * sy;
  const negative = ry * sx;
  const determinant = positive - negative;
  // Cancellation is relative to these products, never to a distance in metres.
  // A small, well-resolved angle is still an intersection.
  const roundingBound = Number.EPSILON * 8 * (Math.abs(positive) + Math.abs(negative));
  if (Math.abs(determinant) <= roundingBound) return null;
  const qx = second.start.x - first.start.x;
  const qy = second.start.y - first.start.y;
  const t = (qx * sy - qy * sx) / determinant;
  const u = (qx * ry - qy * rx) / determinant;
  const firstLength = Math.hypot(rx, ry);
  const secondLength = Math.hypot(sx, sy);
  if (
    t * firstLength <= NODE_TOLERANCE || (1 - t) * firstLength <= NODE_TOLERANCE ||
    u * secondLength <= NODE_TOLERANCE || (1 - u) * secondLength <= NODE_TOLERANCE
  ) return null;
  return { x: first.start.x + t * rx, y: first.start.y + t * ry };
}

/**
 * Proper axis crossings only: endpoint contacts, T-junctions, parallel walls and
 * collinear overlaps are excluded. Stable ID-pair order makes the bounded result
 * independent of input order; `truncated` does not claim a total crossing count.
 */
export function analyzeWallIntersections(
  walls: readonly Wall[],
  limit = 100,
): { intersections: WallIntersectionDiagnostic[]; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Лимит пересечений должен быть целым числом от 1 до 1000.");
  }
  if (walls.length > 1000) throw new Error("Диагностика поддерживает не больше 1000 стен.");
  const ids = new Set<string>();
  for (const wall of walls) {
    if (typeof wall.id !== "string" || wall.id.length < 1 || wall.id.length > 100) {
      throw new Error("Некорректный идентификатор стены.");
    }
    if (ids.has(wall.id)) throw new Error("Идентификаторы стен должны быть уникальными.");
    ids.add(wall.id);
    assertPoint(wall.start);
    assertPoint(wall.end);
    wallLength(wall.start, wall.end);
  }
  const sorted = [...walls].sort((a, b) => compareIds(a.id, b.id));
  const intersections: WallIntersectionDiagnostic[] = [];
  for (let first = 0; first < sorted.length; first++) {
    for (let second = first + 1; second < sorted.length; second++) {
      const point = axisCrossing(sorted[first], sorted[second]);
      if (!point) continue;
      if (intersections.length === limit) return { intersections, truncated: true };
      const wallIds: readonly [string, string] = [sorted[first].id, sorted[second].id];
      intersections.push({
        id: `wall-intersection:${JSON.stringify(wallIds)}`,
        wallIds,
        point,
      });
    }
  }
  return { intersections, truncated: false };
}
