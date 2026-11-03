import polygonClipping, {
  type MultiPolygon,
  type Polygon,
  type Ring,
} from "polygon-clipping";
import {
  MAX_ROOM_SIZE,
  assertPoint,
  wallLength,
  type Point,
} from "@/domain/geometry";
import type { Wall } from "./types";

const { difference, union } = polygonClipping;

export const MIN_WALL_ROOM_AREA = 0.25;
const MAX_WALLS = 1000;
const MAX_ROOMS = 100;
const MAX_CLIPPING_VERTICES = 20_000;
const EPSILON = 1e-9;
const COLORS = [
  "#dfe8df",
  "#ede3d4",
  "#dce8ed",
  "#e5e1ec",
  "#e8e5dd",
  "#eeeae3",
];

export interface WallRoom {
  /** Derived key from `boundaryWallIds` (see `wallRoomKey`); never serialized. */
  id: string;
  name: string;
  color: string;
  outer: Point[];
  holes: Point[][];
  area: number;
  perimeter: number;
  labelPoint: Point;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Sorted IDs of walls whose physical faces form the outer contour or a hole. */
  boundaryWallIds: string[];
}

export interface WallRoomDetection {
  rooms: WallRoom[];
  warnings: string[];
}

const comparePoint = (first: Point, second: Point) =>
  first.x - second.x || first.y - second.y;
const samePoint = (first: Point, second: Point) =>
  first.x === second.x && first.y === second.y;
const cleanZero = (value: number) => (Object.is(value, -0) ? 0 : value);

function signedArea(points: readonly Point[]): number {
  const origin = points[0];
  let twice = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const first = points[index],
      second = points[index + 1];
    twice +=
      (first.x - origin.x) * (second.y - origin.y) -
      (first.y - origin.y) * (second.x - origin.x);
  }
  return twice / 2;
}

/** Preserve actual coordinates; normalize only winding, start vertex and negative zero. */
function canonicalRing(ring: Ring, counterClockwise: boolean): Point[] {
  const points = ring.map(([x, y]) => ({ x: cleanZero(x), y: cleanZero(y) }));
  if (points.length > 1 && samePoint(points[0], points[points.length - 1]))
    points.pop();
  if (
    points.length < 3 ||
    points.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  ) {
    throw new Error("Не удалось построить корректный контур помещения.");
  }
  const area = signedArea(points);
  if (area === 0) throw new Error("Контур помещения имеет нулевую площадь.");
  if (area > 0 !== counterClockwise) points.reverse();
  let start = 0;
  for (let index = 1; index < points.length; index++) {
    if (comparePoint(points[index], points[start]) < 0) start = index;
  }
  return [...points.slice(start), ...points.slice(0, start)];
}

function compareRing(
  first: readonly Point[],
  second: readonly Point[],
): number {
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const compared = comparePoint(first[index], second[index]);
    if (compared !== 0) return compared;
  }
  return first.length - second.length;
}

export function wallFootprint(wall: Wall): Polygon {
  // Canonical direction makes reversing a wall produce identical floating-point operations.
  const [start, end] =
    comparePoint(wall.start, wall.end) <= 0
      ? [wall.start, wall.end]
      : [wall.end, wall.start];
  const length = wallLength(start, end);
  const normalX = ((-(end.y - start.y) / length) * wall.thickness) / 2;
  const normalY = (((end.x - start.x) / length) * wall.thickness) / 2;
  return [
    [
      [start.x + normalX, start.y + normalY],
      [start.x - normalX, start.y - normalY],
      [end.x - normalX, end.y - normalY],
      [end.x + normalX, end.y + normalY],
    ],
  ];
}

function validateWalls(walls: readonly Wall[]): void {
  if (walls.length > MAX_WALLS)
    throw new Error("Для определения помещений допустимо не больше 1000 стен.");
  const ids = new Set<string>();
  for (const wall of walls) {
    if (
      typeof wall.id !== "string" ||
      !wall.id.trim() ||
      wall.id.length > 100 ||
      ids.has(wall.id)
    ) {
      throw new Error(
        "У каждой стены должен быть уникальный непустой идентификатор.",
      );
    }
    ids.add(wall.id);
    assertPoint(wall.start);
    assertPoint(wall.end);
    if (wallLength(wall.start, wall.end) > 2000)
      throw new Error("Длина стены не должна превышать 2000 м.");
    if (
      ![wall.thickness, wall.height].every(
        (value) =>
          Number.isFinite(value) && value > 0 && value <= MAX_ROOM_SIZE,
      )
    ) {
      throw new Error(
        "Толщина и высота стены должны быть положительными числами не больше 100 м.",
      );
    }
  }
}

