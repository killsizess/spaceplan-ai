import { tr } from "@/lib/i18n";
import { wallLength, type Point } from "@/domain/geometry";
import { DEFAULT_DOOR_SWING, doorSwingWorld, type DoorSwingGeometry } from "./door-swing";
import { openingSchema, wallSchema } from "./schema";
import { buildWallSolids } from "./spatial";
import type { Opening, Wall } from "./types";

export interface DoorPairCollision {
  readonly id: string;
  readonly doorIds: readonly [string, string];
  readonly point: Point;
}

// Every sector boundary is inset by this distance. A feasible point therefore
// represents positive penetration, not just contact of two nominal thin leaves.
const TOLERANCE = 1e-9;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

interface Sector {
  opening: Opening;
  geometry: DoorSwingGeometry;
  closed: Point;
  opened: Point;
}

interface HalfPlane {
  normal: Point;
  offset: number;
}

function clip(polygon: readonly Point[], plane: HalfPlane): Point[] {
  const result: Point[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const da = dot(a, plane.normal) - plane.offset;
    const db = dot(b, plane.normal) - plane.offset;
    if (da >= 0) result.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      result.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return result;
}

function createSector(wall: Wall, opening: Opening): Sector {
  const geometry = doorSwingWorld(wall, opening)!;
  const length = wallLength(wall.start, wall.end);
  const ux = (wall.end.x - wall.start.x) / length;
  const uy = (wall.end.y - wall.start.y) / length;
  const swing = opening.door ?? DEFAULT_DOOR_SWING;
  // Derive unit axes from the wall, avoiding division of tiny differences
  // between global endpoints when a narrow door is far from the origin.
  return {
    opening,
    geometry,
    closed: swing.hinge === "start" ? { x: ux, y: uy } : { x: -ux, y: -uy },
    opened: swing.side === "left" ? { x: uy, y: -ux } : { x: -uy, y: ux },
  };
}

/**
 * Exact convex feasibility, not an approximation of either rendered arc.
 * After intersecting the inset quadrant half-planes, find the point of
 * polygon ∩ disk A nearest centre B. Such a nearest point is either centre B,
 * on a polygon edge (its projection or a circle/edge intersection), or on
 * disk A's circular boundary in the radial direction towards B. This finite
 * candidate set also covers contained/coincident circles and degenerate
 * boundaries of the inset region.
 */
function intersection(first: Sector, second: Sector): Point | null {
  const a = first.geometry.bounds;
  const b = second.geometry.bounds;
  if (Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) <= TOLERANCE ||
      Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) <= TOLERANCE) return null;
  const r1 = first.opening.width - TOLERANCE;
  const r2 = second.opening.width - TOLERANCE;
  if (r1 <= TOLERANCE || r2 <= TOLERANCE) return null;
  const worldToLocalVector = (point: Point): Point => ({
    x: dot(point, first.closed), y: dot(point, first.opened),
  });
  const centre = worldToLocalVector(subtract(second.geometry.hinge, first.geometry.hinge));
  const closed = worldToLocalVector(second.closed);
  const opened = worldToLocalVector(second.opened);
  const planes: HalfPlane[] = [
    { normal: { x: 1, y: 0 }, offset: TOLERANCE },
    { normal: { x: 0, y: 1 }, offset: TOLERANCE },
    { normal: closed, offset: dot(centre, closed) + TOLERANCE },
    { normal: opened, offset: dot(centre, opened) + TOLERANCE },
  ];
  let polygon: Point[] = [
    { x: TOLERANCE, y: TOLERANCE }, { x: r1, y: TOLERANCE },
    { x: r1, y: r1 }, { x: TOLERANCE, y: r1 },
  ];
  for (const plane of planes.slice(2)) polygon = clip(polygon, plane);
  if (!polygon.length) return null;
  // Floating-point allowance remains far below the metric inset even at the
  // model's largest coordinates/radii; it never turns original tangency into
  // a collision. Local coordinates avoid cancellation in circle calculations.
  const rounding = Number.EPSILON * 32 * Math.max(1, r1, r2, Math.abs(centre.x), Math.abs(centre.y));
  let closest: Point | null = null;
  let distance = Infinity;
  const consider = (point: Point) => {
    if (Math.hypot(point.x, point.y) > r1 + rounding ||
        planes.some((plane) => dot(point, plane.normal) < plane.offset - rounding)) return;
    const current = Math.hypot(point.x - centre.x, point.y - centre.y);
    if (current < distance) { closest = point; distance = current; }
  };
  consider(centre);
  for (let index = 0; index < polygon.length; index++) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    consider(from);
    const edge = subtract(to, from);
    const squaredLength = dot(edge, edge);
    if (squaredLength === 0) continue;
    const projection = Math.max(0, Math.min(1, dot(subtract(centre, from), edge) / squaredLength));
    consider({ x: from.x + projection * edge.x, y: from.y + projection * edge.y });
    // Intersections of a line segment and disk A's circle. The cross product
    // computes perpendicular distance without subtracting nearly equal squares.
    const cross = from.x * edge.y - from.y * edge.x;
    const perpendicular = Math.abs(cross) / Math.sqrt(squaredLength);
    if (perpendicular > r1 + rounding) continue;
    const middle = -dot(from, edge) / squaredLength;
    const span = Math.sqrt(Math.max(0, (r1 - perpendicular) * (r1 + perpendicular) / squaredLength));
    const parameterRounding = rounding / Math.sqrt(squaredLength);
    for (const parameter of [middle - span, middle + span]) {
      if (parameter < -parameterRounding || parameter > 1 + parameterRounding) continue;
      const t = Math.max(0, Math.min(1, parameter));
      consider({ x: from.x + t * edge.x, y: from.y + t * edge.y });
    }
  }
  const centreDistance = Math.hypot(centre.x, centre.y);
  if (centreDistance > 0) consider({ x: r1 * centre.x / centreDistance, y: r1 * centre.y / centreDistance });
  if (!closest || distance > r2 + rounding) return null;
  // TypeScript cannot observe assignments made by the candidate callback.
  const found: Point = closest;
  return {
    x: first.geometry.hinge.x + found.x * first.closed.x + found.y * first.opened.x,
    y: first.geometry.hinge.y + found.x * first.closed.y + found.y * first.opened.y,
  };
}

