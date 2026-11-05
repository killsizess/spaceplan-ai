import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import { resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import type { FloorPlan, Opening, RoomKind, Wall } from "@/domain/floor-plan/types";
import type { Point } from "@/domain/geometry";

/** A room as rules see it, whether it came from walls or was entered as a rectangle. */
export interface RuleRoom {
  id: string;
  name: string;
  kind: RoomKind;
  area: number;
  outer: readonly Point[];
  holes: readonly (readonly Point[])[];
  boundaryWallIds: readonly string[];
}

export interface RuleRooms {
  rooms: RuleRoom[];
  /** Why the rooms of a wall plan cannot be computed. */
  unresolved?: string;
}

export function roomsOfPlan(plan: FloorPlan): RuleRooms {
  if (plan.roomMode === "manual") {
    return {
      rooms: plan.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        kind: room.kind,
        area: room.width * room.height,
        outer: [
          { x: room.x, y: room.y },
          { x: room.x + room.width, y: room.y },
          { x: room.x + room.width, y: room.y + room.height },
          { x: room.x, y: room.y + room.height },
        ],
        holes: [],
        boundaryWallIds: [],
      })),
    };
  }
  try {
    return { rooms: resolveWallRoomLabels(plan).rooms };
  } catch (error) {
    return {
      rooms: [],
      unresolved: error instanceof Error ? error.message : "Не удалось определить помещения.",
    };
  }
}

const ring = (points: readonly Point[]): Ring => {
  const closed = points.map((point): [number, number] => [point.x, point.y]);
  closed.push(closed[0]);
  return closed;
};
const polygon = (room: Pick<RuleRoom, "outer" | "holes">): Polygon => [ring(room.outer), ...room.holes.map(ring)];

function ringArea(points: Ring): number {
  let twice = 0;
  for (let index = 0; index + 1 < points.length; index++) {
    twice += points[index][0] * points[index + 1][1] - points[index + 1][0] * points[index][1];
  }
  return Math.abs(twice) / 2;
}
function area(shape: MultiPolygon): number {
  return shape.reduce(
    (sum, [outer, ...holes]) => sum + ringArea(outer) - holes.reduce((total, hole) => total + ringArea(hole), 0),
    0,
  );
}

export function overlapArea(a: Pick<RuleRoom, "outer" | "holes">, b: Pick<RuleRoom, "outer" | "holes">): number {
  return area(polygonClipping.intersection(polygon(a), polygon(b)));
}

/** Differences this small are drawing noise, not a changed room. */
const SAME_SHAPE_TOLERANCE = 0.02;

export function sameShape(a: Pick<RuleRoom, "outer" | "holes">, b: Pick<RuleRoom, "outer" | "holes">): boolean {
  return area(polygonClipping.xor(polygon(a), polygon(b))) <= SAME_SHAPE_TOLERANCE;
}

function insideRing(point: Point, points: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index], b = points[previous];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInRoom(point: Point, room: Pick<RuleRoom, "outer" | "holes">): boolean {
  return insideRing(point, room.outer) && !room.holes.some((hole) => insideRing(point, hole));
}

/** How far past the wall face a side is sampled, in metres. */
const SIDE_SAMPLE = 0.05;

/** The rooms on both sides of a wall at `along` metres from its start; null where no room is. */
export function roomsBeside(
  wall: Wall,
  along: number,
  rooms: readonly RuleRoom[],
): [RuleRoom | null, RuleRoom | null] {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1;
  const ux = (wall.end.x - wall.start.x) / length, uy = (wall.end.y - wall.start.y) / length;
  const base = { x: wall.start.x + ux * along, y: wall.start.y + uy * along };
  const reach = wall.thickness / 2 + SIDE_SAMPLE;
  const side = (sign: number) => {
    const point = { x: base.x - uy * reach * sign, y: base.y + ux * reach * sign };
    return rooms.find((room) => pointInRoom(point, room)) ?? null;
  };
  return [side(1), side(-1)];
}

/** Metres from the wall's start to the middle of an opening. */
export const openingCentre = (opening: Opening): number => opening.offset + opening.width / 2;

const wallLength = (wall: Wall) => Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

/** True when some stretch of the wall has a room on one side and none on the other. */
export function isPerimeterWall(wall: Wall, rooms: readonly RuleRoom[]): boolean {
  const length = wallLength(wall);
  return [0.25, 0.5, 0.75].some((share) => {
    const [first, second] = roomsBeside(wall, length * share, rooms);
    return Boolean(first) !== Boolean(second);
  });
}

/** True when the opening has a room on one side and none on the other. */
export function isPerimeterOpening(wall: Wall, opening: Opening, rooms: readonly RuleRoom[]): boolean {
  const [first, second] = roomsBeside(wall, openingCentre(opening), rooms);
  return Boolean(first) !== Boolean(second);
}