function assertClipComplexity(polygons: MultiPolygon): void {
  let vertices = 0;
  for (const polygon of polygons)
    for (const ring of polygon) vertices += ring.length;
  if (vertices > MAX_CLIPPING_VERTICES) {
    throw new Error(
      "Слишком сложный контур стен. Упростите план для определения помещений.",
    );
  }
}

function boundsOf(points: readonly Point[]): WallRoom["bounds"] {
  return points.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      minY: Math.min(result.minY, point.y),
      maxX: Math.max(result.maxX, point.x),
      maxY: Math.max(result.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

type Segment = readonly [Point, Point];
const ringSegments = (ring: readonly Point[]): Segment[] =>
  ring.map((point, index) => [point, ring[(index + 1) % ring.length]]);

/** A positive length of the room edge must lie on a physical wall edge. */
function overlaps([a, b]: Segment, [c, d]: Segment): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length <= EPSILON) return false;
  const distance = (point: Point) => Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x)) / length;
  if (distance(c) > EPSILON || distance(d) > EPSILON) return false;
  const project = (point: Point) => ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
  const first = project(c), second = project(d);
  return Math.min(length, Math.max(first, second)) - Math.max(0, Math.min(first, second)) > EPSILON;
}

interface WallFaces {
  id: string;
  edges: Segment[];
  bounds: WallRoom["bounds"];
}

function wallFaces(walls: readonly Wall[]): WallFaces[] {
  return walls.map((wall) => {
    const ring = wallFootprint(wall)[0].map(([x, y]) => ({ x, y }));
    return { id: wall.id, edges: ringSegments(ring), bounds: boundsOf(ring) };
  });
}

/** The box test only skips distant walls; the edge test decides. */
function boundaryWalls(
  rings: readonly Point[][],
  bounds: WallRoom["bounds"],
  faces: readonly WallFaces[],
): string[] {
  const margin = 1e-6;
  const contour = rings.flatMap(ringSegments);
  return faces
    .filter(
      (wall) =>
        wall.bounds.minX <= bounds.maxX + margin &&
        wall.bounds.maxX >= bounds.minX - margin &&
        wall.bounds.minY <= bounds.maxY + margin &&
        wall.bounds.maxY >= bounds.minY - margin &&
        wall.edges.some((edge) => contour.some((segment) => overlaps(segment, edge))),
    )
    .map((wall) => wall.id)
    .sort();
}

function ringPerimeter(ring: readonly Point[]): number {
  let perimeter = 0;
  for (let index = 0; index < ring.length; index++) {
    const next = ring[(index + 1) % ring.length];
    perimeter += Math.hypot(next.x - ring[index].x, next.y - ring[index].y);
  }
  return perimeter;
}

