import {
  assertPoint,
  validateRoomDimensions,
  type Point,
} from "@/domain/geometry";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Wall } from "./types";
import { rebaseOpenings, sameWallNode } from "./wall-nodes";
import { detectWallRooms, type WallRoom } from "./wall-rooms";

export interface RectangularWallRoomInput {
  /** Top-left corner of the usable interior, in metres. */
  x: number;
  y: number;
  width: number;
  depth: number;
  thickness: number;
  wallHeight: number;
}

/** Clockwise order: top, right, bottom, left. */
export type WallIdTuple = readonly [string, string, string, string];

export interface RectangularRoomWalls {
  top: Wall;
  right: Wall;
  bottom: Wall;
  left: Wall;
  width: number;
  depth: number;
}

const EPSILON = 1e-9;
const near = (a: number, b: number) => Math.abs(a - b) <= EPSILON;
const exactPoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function validateDimensions(width: number, depth: number): void {
  const error = validateRoomDimensions(width, depth);
  if (error) throw new Error(error);
}

function validatedPlan(plan: FloorPlan): FloorPlan {
  const parsed = floorPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom");
    throw new Error(issue?.message ?? "Проверьте размеры и свойства стен комнаты.");
  }
  return parsed.data;
}

function isRectangle(room: WallRoom): boolean {
  const { minX, minY, maxX, maxY } = room.bounds;
  const corners: Point[] = [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
  return (
    room.holes.length === 0 &&
    room.outer.length === 4 &&
    maxX > minX && maxY > minY &&
    corners.every((corner) => room.outer.some((point) => sameWallNode(point, corner))) &&
    Math.abs(room.area - (maxX - minX) * (maxY - minY)) <=
      EPSILON * Math.max(1, room.area)
  );
}

function sameRoom(a: WallRoom, b: WallRoom): boolean {
  return (
    a.holes.length === b.holes.length &&
    a.outer.length === b.outer.length &&
    a.outer.every((point, index) => sameWallNode(point, b.outer[index])) &&
    near(a.bounds.minX, b.bounds.minX) && near(a.bounds.minY, b.bounds.minY) &&
    near(a.bounds.maxX, b.bounds.maxX) && near(a.bounds.maxY, b.bounds.maxY) &&
    Math.abs(a.area - b.area) <= EPSILON * Math.max(1, b.area)
  );
}

function joins(wall: Wall, first: Point, second: Point): boolean {
  return (
    (sameWallNode(wall.start, first) && sameWallNode(wall.end, second)) ||
    (sameWallNode(wall.end, first) && sameWallNode(wall.start, second))
  );
}

/** Resolve one complete wall per side; split, overlapping or extended sides are ambiguous. */
function resolveWalls(plan: FloorPlan, room: WallRoom): RectangularRoomWalls | null {
  if (!isRectangle(room)) return null;
  const { minX, minY, maxX, maxY } = room.bounds;
  const horizontal = (wall: Wall) => near(wall.start.y, wall.end.y);
  const vertical = (wall: Wall) => near(wall.start.x, wall.end.x);
  const overlapsX = (wall: Wall) =>
    Math.min(wall.start.x, wall.end.x) < maxX - EPSILON &&
    Math.max(wall.start.x, wall.end.x) > minX + EPSILON;
  const overlapsY = (wall: Wall) =>
    Math.min(wall.start.y, wall.end.y) < maxY - EPSILON &&
    Math.max(wall.start.y, wall.end.y) > minY + EPSILON;
  const sides = [
    plan.walls.filter((wall) => horizontal(wall) && overlapsX(wall) && near(wall.start.y + wall.thickness / 2, minY)),
    plan.walls.filter((wall) => vertical(wall) && overlapsY(wall) && near(wall.start.x - wall.thickness / 2, maxX)),
    plan.walls.filter((wall) => horizontal(wall) && overlapsX(wall) && near(wall.start.y - wall.thickness / 2, maxY)),
    plan.walls.filter((wall) => vertical(wall) && overlapsY(wall) && near(wall.start.x + wall.thickness / 2, minX)),
  ];
  if (sides.some((candidates) => candidates.length !== 1)) return null;
  const [top, right, bottom, left] = sides.map((candidates) => candidates[0]);
  const ids = new Set([top.id, right.id, bottom.id, left.id]);
  if (ids.size !== 4) return null;
  const corners: Point[] = [
    { x: left.start.x, y: top.start.y },
    { x: right.start.x, y: top.start.y },
    { x: right.start.x, y: bottom.start.y },
    { x: left.start.x, y: bottom.start.y },
  ];
  if (![top, right, bottom, left].every((wall, index) => joins(wall, corners[index], corners[(index + 1) % 4])))
    return null;

  // A T contact in the middle cannot be carried safely by endpoint-only editing.
  for (const wall of plan.walls) {
    if (ids.has(wall.id)) continue;
    for (const point of [wall.start, wall.end]) {
      if (corners.some((corner) => sameWallNode(point, corner))) continue;
      if (
        ((near(point.y, top.start.y) || near(point.y, bottom.start.y)) &&
          point.x > corners[0].x + EPSILON && point.x < corners[1].x - EPSILON) ||
        ((near(point.x, left.start.x) || near(point.x, right.start.x)) &&
          point.y > corners[0].y + EPSILON && point.y < corners[3].y - EPSILON)
      ) return null;
    }
  }
  return { top, right, bottom, left, width: maxX - minX, depth: maxY - minY };
}

/** Current detected contour only: stale room snapshots cannot move newer geometry. */
export function getRectangularRoomWalls(
  plan: FloorPlan,
  room: WallRoom,
): RectangularRoomWalls | null {
  if (plan.roomMode !== "walls" || !isRectangle(room)) return null;
  try {
    const current = detectWallRooms(plan.walls).rooms.find((item) => sameRoom(room, item));
    return current ? resolveWalls(plan, current) : null;
  } catch {
    return null;
  }
}

function expectedRoom(
  plan: FloorPlan,
  x: number,
  y: number,
  width: number,
  depth: number,
): WallRoom | undefined {
  return detectWallRooms(plan.walls).rooms.find((room) =>
    isRectangle(room) && near(room.bounds.minX, x) && near(room.bounds.minY, y) &&
    near(room.bounds.maxX, x + width) && near(room.bounds.maxY, y + depth),
  );
}

/** Four physical walls enclose exactly width × depth of usable floor space. */
export function addRectangularWallRoom(
  plan: FloorPlan,
  input: RectangularWallRoomInput,
  wallIds: WallIdTuple,
): FloorPlan {
  validateDimensions(input.width, input.depth);
  assertPoint(input);
  if (
    ![input.thickness, input.wallHeight].every((value) => Number.isFinite(value) && value > 0 && value <= 100)
  ) throw new Error("Толщина и высота стен должны быть больше 0 и не больше 100 м.");
  if (
    wallIds.length !== 4 || new Set(wallIds).size !== 4 ||
    wallIds.some((id) => !id || id.length > 100 || [...plan.rooms, ...plan.walls, ...plan.openings].some((item) => item.id === id))
  ) throw new Error("Для комнаты нужны четыре новых уникальных идентификатора стен.");
  const half = input.thickness / 2;
  const corners: Point[] = [
    { x: input.x - half, y: input.y - half },
    { x: input.x + input.width + half, y: input.y - half },
    { x: input.x + input.width + half, y: input.y + input.depth + half },
    { x: input.x - half, y: input.y + input.depth + half },
  ];
  const walls = wallIds.map((id, index): Wall => ({
    id, start: corners[index], end: corners[(index + 1) % 4],
    thickness: input.thickness, height: input.wallHeight,
  }));
  const next = validatedPlan({ ...plan, roomMode: "walls", walls: [...plan.walls, ...walls] });
  const room = expectedRoom(next, input.x, input.y, input.width, input.depth);
  if (!room || !resolveWalls(next, room))
    throw new Error("Комната пересекает существующие стены или имеет неоднозначную границу.");
  return next;
}

/**
 * Keep the interior top-left fixed; move all three other corner nodes atomically.
 * Openings keep their plan position on walls that only grow or shrink.
 */
export function resizeRectangularWallRoom(
  plan: FloorPlan,
  room: WallRoom,
  width: number,
  depth: number,
): FloorPlan {
  validateDimensions(width, depth);
  const boundary = getRectangularRoomWalls(plan, room);
  if (!boundary)
    throw new Error("Помещение изменилось или его граница не состоит из четырёх соединённых прямых стен.");
  if (near(width, boundary.width) && near(depth, boundary.depth)) return plan;
  const { top, right, bottom, left } = boundary;
  const oldCorners: Point[] = [
    { x: left.start.x, y: top.start.y },
    { x: right.start.x, y: top.start.y },
    { x: right.start.x, y: bottom.start.y },
    { x: left.start.x, y: bottom.start.y },
  ];
  const rightX = room.bounds.minX + width + right.thickness / 2;
  const bottomY = room.bounds.minY + depth + bottom.thickness / 2;
  const newCorners: Point[] = [
    oldCorners[0],
    { x: rightX, y: oldCorners[0].y },
    { x: rightX, y: bottomY },
    { x: oldCorners[0].x, y: bottomY },
  ];
  newCorners.forEach(assertPoint);
  const move = (point: Point): Point => {
    const index = oldCorners.findIndex((corner) => sameWallNode(point, corner));
    return index === -1 ? point : newCorners[index];
  };
  const walls = plan.walls.map((wall) => {
    const start = move(wall.start), end = move(wall.end);
    return exactPoint(start, wall.start) && exactPoint(end, wall.end)
      ? wall : { ...wall, start, end };
  });
  const next = validatedPlan({
    ...plan,
    walls,
    openings: [...rebaseOpenings(plan.walls, walls, plan.openings)],
  });
  const resized = expectedRoom(next, room.bounds.minX, room.bounds.minY, width, depth);
  if (!resized || !resolveWalls(next, resized))
    throw new Error("Новый размер пересекает другие стены или нарушает прямоугольный контур комнаты.");
  return next;
}