/** Potential shared sweep areas for independently movable nominal thin leaves. */
export function analyzeDoorPairCollisions(
  walls: readonly Wall[],
  openings: readonly Opening[],
  limit = 100,
): { collisions: DoorPairCollision[]; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error(tr`Лимит пересечений дверей должен быть целым числом от 1 до 1000.`);
  if (walls.length > 1000 || openings.length > 1000) throw new Error(tr`Диагностика поддерживает не больше 1000 стен и 1000 проёмов.`);
  const ids = new Set<string>();
  for (const wall of walls) {
    if (!wallSchema.safeParse(wall).success) throw new Error(tr`Некорректная стена для проверки открывания.`);
    if (ids.has(wall.id)) throw new Error(tr`Идентификаторы стен и проёмов должны быть уникальными.`);
    ids.add(wall.id);
  }
  const byId = new Map(walls.map((wall) => [wall.id, wall]));
  for (const opening of openings) {
    if (!openingSchema.safeParse(opening).success) throw new Error(tr`Некорректный проём для проверки открывания.`);
    if (ids.has(opening.id)) throw new Error(tr`Идентификаторы стен и проёмов должны быть уникальными.`);
    ids.add(opening.id);
    if (!byId.has(opening.wallId)) throw new Error(tr`Стена проёма не найдена.`);
  }
  // Validate every relational opening constraint before any capped return.
  for (const wall of walls) buildWallSolids(wall, openings);
  const sectors = openings.filter((opening) => opening.kind === "door" && !opening.doorless)
    .sort((first, second) => compareIds(first.id, second.id))
    .map((opening) => createSector(byId.get(opening.wallId)!, opening));
  const collisions: DoorPairCollision[] = [];
  for (let first = 0; first < sectors.length; first++) for (let second = first + 1; second < sectors.length; second++) {
    const a = sectors[first];
    const b = sectors[second];
    if (Math.min(a.opening.sillHeight + a.opening.height, b.opening.sillHeight + b.opening.height) -
        Math.max(a.opening.sillHeight, b.opening.sillHeight) <= TOLERANCE) continue;
    const point = intersection(a, b);
    if (!point) continue;
    if (collisions.length === limit) return { collisions, truncated: true };
    const doorIds: readonly [string, string] = [a.opening.id, b.opening.id];
    collisions.push({ id: `door-pair-collision:${JSON.stringify(doorIds)}`, doorIds, point });
  }
  return { collisions, truncated: false };
}