/** -1 outside, 0 on boundary, 1 inside. */
function locateInRing(point: Point, ring: readonly Point[]): -1 | 0 | 1 {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const first = ring[index],
      second = ring[(index + 1) % ring.length];
    const cross =
      (second.x - first.x) * (point.y - first.y) -
      (second.y - first.y) * (point.x - first.x);
    if (
      Math.abs(cross) <= EPSILON &&
      point.x >= Math.min(first.x, second.x) &&
      point.x <= Math.max(first.x, second.x) &&
      point.y >= Math.min(first.y, second.y) &&
      point.y <= Math.max(first.y, second.y)
    )
      return 0;
    if (
      first.y > point.y !== second.y > point.y &&
      point.x <
        first.x +
          ((point.y - first.y) * (second.x - first.x)) / (second.y - first.y)
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}

function interiorLabel(
  outer: Point[],
  holes: Point[][],
  bounds: WallRoom["bounds"],
): Point {
  const rings = [outer, ...holes];
  const isInside = (point: Point) =>
    locateInRing(point, outer) === 1 &&
    holes.every((hole) => locateInRing(point, hole) === -1);
  // Signed centroid accounts for holes, but may still lie outside a concave room.
  const origin = outer[0];
  let sumCross = 0,
    sumX = 0,
    sumY = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const first = ring[index],
        second = ring[(index + 1) % ring.length];
      const ax = first.x - origin.x,
        ay = first.y - origin.y;
      const bx = second.x - origin.x,
        by = second.y - origin.y;
      const cross = ax * by - bx * ay;
      sumCross += cross;
      sumX += (ax + bx) * cross;
      sumY += (ay + by) * cross;
    }
  }
  const centroid = {
    x: origin.x + sumX / (3 * sumCross),
    y: origin.y + sumY / (3 * sumCross),
  };
  if (
    Number.isFinite(centroid.x) &&
    Number.isFinite(centroid.y) &&
    isInside(centroid)
  )
    return centroid;
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  if (isInside(center)) return center;

  // A midpoint between vertex levels cannot coincide with a horizontal boundary.
  const levels = [
    ...new Set(rings.flatMap((ring) => ring.map((point) => point.y))),
  ].sort((a, b) => a - b);
  const bands = levels
    .slice(1)
    .map((next, index) => ({
      y: (levels[index] + next) / 2,
      height: next - levels[index],
    }))
    .sort((a, b) => b.height - a.height || a.y - b.y);
  for (const band of bands) {
    const intersections: number[] = [];
    for (const ring of rings)
      for (let index = 0; index < ring.length; index++) {
        const first = ring[index],
          second = ring[(index + 1) % ring.length];
        if (first.y > band.y !== second.y > band.y) {
          intersections.push(
            first.x +
              ((band.y - first.y) * (second.x - first.x)) /
                (second.y - first.y),
          );
        }
      }
    intersections.sort((a, b) => a - b);
    const spans: { point: Point; width: number }[] = [];
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const point = {
        x: (intersections[index] + intersections[index + 1]) / 2,
        y: band.y,
      };
      if (isInside(point))
        spans.push({
          point,
          width: intersections[index + 1] - intersections[index],
        });
    }
    spans.sort((a, b) => b.width - a.width || a.point.x - b.point.x);
    if (spans.length) return spans[0].point;
  }
  throw new Error("Не удалось выбрать внутреннюю точку помещения.");
}

/**
 * Room key from the walls that bound it. Coordinates, thickness, wall order and
 * direction do not affect it, so resizing or moving keeps the key. Any change of
 * the boundary set (split, merge, new partition, island or split boundary wall)
 * gives a new key; persistent names live in wallRoomLabels instead.
 */
