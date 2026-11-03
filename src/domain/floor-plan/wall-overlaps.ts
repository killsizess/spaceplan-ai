import { assertPoint, wallLength, type Point } from "@/domain/geometry";
import type { Wall } from "./types";

export interface WallOverlapDiagnostic {
  readonly id: string;
  readonly wallIds: readonly [string, string];
  /** Middle of the shared part of both axes. */
  readonly point: Point;
  /** Length of the shared part of both axes, in metres. */
  readonly length: number;
}

const NODE_TOLERANCE = 1e-9;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Shared axis interval of two walls, or null unless it has positive length. */
function sharedAxis(first: Wall, second: Wall): { point: Point; length: number } | null {
  const firstLength = Math.hypot(first.end.x - first.start.x, first.end.y - first.start.y);
  const secondLength = Math.hypot(second.end.x - second.start.x, second.end.y - second.start.y);
  // Measure against the longer axis: a short wall's own direction is too
  // imprecise to test whether distant points lie on its line.
  const [host, guest, length] = firstLength >= secondLength
    ? [first, second, firstLength]
    : [second, first, secondLength];
  const ux = (host.end.x - host.start.x) / length;
  const uy = (host.end.y - host.start.y) / length;
  const along = (point: Point) => (point.x - host.start.x) * ux + (point.y - host.start.y) * uy;
  const across = (point: Point) => Math.abs((point.y - host.start.y) * ux - (point.x - host.start.x) * uy);
  if (across(guest.start) > NODE_TOLERANCE || across(guest.end) > NODE_TOLERANCE) return null;
  const a = along(guest.start);
  const b = along(guest.end);
  const from = Math.max(0, Math.min(a, b));
  const to = Math.min(length, Math.max(a, b));
  if (to - from <= NODE_TOLERANCE) return null;
  const middle = (from + to) / 2;
  return { point: { x: host.start.x + ux * middle, y: host.start.y + uy * middle }, length: to - from };
}

/**
 * Collinear walls whose axes share a positive length: a duplicated or partly
 * redrawn wall. Such walls are valid data, but the union hides the duplicate
 * in area calculations while one solid can fill the other's door or window in
 * 3D. Ends that only touch, T-contacts, crossings and parallel walls beside
 * each other are excluded. Axes count as collinear within the model's node
 * tolerance of 1e-9 m. Pairs are ordered by wall ID independently of input
 * order; `truncated` means more pairs exist and never claims a total count.
 */
export function analyzeWallOverlaps(
  walls: readonly Wall[],
  limit = 100,
): { overlaps: WallOverlapDiagnostic[]; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Лимит наложений должен быть целым числом от 1 до 1000.");
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
  const overlaps: WallOverlapDiagnostic[] = [];
  for (let first = 0; first < sorted.length; first++) {
    for (let second = first + 1; second < sorted.length; second++) {
      const shared = sharedAxis(sorted[first], sorted[second]);
      if (!shared) continue;
      if (overlaps.length === limit) return { overlaps, truncated: true };
      const wallIds: readonly [string, string] = [sorted[first].id, sorted[second].id];
      overlaps.push({ id: `wall-overlap:${JSON.stringify(wallIds)}`, wallIds, ...shared });
    }
  }
  return { overlaps, truncated: false };
}
