import { describe, expect, it } from "vitest";
import { addOpening, moveWallNode } from "./construction";
import { createDefaultRoom, createEmptyPlan } from "./operations";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Wall } from "./types";
import { detectWallRooms } from "./wall-rooms";
import {
  addRectangularWallRoom,
  getRectangularRoomWalls,
  resizeRectangularWallRoom,
  type RectangularWallRoomInput,
  type WallIdTuple,
} from "./rectangular-wall-room";

const input: RectangularWallRoomInput = {
  x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 2.7,
};
const ids: WallIdTuple = ["top", "right", "bottom", "left"];
const rectangle = () => addRectangularWallRoom(createEmptyPlan("plan"), input, ids);
const roomIn = (plan: FloorPlan) => detectWallRooms(plan.walls).rooms[0];

describe("rectangular room from physical walls", () => {
  it("encloses exactly 5 × 4 = 20 m² with four joined walls outside the usable interior", () => {
    const original = createEmptyPlan("plan");
    const plan = addRectangularWallRoom(original, input, ids);
    expect(plan.roomMode).toBe("walls");
    expect(plan.schemaVersion).toBe(6);
    expect(plan.rooms).toEqual([]);
    expect(plan.walls.map((wall) => wall.id)).toEqual(ids);
    expect(plan.walls[0]).toMatchObject({ start: { x: -0.1, y: -0.1 }, end: { x: 5.1, y: -0.1 }, height: 2.7, thickness: 0.2 });
    plan.walls.forEach((wall, index) => expect(wall.end).toEqual(plan.walls[(index + 1) % 4].start));
    const room = roomIn(plan);
    expect(room.area).toBeCloseTo(20, 10);
    expect(room.bounds.minX).toBeCloseTo(0, 10);
    expect(room.bounds.minY).toBeCloseTo(0, 10);
    expect(room.bounds.maxX).toBeCloseTo(5, 10);
    expect(room.bounds.maxY).toBeCloseTo(4, 10);
    expect(original.walls).toEqual([]);
    expect(floorPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("keeps manual rooms and works at translated positions and the minimum size", () => {
    const empty = createEmptyPlan("plan");
    const manual = { ...empty, rooms: [createDefaultRoom(empty, "manual")] };
    const plan = addRectangularWallRoom(manual, { ...input, x: -5, y: 3, width: 0.5, depth: 0.5 }, ids);
    expect(plan.rooms).toEqual(manual.rooms);
    expect(manual.roomMode).toBe("manual");
    expect(roomIn(plan).area).toBeCloseTo(0.25, 10);
    expect(getRectangularRoomWalls(plan, roomIn(plan))).toMatchObject({ width: expect.closeTo(0.5), depth: expect.closeTo(0.5) });
  });

  it.each([
    { width: 0.49 }, { depth: 101 }, { width: NaN }, { depth: Infinity },
    { x: -1000 }, { y: 1000 }, { x: NaN },
    { thickness: 0 }, { thickness: Infinity }, { wallHeight: -1 }, { wallHeight: 101 },
  ])("rejects invalid dimensions or coordinates atomically %#", (change) => {
    const original = createEmptyPlan("plan");
    const before = structuredClone(original);
    expect(() => addRectangularWallRoom(original, { ...input, ...change }, ids)).toThrow();
    expect(original).toEqual(before);
  });

  it("rejects duplicate or reused IDs and intersections that prevent the requested interior", () => {
    const original = rectangle();
    const before = structuredClone(original);
    expect(() => addRectangularWallRoom(createEmptyPlan("empty"), input, ["a", "a", "b", "c"])).toThrow(/идентификатора/);
    expect(() => addRectangularWallRoom(original, { ...input, x: 10 }, ids)).toThrow(/идентификатора/);
    expect(() => addRectangularWallRoom(original, input, ["a", "b", "c", "d"])).toThrow(/неоднозначную/);
    expect(() => addRectangularWallRoom(original, { ...input, x: 2 }, ["a", "b", "c", "d"])).toThrow(/пересекает/);
    expect(original).toEqual(before);
  });
});

describe("safe rectangular boundary resolution", () => {
  it("resolves shuffled/reversed walls and ignores a presentation-only room ID suffix", () => {
    const original = rectangle();
    const plan = { ...original, walls: [...original.walls].reverse().map((wall) => ({ ...wall, start: wall.end, end: wall.start })) };
    const room = { ...roomIn(plan), id: `${roomIn(plan).id}:view-1` };
    const result = getRectangularRoomWalls(plan, room);
    expect(result?.top.id).toBe("top");
    expect(result?.right.id).toBe("right");
    expect(result?.bottom.id).toBe("bottom");
    expect(result?.left.id).toBe("left");
    expect(result?.width).toBeCloseTo(5, 10);
    expect(result?.depth).toBeCloseTo(4, 10);
  });

  it("returns unavailable for stale geometry, manual mode, holes and nonrectangular rooms", () => {
    const plan = rectangle();
    const room = roomIn(plan);
    const changed = moveWallNode(plan, "top", "end", { x: 6, y: -0.1 });
    expect(getRectangularRoomWalls(changed, room)).toBeNull();
    expect(getRectangularRoomWalls({ ...plan, roomMode: "manual" }, room)).toBeNull();
    const island: Wall = { id: "island", start: { x: 2, y: 2 }, end: { x: 3, y: 2 }, thickness: 0.2, height: 2.7 };
    const holed = { ...plan, walls: [...plan.walls, island] };
    expect(getRectangularRoomWalls(holed, roomIn(holed))).toBeNull();
    expect(getRectangularRoomWalls(changed, roomIn(changed))).toBeNull();
  });

  it("returns unavailable for duplicate, extended, split or mid-edge-contact boundaries", () => {
    const plan = rectangle();
    const duplicate = { ...plan, walls: [...plan.walls, { ...plan.walls[0], id: "duplicate" }] };
    expect(getRectangularRoomWalls(duplicate, roomIn(duplicate))).toBeNull();
    const extended = { ...plan, walls: plan.walls.map((wall) => wall.id === "top" ? { ...wall, start: { x: -1, y: -0.1 }, end: { x: 6, y: -0.1 } } : wall) };
    expect(getRectangularRoomWalls(extended, roomIn(extended))).toBeNull();
    const split = { ...plan, walls: [
      { ...plan.walls[0], end: { x: 2, y: -0.1 } },
      { ...plan.walls[0], id: "top2", start: { x: 2, y: -0.1 } },
      ...plan.walls.slice(1),
    ] };
    expect(getRectangularRoomWalls(split, roomIn(split))).toBeNull();
    const tContact = { ...plan, walls: [...plan.walls, {
      id: "branch", start: { x: 2, y: -0.1 }, end: { x: 2, y: -2 }, thickness: 0.2, height: 2.7,
    }] };
    expect(getRectangularRoomWalls(tContact, roomIn(tContact))).toBeNull();
  });
});

describe("atomic rectangular room resizing", () => {
  it("sets usable width/depth, fixes the top-left and preserves manual data and wall properties", () => {
    const plan = rectangle();
    plan.rooms = [createDefaultRoom(plan, "manual")];
    const before = structuredClone(plan);
    const room = roomIn(plan);
    const changed = resizeRectangularWallRoom(plan, room, 7, 3);
    const resized = roomIn(changed);
    expect(resized.area).toBeCloseTo(21, 10);
    expect(resized.bounds.minX).toBeCloseTo(room.bounds.minX, 10);
    expect(resized.bounds.minY).toBeCloseTo(room.bounds.minY, 10);
    expect(changed.walls[1].start).toEqual({ x: 7.1, y: -0.1 });
    expect(changed.walls[1].end).toEqual({ x: 7.1, y: 3.1 });
    expect(changed.walls[2].end).toEqual({ x: -0.1, y: 3.1 });
    expect(changed.walls.map(({ id, thickness, height }) => ({ id, thickness, height }))).toEqual(plan.walls.map(({ id, thickness, height }) => ({ id, thickness, height })));
    expect(changed.rooms).toEqual(plan.rooms);
    expect(changed.roomMode).toBe("walls");
    expect(plan).toEqual(before);
    expect(resizeRectangularWallRoom(plan, { ...room, id: "display-only" }, 5, 4)).toBe(plan);
    expect(getRectangularRoomWalls(changed, room)).toBeNull();
    expect(() => resizeRectangularWallRoom(changed, room, 6, 4)).toThrow(/изменилось/);
  });

  it("retains distinct wall thicknesses and reversed directions", () => {
    const plan = rectangle();
    plan.walls = plan.walls.map((wall) => ({
      ...wall,
      thickness: wall.id === "right" ? 0.4 : wall.thickness,
      start: { x: wall.end.x === 5.1 ? 5.2 : wall.end.x, y: wall.end.y },
      end: { x: wall.start.x === 5.1 ? 5.2 : wall.start.x, y: wall.start.y },
    }));
    const room = roomIn(plan);
    expect(room.area).toBeCloseTo(20, 10);
    const changed = resizeRectangularWallRoom(plan, room, 6, 3);
    expect(roomIn(changed).area).toBeCloseTo(18, 10);
    expect(changed.walls.find((wall) => wall.id === "right")).toMatchObject({
      thickness: 0.4, start: { x: 6.2, y: 3.1 }, end: { x: 6.2, y: -0.1 },
    });
  });

  it("moves corner neighbors from the original snapshot and validates their openings too", () => {
    const base = rectangle();
    const branch: Wall = { id: "branch", start: base.walls[0].end, end: { x: 9.1, y: -0.1 }, thickness: 0.2, height: 2.7 };
    const plan = addOpening({ ...base, walls: [...base.walls, branch] }, {
      id: "door", wallId: "branch", kind: "door", offset: 2, width: 1, height: 2.1, sillHeight: 0,
    });
    const room = roomIn(plan);
    const before = structuredClone(plan);
    const changed = resizeRectangularWallRoom(plan, room, 6, 4);
    expect(changed.walls.at(-1)?.start).toEqual({ x: 6.1, y: -0.1 });
    expect(changed.walls.at(-1)?.end).toEqual(branch.end);
    // The branch loses 1 m at its start; the door stays at x = 7.1..8.1.
    expect(changed.openings).toHaveLength(1);
    expect(changed.openings[0]).toMatchObject({ ...plan.openings[0], offset: expect.closeTo(1, 12) });
    expect(resizeRectangularWallRoom(plan, room, 7, 4).openings[0].offset).toBeCloseTo(0, 12);
    expect(() => resizeRectangularWallRoom(plan, room, 7.5, 4)).toThrow(/границы/);
    expect(plan).toEqual(before);
  });

  it("keeps every door and window at its plan position while the room grows", () => {
    let plan = rectangle();
    for (const wallId of ["top", "right", "bottom", "left"]) {
      plan = addOpening(plan, {
        id: `door-${wallId}`, wallId, kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0,
      });
    }
    const position = (target: FloorPlan, id: string) => {
      const opening = target.openings.find((item) => item.id === id)!;
      const owner = target.walls.find((item) => item.id === opening.wallId)!;
      const length = Math.hypot(owner.end.x - owner.start.x, owner.end.y - owner.start.y);
      return {
        x: owner.start.x + (owner.end.x - owner.start.x) * opening.offset / length,
        y: owner.start.y + (owner.end.y - owner.start.y) * opening.offset / length,
      };
    };
    const resized = resizeRectangularWallRoom(plan, roomIn(plan), 7, 6);
    // Walls that only grow keep their doors in place. The right and bottom walls
    // move outwards by 2 m and carry their doors without sliding along the axis.
    const expected: Record<string, { x: number; y: number }> = {
      "door-top": { x: 0.9, y: -0.1 },
      "door-left": { x: -0.1, y: 3.1 },
      "door-right": { x: 7.1, y: 0.9 },
      "door-bottom": { x: 4.1, y: 6.1 },
    };
    for (const [id, point] of Object.entries(expected)) {
      expect(position(resized, id).x).toBeCloseTo(point.x, 9);
      expect(position(resized, id).y).toBeCloseTo(point.y, 9);
    }
    expect(position(plan, "door-left").y).toBeCloseTo(3.1, 9);
    expect(position(plan, "door-bottom").x).toBeCloseTo(4.1, 9);
  });

  it("rejects invalid sizes, out-of-bounds walls and opening overflow without mutating input", () => {
    const plan = addOpening(rectangle(), {
      id: "door", wallId: "top", kind: "door", offset: 3, width: 1, height: 2.1, sillHeight: 0,
    });
    const room = roomIn(plan);
    const before = structuredClone(plan);
    for (const [width, depth] of [[0.4, 4], [5, 101], [NaN, 4], [5, Infinity], [1, 4]]) {
      expect(() => resizeRectangularWallRoom(plan, room, width, depth)).toThrow();
    }
    const border = addRectangularWallRoom(createEmptyPlan("border"), { ...input, x: 990 }, ids);
    expect(() => resizeRectangularWallRoom(border, roomIn(border), 20, 4)).toThrow();
    expect(plan).toEqual(before);
  });

  it("rejects expansion into unrelated walls that would alter the promised rectangle", () => {
    const plan = rectangle();
    const obstacle: Wall = { id: "obstacle", start: { x: 6, y: 1 }, end: { x: 6, y: 3 }, thickness: 0.2, height: 2.7 };
    plan.walls = [...plan.walls, obstacle];
    const before = structuredClone(plan);
    expect(() => resizeRectangularWallRoom(plan, roomIn(plan), 7, 4)).toThrow(/пересекает/);
    expect(plan).toEqual(before);
  });
});