export function wallRoomKey(boundaryWallIds: readonly string[]): string {
  const text = JSON.stringify([...boundaryWallIds].sort());
  let first = 2166136261,
    second = 2246822507;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second ^ text.charCodeAt(index), 3266489909);
  }
  return `wall-room:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

/** Detections kept for recent wall sets (undo/redo, schema, labels, view, saving). */
const CACHE_SIZE = 16;
const cache = new Map<string, WallRoomDetection>();
const stats = { computed: 0, reused: 0 };

/** Every input that affects the result or its errors, unambiguous for any wall ID. */
function wallsKey(walls: readonly Wall[]): string {
  const number = (value: unknown) =>
    typeof value === "number" ? (Object.is(value, -0) ? "-0" : String(value)) : JSON.stringify(value ?? null);
  return walls
    .map((wall) => {
      const start = wall?.start, end = wall?.end;
      return `${JSON.stringify(wall?.id ?? null)}|${number(start?.x)},${number(start?.y)},${number(end?.x)},${number(end?.y)},${number(wall?.thickness)},${number(wall?.height)}`;
    })
    .join(";");
}

function freezeDetection(detection: WallRoomDetection): WallRoomDetection {
  for (const room of detection.rooms) {
    room.outer.forEach(Object.freeze);
    for (const hole of room.holes) {
      hole.forEach(Object.freeze);
      Object.freeze(hole);
    }
    Object.freeze(room.outer);
    Object.freeze(room.holes);
    Object.freeze(room.labelPoint);
    Object.freeze(room.bounds);
    Object.freeze(room.boundaryWallIds);
    Object.freeze(room);
  }
  Object.freeze(detection.rooms);
  Object.freeze(detection.warnings);
  return Object.freeze(detection);
}

/** Counters for tests and measurements: real computations versus reused results. */
export function wallRoomDetectionStats(): { computed: number; reused: number } {
  return { ...stats };
}

/**
 * Finds bounded floor space enclosed by physical wall footprints, excluding their
 * thickness and internal wall islands. Walls have the same rectangular butt ends
 * as the 3D viewer. Small axis gaps can therefore close when solids overlap.
 * Door/window openings do not remove the semantic room boundary. Room IDs are
 * `wallRoomKey(boundaryWallIds)`; equal boundary sets get a suffix in room order.
 *
 * The result depends only on the walls' IDs, coordinates, thickness and height,
 * so it is reused for an equal wall list (Zod copies plans, so array identity is
 * useless as a key). The returned object is shared and deeply frozen; errors are
 * not cached and are thrown again on the next call.
 */
export function detectWallRooms(walls: readonly Wall[]): WallRoomDetection {
  // Malformed input keeps the uncached path and its original error messages.
  if (!Array.isArray(walls)) return computeWallRooms(walls);
  const key = wallsKey(walls);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    stats.reused++;
    return cached;
  }
  const detection = freezeDetection(computeWallRooms(walls));
  stats.computed++;
  cache.set(key, detection);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return detection;
}

function computeWallRooms(walls: readonly Wall[]): WallRoomDetection {
  validateWalls(walls);
  if (walls.length === 0)
    return {
      rooms: [],
      warnings: [
        "Добавьте стены и замкните контур, чтобы определить помещения.",
      ],
    };
  const footprints = walls.map(wallFootprint).sort((a, b) => {
    return compareRing(canonicalRing(a[0], true), canonicalRing(b[0], true));
  });
  let spaces: MultiPolygon;
  try {
    const solids = union(footprints[0], ...footprints.slice(1));
    assertClipComplexity(solids);
    const cavities: Polygon[] = solids.flatMap((polygon) =>
      polygon.slice(1).map((ring) => [ring]),
    );
    if (cavities.length === 0)
      return {
        rooms: [],
        warnings: [
          "Замкнутые помещения не найдены. Проверьте соединения стен.",
        ],
      };
    if (cavities.length > 1000)
      throw new Error("Слишком много замкнутых контуров стен.");
    // Nested cavities must be merged first, otherwise inner rooms are counted twice.
    const bounded = union(cavities[0], ...cavities.slice(1));
    spaces = difference(bounded, solids);
    assertClipComplexity(spaces);
  } catch (error) {
    const detail =
      error instanceof Error && /Слишком/.test(error.message)
        ? error.message
        : "Проверьте геометрию и упростите пересечения стен.";
    throw new Error(`Не удалось определить помещения. ${detail}`);
  }

  const faces = wallFaces(walls);
  const rooms: WallRoom[] = [];
  let excluded = 0;
  for (const polygon of spaces) {
    const outer = canonicalRing(polygon[0], true);
    const holes = polygon
      .slice(1)
      .map((ring) => canonicalRing(ring, false))
      .sort(compareRing);
    const area =
      signedArea(outer) +
      holes.reduce((total, hole) => total + signedArea(hole), 0);
    if (area < MIN_WALL_ROOM_AREA - EPSILON) {
      excluded += 1;
      continue;
    }
    const bounds = boundsOf(outer);
    const boundaryWallIds = boundaryWalls([outer, ...holes], bounds, faces);
    rooms.push({
      id: wallRoomKey(boundaryWallIds),
      name: "",
      color: "",
      outer,
      holes,
      area,
      perimeter:
        ringPerimeter(outer) +
        holes.reduce((total, hole) => total + ringPerimeter(hole), 0),
      labelPoint: interiorLabel(outer, holes, bounds),
      bounds,
      boundaryWallIds,
    });
  }
  if (rooms.length > MAX_ROOMS)
    throw new Error(
      "Найдено больше 100 помещений. Разделите план на несколько проектов.",
    );
  rooms.sort(
    (a, b) =>
      a.bounds.minY - b.bounds.minY ||
      a.bounds.minX - b.bounds.minX ||
      compareRing(a.outer, b.outer) ||
      a.id.localeCompare(b.id),
  );
  const usedIds = new Set<string>();
  rooms.forEach((room, index) => {
    const originalId = room.id;
    let suffix = 1;
    while (usedIds.has(room.id)) room.id = `${originalId}-${suffix++}`;
    usedIds.add(room.id);
    room.name = `Помещение ${index + 1}`;
    room.color = COLORS[index % COLORS.length];
  });
  const warnings =
    excluded > 0
      ? [`Не учтено контуров площадью менее 0,25 м²: ${excluded}.`]
      : [];
  if (rooms.length === 0)
    warnings.push(
      "Помещения достаточной площади не найдены. Проверьте размеры и соединения стен.",
    );
  return { rooms, warnings };
}
