import { tr } from "@/lib/i18n";
export type Point = Readonly<{ x: number; y: number }>;
export type Rectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export const MIN_ROOM_SIZE = 0.5;
export const MAX_ROOM_SIZE = 100;
export const MAX_COORDINATE = 1000;
/** Longest wall, opening offset/width and underlay edge accepted by the format. */
export const MAX_PLAN_DIMENSION = 2000;
const EPSILON = 1e-9;

export function validateRoomDimensions(
  width: number,
  height: number,
): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height))
    return tr`Введите числовые размеры комнаты.`;
  if (width < MIN_ROOM_SIZE || height < MIN_ROOM_SIZE)
    return tr`Каждая сторона должна быть не меньше 0,5 м.`;
  if (width > MAX_ROOM_SIZE || height > MAX_ROOM_SIZE)
    return tr`Каждая сторона должна быть не больше 100 м.`;
  return null;
}

export function assertPoint(point: Point): void {
  if (
    ![point.x, point.y].every(
      (v) => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE,
    )
  ) {
    throw new Error(tr`Координаты должны быть числами в пределах ±1000 м.`);
  }
}

export function rectangleArea(width: number, height: number): number {
  const error = validateRoomDimensions(width, height);
  if (error) throw new Error(error);
  return width * height;
}

export function wallLength(a: Point, b: Point): number {
  assertPoint(a);
  assertPoint(b);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= EPSILON) throw new Error(tr`Стена должна иметь ненулевую длину.`);
  return length;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.abs(cross(a, b, p)) <= EPSILON &&
    p.x >= Math.min(a.x, b.x) - EPSILON &&
    p.x <= Math.max(a.x, b.x) + EPSILON &&
    p.y >= Math.min(a.y, b.y) - EPSILON &&
    p.y <= Math.max(a.y, b.y) + EPSILON
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  if (
    ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
  )
    return true;
  return (
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

/** Area of a simple, unclosed polygon in m². Rejects invalid topology. */
export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3 || points.length > 1000)
    throw new Error(tr`Контур должен содержать от 3 до 1000 вершин.`);
  points.forEach(assertPoint);
  if (new Set(points.map((p) => `${p.x},${p.y}`)).size !== points.length)
    throw new Error(tr`Вершины контура не должны повторяться.`);
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const a = points[i],
      b = points[(i + 1) % count],
      c = points[(i + 2) % count];
    wallLength(a, b);
    // Adjacent edges may be collinear but cannot double back over one another.
    if (
      Math.abs(cross(a, b, c)) <= EPSILON &&
      (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < -EPSILON
    ) {
      throw new Error(tr`Рёбра контура перекрываются.`);
    }
    for (let j = i + 1; j < count; j++) {
      if (j === i + 1 || (i === 0 && j === count - 1)) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % count]))
        throw new Error(tr`Контур пересекает сам себя.`);
    }
  }
  const origin = points[0];
  let twiceArea = 0;
  for (let i = 1; i < count - 1; i++)
    twiceArea += cross(origin, points[i], points[i + 1]);
  const area = Math.abs(twiceArea) / 2;
  if (area <= EPSILON)
    throw new Error(tr`Контур должен иметь ненулевую площадь.`);
  return area;
}

export function assertRectangle(rect: Rectangle): void {
  const error = validateRoomDimensions(rect.width, rect.height);
  if (error) throw new Error(error);
  assertPoint(rect);
  assertPoint({ x: rect.x + rect.width, y: rect.y + rect.height });
}

/** Shared edges are permitted; interiors must not overlap. */
export function rectanglesOverlap(a: Rectangle, b: Rectangle): boolean {
  assertRectangle(a);
  assertRectangle(b);
  return (
    a.x < b.x + b.width - EPSILON &&
    a.x + a.width > b.x + EPSILON &&
    a.y < b.y + b.height - EPSILON &&
    a.y + a.height > b.y + EPSILON
  );
}
