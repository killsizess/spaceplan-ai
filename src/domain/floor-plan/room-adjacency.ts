import type { Point } from "@/domain/geometry";
import type { Opening, Wall } from "./types";
import type { WallRoom } from "./wall-rooms";

/** Contour points closer than this to a wall face lie on it (polygon roundoff). */
const FACE_TOLERANCE = 1e-6;
/** Shared stretches and door overlaps shorter than this are touches, not contact. */
const MIN_CONTACT = 1e-6;

export type AdjacencyRoom = Pick<WallRoom, "id" | "outer" | "holes" | "boundaryWallIds">;

export interface SharedWall {
  readonly wallId: string;
  /** Length of the shared stretch along the wall axis, in metres. */
  readonly length: number;
  /** Doors on this wall whose leaf opening overlaps the shared stretch. */
  readonly doorIds: readonly string[];
}

export interface RoomAdjacency {
  /** The two room IDs, sorted. */
  readonly rooms: readonly [string, string];
  /** Total shared length over all walls, in metres. */
  readonly length: number;
  readonly walls: readonly SharedWall[];
  /** All doors connecting the two rooms, sorted. */
  readonly doorIds: readonly string[];
}

export interface ExteriorDoor {
  readonly roomId: string;
  readonly doorId: string;
  readonly wallId: string;
}

export interface RoomAdjacencyResult {
  /** Rooms facing each other across a wall, sorted by their IDs. */
  readonly pairs: readonly RoomAdjacency[];
  /** Doors from a room to no room on the other side of the wall. */
  readonly exteriorDoors: readonly ExteriorDoor[];
}

type Interval = readonly [number, number];

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = result.at(-1);
    if (last && from <= last[1] + MIN_CONTACT) last[1] = Math.max(last[1], to);
    else result.push([from, to]);
  }
  return result;
}

function overlap(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const from = Math.max(a0, b0), to = Math.min(a1, b1);
      if (to - from > MIN_CONTACT) result.push([from, to]);
    }
  }
  return result;
}

const total = (intervals: readonly Interval[]) =>
  intervals.reduce((sum, [from, to]) => sum + (to - from), 0);

/**
 * Stretches of a wall's two long faces covered by a room contour, as intervals
 * along the wall axis from its start. Side +1 is the face right of start → end.
 */
function faceCoverage(room: AdjacencyRoom, wall: Wall): Map<1 | -1, Interval[]> {
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length, uy = dy / length;
  const nx = -uy, ny = ux;
  const half = wall.thickness / 2;
  const across = (point: Point) => (point.x - wall.start.x) * nx + (point.y - wall.start.y) * ny;
  const along = (point: Point) => (point.x - wall.start.x) * ux + (point.y - wall.start.y) * uy;
  const coverage = new Map<1 | -1, Interval[]>([[1, []], [-1, []]]);
  for (const ring of [room.outer, ...room.holes]) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      for (const side of [1, -1] as const) {
        if (Math.abs(across(a) - side * half) > FACE_TOLERANCE || Math.abs(across(b) - side * half) > FACE_TOLERANCE) continue;
        const from = Math.max(0, Math.min(along(a), along(b)));
        const to = Math.min(length, Math.max(along(a), along(b)));
        if (to - from > MIN_CONTACT) coverage.get(side)!.push([from, to]);
      }
    }
  }
  return new Map([...coverage].map(([side, intervals]) => [side, merge(intervals)]));
}

/**
 * Derived, read-only adjacency of wall rooms: two rooms are adjacent when they
 * face each other across the same wall along a stretch of positive length. A door
 * whose opening overlaps that stretch connects them; a door with a room on one
 * face and none on the other leads outside. Windows do not connect rooms. A room
 * on both faces of a free-standing wall is not its own neighbour. Nothing here is
 * saved; results are sorted and do not depend on input order.
 */
export function findRoomAdjacency(
  rooms: readonly AdjacencyRoom[],
  walls: readonly Wall[],
  openings: readonly Opening[],
): RoomAdjacencyResult {
  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const faces = new Map<string, { roomId: string; side: 1 | -1; intervals: Interval[] }[]>();
  for (const room of rooms) {
    for (const wallId of room.boundaryWallIds) {
      const wall = wallsById.get(wallId);
      if (!wall) continue;
      for (const [side, intervals] of faceCoverage(room, wall)) {
        if (!intervals.length) continue;
        faces.set(wallId, [...(faces.get(wallId) ?? []), { roomId: room.id, side, intervals }]);
      }
    }
  }
  const doorsByWall = new Map<string, Opening[]>();
  for (const opening of openings) {
    if (opening.kind !== "door") continue;
    doorsByWall.set(opening.wallId, [...(doorsByWall.get(opening.wallId) ?? []), opening]);
  }

  const pairs = new Map<string, { rooms: [string, string]; walls: SharedWall[] }>();
  const exteriorDoors: ExteriorDoor[] = [];
  for (const [wallId, entries] of faces) {
    const doors = doorsByWall.get(wallId) ?? [];
    for (const first of entries) {
      for (const second of entries) {
        if (first.side !== 1 || second.side !== -1 || first.roomId === second.roomId) continue;
        const shared = overlap(first.intervals, second.intervals);
        if (!shared.length) continue;
        const ids = [first.roomId, second.roomId].sort() as [string, string];
        const key = JSON.stringify(ids);
        const pair = pairs.get(key) ?? { rooms: ids, walls: [] };
        const existing = pair.walls.findIndex((item) => item.wallId === wallId);
        const doorIds = doors
          .filter((door) => overlap([[door.offset, door.offset + door.width]], shared).length > 0)
          .map((door) => door.id);
        const entry = { wallId, length: total(shared), doorIds };
        if (existing >= 0) {
          const before = pair.walls[existing];
          pair.walls[existing] = {
            wallId,
            length: before.length + entry.length,
            doorIds: [...new Set([...before.doorIds, ...doorIds])],
          };
        } else pair.walls.push(entry);
        pairs.set(key, pair);
      }
    }
    for (const door of doors) {
      const span: Interval[] = [[door.offset, door.offset + door.width]];
      for (const side of [1, -1] as const) {
        const inside = entries.filter((entry) => entry.side === side && overlap(entry.intervals, span).length > 0);
        const outside = entries.some((entry) => entry.side === -side && overlap(entry.intervals, span).length > 0);
        if (outside) continue;
        for (const entry of inside) exteriorDoors.push({ roomId: entry.roomId, doorId: door.id, wallId });
      }
    }
  }

  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    pairs: [...pairs.values()]
      .map((pair) => {
        const sharedWalls = pair.walls
          .map((item) => ({ ...item, doorIds: [...item.doorIds].sort(compare) }))
          .sort((a, b) => compare(a.wallId, b.wallId));
        return {
          rooms: pair.rooms,
          length: total(sharedWalls.map((item) => [0, item.length] as const)),
          walls: sharedWalls,
          doorIds: [...new Set(sharedWalls.flatMap((item) => item.doorIds))].sort(compare),
        };
      })
      .sort((a, b) => compare(a.rooms[0], b.rooms[0]) || compare(a.rooms[1], b.rooms[1])),
    exteriorDoors: exteriorDoors.sort((a, b) =>
      compare(a.roomId, b.roomId) || compare(a.doorId, b.doorId)),
  };
}
