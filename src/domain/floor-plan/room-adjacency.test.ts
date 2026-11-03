import { describe, expect, it } from "vitest";
import { createSpatialExamplePlan } from "./examples";
import { createEmptyPlan } from "./operations";
import { findRoomAdjacency } from "./room-adjacency";
import type { FloorPlan, Opening, Wall } from "./types";
import { detectWallRooms, type WallRoom } from "./wall-rooms";

function wall(id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.2): Wall {
  return { id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, height: 2.7 };
}
const door = (id: string, wallId: string, offset: number): Opening =>
  ({ id, wallId, kind: "door", offset, width: 0.9, height: 2.1, sillHeight: 0 });

/** Room ID of the room containing a point (via its bounds), to name rooms in tests. */
function roomAt(rooms: readonly WallRoom[], x: number, y: number): string {
  return rooms.find((room) => room.bounds.minX < x && x < room.bounds.maxX && room.bounds.minY < y && y < room.bounds.maxY)!.id;
}

function apartment(): FloorPlan {
  return {
    ...createEmptyPlan("adjacency"),
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0), wall("right", 10, 0, 10, 6), wall("bottom", 10, 6, 0, 6), wall("left", 0, 6, 0, 0),
      wall("partition", 6, 0, 6, 6), wall("branch", 6, 3, 10, 3), wall("stub", 3, 6, 3, 4.5),
    ],
    openings: [
      door("door-partition", "partition", 1), door("door-branch", "branch", 1), door("door-entry", "right", 4),
      { id: "window", wallId: "top", kind: "window", offset: 2, width: 1.2, height: 1.2, sillHeight: 0.9 },
    ],
  };
}

describe("room adjacency", () => {
  it("finds rooms facing each other across walls, their shared length and connecting doors", () => {
    const plan = apartment();
    const rooms = detectWallRooms(plan.walls).rooms;
    const left = roomAt(rooms, 2, 2), upper = roomAt(rooms, 8, 1.5), lower = roomAt(rooms, 8, 4.5);
    const result = findRoomAdjacency(rooms, plan.walls, plan.openings);
    const pair = (a: string, b: string) => result.pairs.find((item) => item.rooms.includes(a) && item.rooms.includes(b));
    expect(result.pairs).toHaveLength(3);
    // The partition faces run 0.1..5.9 on the left; the branch splits the right side at 2.9 / 3.1.
    expect(pair(left, upper)!.walls).toEqual([{ wallId: "partition", length: expect.closeTo(2.8, 9), doorIds: ["door-partition"] }]);
    expect(pair(left, lower)!.walls).toEqual([{ wallId: "partition", length: expect.closeTo(2.8, 9), doorIds: [] }]);
    expect(pair(upper, lower)).toMatchObject({ length: expect.closeTo(3.8, 9), doorIds: ["door-branch"] });
    // The entrance leads from the lower right room to no room; the window connects nothing.
    expect(result.exteriorDoors).toEqual([{ roomId: lower, doorId: "door-entry", wallId: "right" }]);
    for (const item of result.pairs) expect([...item.rooms].sort()).toEqual(item.rooms);
  });

  it("does not make a room its own neighbour across a free-standing wall, nor a door in it exterior", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("island"),
      walls: [wall("top", 0, 0, 6, 0), wall("right", 6, 0, 6, 4), wall("bottom", 6, 4, 0, 4), wall("left", 0, 4, 0, 0), wall("screen", 2, 2, 4.5, 2)],
      openings: [door("screen-door", "screen", 0.5)],
    };
    const rooms = detectWallRooms(plan.walls).rooms;
    expect(rooms).toHaveLength(1);
    expect(findRoomAdjacency(rooms, plan.walls, plan.openings)).toEqual({ pairs: [], exteriorDoors: [] });
  });

  it("describes the 3D example apartment: every door between rooms and the entrance", () => {
    const plan = createSpatialExamplePlan();
    const rooms = detectWallRooms(plan.walls).rooms;
    const names = new Map([
      [roomAt(rooms, 2, 2), "living"], [roomAt(rooms, 6.5, 2), "kitchen"], [roomAt(rooms, 9, 2.5), "hall"],
      [roomAt(rooms, 9, 6.5), "bathroom"], [roomAt(rooms, 2, 6), "bedroom"], [roomAt(rooms, 6, 6), "study"],
    ]);
    const result = findRoomAdjacency(rooms, plan.walls, plan.openings);
    const described = result.pairs
      .map((item) => [item.rooms.map((id) => names.get(id)!).sort().join("–"), item.doorIds.join(",") || "—"].join(" "))
      .sort();
    expect(described).toEqual([
      "bathroom–hall —",
      "bathroom–study door-bathroom",
      "bedroom–living door-bedroom",
      "bedroom–study door-study-bedroom",
      "hall–kitchen door-kitchen-hall",
      "hall–study —",
      "kitchen–living door-living",
      "kitchen–study door-study",
      "living–study —",
    ]);
    expect(result.exteriorDoors.map((item) => [names.get(item.roomId), item.doorId])).toEqual([["hall", "door-entry"]]);
    // A stretch of 0.88 m: the living room above x = 4.06..4.94 meets the study below.
    const livingStudy = result.pairs.find((item) => item.rooms.map((id) => names.get(id)).sort().join() === "living,study")!;
    expect(livingStudy.length).toBeCloseTo(0.88, 9);
  });

  it("is symmetric, sorted and independent of room, wall and opening order", () => {
    const plan = createSpatialExamplePlan();
    const rooms = detectWallRooms(plan.walls).rooms;
    const result = findRoomAdjacency(rooms, plan.walls, plan.openings);
    const reversed = findRoomAdjacency([...rooms].reverse(), [...plan.walls].reverse(), [...plan.openings].reverse());
    expect(reversed).toEqual(result);
    for (const item of result.pairs) {
      expect(item.rooms[0] < item.rooms[1]).toBe(true);
      expect(item.length).toBeCloseTo(item.walls.reduce((sum, shared) => sum + shared.length, 0), 12);
      for (const shared of item.walls) {
        const host = plan.walls.find((candidate) => candidate.id === shared.wallId)!;
        expect(shared.length).toBeLessThanOrEqual(Math.hypot(host.end.x - host.start.x, host.end.y - host.start.y));
      }
    }
    expect(findRoomAdjacency([], plan.walls, plan.openings)).toEqual({ pairs: [], exteriorDoors: [] });
  });
});
