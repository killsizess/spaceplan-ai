import { describe, expect, it } from "vitest";
import { createDefaultRoom, createEmptyPlan } from "@/domain/floor-plan/operations";
import { findRoomAdjacency } from "@/domain/floor-plan/room-adjacency";
import type { FloorPlan, Opening, Wall } from "@/domain/floor-plan/types";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { detectViewRooms, roomNeighbours } from "./view-rooms";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7 });
const door = (id: string, wallId: string, offset: number): Opening =>
  ({ id, wallId, kind: "door", offset, width: 0.9, height: 2.1, sillHeight: 0 });

function apartment(): FloorPlan {
  return {
    ...createEmptyPlan("view rooms"),
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0), wall("right", 10, 0, 10, 6), wall("bottom", 10, 6, 0, 6), wall("left", 0, 6, 0, 0),
      wall("partition", 6, 0, 6, 6), wall("branch", 6, 3, 10, 3),
    ],
    openings: [door("door-partition", "partition", 1), door("door-branch", "branch", 1)],
  };
}

const roomAt = (rooms: readonly WallRoom[], x: number, y: number) =>
  rooms.find((room) => room.bounds.minX < x && x < room.bounds.maxX && room.bounds.minY < y && y < room.bounds.maxY)!;

describe("editor view rooms", () => {
  it("shows no derived rooms for manual plans", () => {
    expect(detectViewRooms({ ...apartment(), roomMode: "manual" })).toEqual({ rooms: [], warnings: [], unassigned: [] });
  });

  it("renames a derived room whose ID is taken by a stored object, keeping the others", () => {
    const plan = apartment();
    const plain = detectViewRooms(plan).rooms;
    expect(plain).toHaveLength(3);
    const taken = plain[0].id;
    const withClash: FloorPlan = { ...plan, rooms: [createDefaultRoom(plan, taken)] };
    const rooms = detectViewRooms(withClash).rooms;
    expect(rooms.map((room) => room.id)).toEqual([`${taken}:view-1`, ...plain.slice(1).map((room) => room.id)]);
    expect(new Set(rooms.map((room) => room.id)).size).toBe(3);
  });

  it("lists neighbours with doors first, then by longer shared walls", () => {
    const plan = apartment();
    const rooms = detectViewRooms(plan).rooms;
    const adjacency = findRoomAdjacency(rooms, plan.walls, plan.openings);
    const left = roomAt(rooms, 2, 2), upper = roomAt(rooms, 8, 1.5), lower = roomAt(rooms, 8, 4.5);
    // Both of the left room's neighbours share 2.8 m; only the upper one has a door.
    expect(roomNeighbours(left, rooms, adjacency).map((item) => [item.id, item.doors])).toEqual([[upper.id, 1], [lower.id, 0]]);
    // The upper room has doors to both; the lower room shares the longer wall (3.8 m vs 2.8 m).
    expect(roomNeighbours(upper, rooms, adjacency).map((item) => item.id)).toEqual([lower.id, left.id]);
    expect(roomNeighbours(undefined, rooms, adjacency)).toEqual([]);
    expect(roomNeighbours(left, rooms, null)).toEqual([]);
  });
});
