import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { connectWallJunction } from "./connect-wall-junction";
import { createEmptyPlan } from "./operations";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Wall } from "./types";
import { analyzeWallConnections } from "./wall-diagnostics";
import {
  detectWallRooms,
  MIN_WALL_ROOM_AREA,
  wallRoomDetectionStats,
  wallRoomKey,
  type WallRoom,
} from "./wall-rooms";

describe("derived room cache", () => {
  const walls = () => [
    { id: "cache-0", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 },
    { id: "cache-1", start: { x: 5, y: 0 }, end: { x: 5, y: 4 }, thickness: 0.2, height: 2.7 },
    { id: "cache-2", start: { x: 5, y: 4 }, end: { x: 0, y: 4 }, thickness: 0.2, height: 2.7 },
    { id: "cache-3", start: { x: 0, y: 4 }, end: { x: 0, y: 0 }, thickness: 0.2, height: 2.7 },
  ];
  const delta = (before: { computed: number; reused: number }) => {
    const now = wallRoomDetectionStats();
    return { computed: now.computed - before.computed, reused: now.reused - before.reused };
  };

  it("reuses one frozen result for equal wall lists, including deep copies", () => {
    const before = wallRoomDetectionStats();
    const first = detectWallRooms(walls());
    const second = detectWallRooms(structuredClone(walls()));
    expect(second).toBe(first);
    expect(delta(before)).toEqual({ computed: 1, reused: 1 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.rooms[0].outer[0])).toBe(true);
    expect(() => {
      (first.rooms[0] as { name: string }).name = "changed";
    }).toThrow(TypeError);
    expect(first.rooms[0].name).toBe("Помещение 1");
  });

  it("recomputes after any change that can affect rooms or their errors", () => {
    const base = walls();
    detectWallRooms(base);
    const variants = [
      base.map((wall, index) => index === 0 ? { ...wall, id: "renamed" } : wall),
      base.map((wall, index) => index === 1 ? { ...wall, end: { x: 5, y: 4.5 } } : wall),
      base.map((wall, index) => index === 2 ? { ...wall, thickness: 0.3 } : wall),
      base.map((wall, index) => index === 3 ? { ...wall, height: 3 } : wall),
      base.map((wall, index) => index === 0 ? { ...wall, start: { x: -0, y: 0 } } : wall),
      [...base].reverse(),
    ];
    for (const variant of variants) {
      const before = wallRoomDetectionStats();
      detectWallRooms(variant);
      expect(delta(before).computed).toBe(1);
    }
    // Same rooms for a sign of zero, but a separate entry keeps results exact.
    expect(detectWallRooms(variants[4]).rooms[0].area).toBeCloseTo(detectWallRooms(base).rooms[0].area, 12);
  });

  it("never caches errors and keeps only recent wall lists", () => {
    const invalid = walls().map((wall, index) => index === 0 ? { ...wall, height: -1 } : wall);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = wallRoomDetectionStats();
      expect(() => detectWallRooms(invalid)).toThrow(/высота/);
      expect(delta(before)).toEqual({ computed: 0, reused: 0 });
    }
    const first = walls().map((wall) => ({ ...wall, id: `lru-${wall.id}` }));
    detectWallRooms(first);
    for (let index = 0; index < 16; index++) {
      detectWallRooms(walls().map((wall) => ({ ...wall, id: `lru-${index}-${wall.id}` })));
    }
    const before = wallRoomDetectionStats();
    detectWallRooms(first);
    expect(delta(before).computed).toBe(1);
  });
});

function outline(
  points: readonly Point[],
  prefix = "wall",
  thickness = 0.2,
): Wall[] {
  return points.map((start, index) => ({
    id: `${prefix}-${index}`,
    start,
    end: points[(index + 1) % points.length],
    thickness,
    height: 2.7,
  }));
}
function rectangle(
  width = 5,
  height = 4,
  x = 0,
  y = 0,
  prefix = "wall",
  thickness = 0.2,
) {
  return outline(
    [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    prefix,
    thickness,
  );
}
const partition = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness = 0.2,
): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness,
  height: 2.7,
});

function contains(point: Point, ring: readonly Point[]) {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index],
      b = ring[(index + 1) % ring.length];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y)
    )
      inside = !inside;
  }
  return inside;
}
function expectInteriorLabel(room: WallRoom) {
  expect(contains(room.labelPoint, room.outer)).toBe(true);
  expect(room.holes.some((hole) => contains(room.labelPoint, hole))).toBe(
    false,
  );
}
/** Everything except the ID-derived key fields. */
const shape = (room: WallRoom) => ({
  name: room.name,
  color: room.color,
  outer: room.outer,
  holes: room.holes,
  area: room.area,
  perimeter: room.perimeter,
  labelPoint: room.labelPoint,
  bounds: room.bounds,
});

describe("physical wall room detection", () => {
  it("finds actual interior area, perimeter and unclosed contours", () => {
    const detection = detectWallRooms(rectangle());
    expect(detection.warnings).toEqual([]);
    expect(detection.rooms).toHaveLength(1);
    const room = detection.rooms[0];
    expect(room.area).toBeCloseTo(4.8 * 3.8, 10);
    expect(room.perimeter).toBeCloseTo(2 * (4.8 + 3.8), 10);
    expect(room.bounds).toEqual({ minX: 0.1, minY: 0.1, maxX: 4.9, maxY: 3.9 });
    expect(room.outer).toHaveLength(4);
    expect(room.outer[0]).not.toEqual(room.outer.at(-1));
    expect(room.holes).toEqual([]);
    expect(room.id).toMatch(/^wall-room:[0-9a-f]{16}$/);
    expect(room.boundaryWallIds).toEqual(["wall-0", "wall-1", "wall-2", "wall-3"]);
    expect(room.id).toBe(wallRoomKey(room.boundaryWallIds));
    expect(room.name).toBe("Помещение 1");
    expectInteriorLabel(room);
  });

  it("counts each side of a shared partition without counting its thickness", () => {
    const rooms = detectWallRooms([
      ...rectangle(),
      partition("middle", 2.5, 0, 2.5, 4),
    ]).rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms.map((room) => room.name)).toEqual([
      "Помещение 1",
      "Помещение 2",
    ]);
    for (const room of rooms) expect(room.area).toBeCloseTo(2.3 * 3.8, 10);
    expect(rooms[0].bounds.maxX).toBeCloseTo(2.4);
    expect(rooms[1].bounds.minX).toBeCloseTo(2.6);
  });

  it("supports crossing walls and T junctions without a separate planar graph", () => {
    const rooms = detectWallRooms([
      ...rectangle(),
      partition("vertical", 2.5, 0, 2.5, 4),
      partition("horizontal", 0, 2, 5, 2),
    ]).rooms;
    expect(rooms).toHaveLength(4);
    for (const room of rooms) {
      expect(room.area).toBeCloseTo(2.3 * 1.8, 10);
      expectInteriorLabel(room);
    }
  });

  it("supports a diagonal triangular boundary using perpendicular thickness", () => {
    const rooms = detectWallRooms(
      outline([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 3 },
      ]),
    ).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeCloseTo((3.6 * 2.7) / 2, 10);
    expect(rooms[0].outer).toHaveLength(3);
    expectInteriorLabel(rooms[0]);
  });

  it("keeps a concave L shaped room, including the physical butt-end corner", () => {
    const rooms = detectWallRooms(
      outline([
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 3 },
        { x: 3, y: 3 },
        { x: 3, y: 6 },
        { x: 0, y: 6 },
      ]),
    ).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeCloseTo(24.65, 10);
    expect(rooms[0].outer.length).toBeGreaterThan(4);
    expectInteriorLabel(rooms[0]);
  });

  it("finds a usable label when the centroid lies outside a C shaped room", () => {
    const rooms = detectWallRooms(
      outline([
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 5 },
        { x: 6, y: 5 },
        { x: 6, y: 6 },
        { x: 0, y: 6 },
      ]),
    ).rooms;
    expect(rooms).toHaveLength(1);
    expectInteriorLabel(rooms[0]);
    const point = rooms[0].labelPoint;
    expect(point.x < 0.9 || point.y < 0.9 || point.y > 5.1).toBe(true);
  });

  it("subtracts a detached solid island and avoids placing its label in the hole", () => {
    const room = detectWallRooms([
      ...rectangle(),
      partition("island", 2, 2, 3, 2, 0.4),
    ]).rooms[0];
    expect(room.holes).toHaveLength(1);
    expect(room.area).toBeCloseTo(18.24 - 0.4, 10);
    expect(room.perimeter).toBeCloseTo(17.2 + 2.8, 10);
    expectInteriorLabel(room);
  });

  it("handles nested disconnected loops without double counting the inner room", () => {
    const rooms = detectWallRooms([
      ...rectangle(10, 10),
      ...rectangle(4, 4, 3, 3, "inner"),
    ]).rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms.map((room) => room.area).sort((a, b) => a - b)).toEqual(
      expect.arrayContaining([
        expect.closeTo(14.44, 9),
        expect.closeTo(78.44, 9),
      ]),
    );
    expect(rooms.reduce((sum, room) => sum + room.area, 0)).toBeCloseTo(
      92.88,
      9,
    );
    expect(rooms.map((room) => room.holes.length).sort()).toEqual([0, 1]);
    rooms.forEach(expectInteriorLabel);
  });

  it("separates disjoint buildings and orders them by position", () => {
    const rooms = detectWallRooms([
      ...rectangle(3, 3, 10, 10, "second"),
      ...rectangle(3, 3, -10, -10, "first"),
    ]).rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms[0].bounds.minX).toBeCloseTo(-9.9);
    expect(rooms[1].bounds.minX).toBeCloseTo(10.1);
    expect(rooms[0].color).not.toBe(rooms[1].color);
  });

  it("returns helpful empty results for missing or open walls", () => {
    expect(detectWallRooms([]).rooms).toEqual([]);
    const open = detectWallRooms(rectangle().slice(0, 3));
    expect(open.rooms).toEqual([]);
    expect(open.warnings.join(" ")).toContain("соединения стен");
  });

  it("treats actual wall overlap as closed even when center lines have a small gap", () => {
    const walls = rectangle();
    walls[3] = { ...walls[3], end: { x: 0, y: 0.05 } };
    expect(detectWallRooms(walls).rooms).toHaveLength(1);
    walls[3] = { ...walls[3], end: { x: 0, y: 0.15 } };
    expect(detectWallRooms(walls).rooms).toHaveLength(0);
  });

  it("does not duplicate areas when wall solids overlap or are repeated", () => {
    const walls = rectangle();
    const plain = detectWallRooms(walls);
    const repeated = detectWallRooms([...walls, { ...walls[0], id: "overlap" }]);
    expect(repeated.rooms.map(shape)).toEqual(plain.rooms.map(shape));
    expect(repeated.warnings).toEqual(plain.warnings);
    // The repeated solid really carries the boundary, so it belongs to the key.
    expect(repeated.rooms[0].boundaryWallIds).toEqual([
      "overlap",
      "wall-0",
      "wall-1",
      "wall-2",
      "wall-3",
    ]);
    expect(repeated.rooms[0].id).not.toBe(plain.rooms[0].id);
  });

  it("is deterministic under reordered input and reversed wall direction; keys follow wall ids", () => {
    const walls = [
      ...rectangle(),
      partition("diagonal", 0, 0, 5, 4),
      partition("island", 1, 2.5, 1.7, 2.5),
    ];
    const expected = detectWallRooms(walls);
    const reversed = [...walls].reverse().map((wall) => ({
      ...wall,
      start: wall.end,
      end: wall.start,
    }));
    expect(detectWallRooms(reversed)).toEqual(expected);
    expect(detectWallRooms([...walls.slice(2), ...walls.slice(0, 2)])).toEqual(
      expected,
    );
    const renamed = detectWallRooms(
      walls.map((wall, index) => ({ ...wall, id: `new-${index}` })),
    );
    expect(renamed.rooms.map(shape)).toEqual(expected.rooms.map(shape));
    expect(renamed.rooms.map((room) => room.id)).not.toEqual(
      expected.rooms.map((room) => room.id),
    );
  });

  it("keeps input wall objects and coordinates unchanged", () => {
    const walls = rectangle();
    const before = structuredClone(walls);
    walls.forEach((wall) => {
      Object.freeze(wall.start);
      Object.freeze(wall.end);
      Object.freeze(wall);
    });
    Object.freeze(walls);
    detectWallRooms(walls);
    expect(walls).toEqual(before);
  });

  it("includes the minimum supported area but reports smaller cavities", () => {
    const exact = detectWallRooms(rectangle(0.7, 0.7));
    expect(exact.rooms).toHaveLength(1);
    expect(exact.rooms[0].area).toBeCloseTo(MIN_WALL_ROOM_AREA, 10);
    const small = detectWallRooms(rectangle(0.69, 0.69));
    expect(small.rooms).toEqual([]);
    expect(small.warnings.join(" ")).toContain("менее 0,25 м²");
  });

  it("rejects nonfinite, out-of-range and zero-length wall geometry", () => {
    const wall = rectangle()[0];
    for (const invalid of [
      { ...wall, start: { x: NaN, y: 0 } },
      { ...wall, end: { x: Infinity, y: 0 } },
      { ...wall, end: { x: 1001, y: 0 } },
      { ...wall, end: wall.start },
      { ...wall, thickness: NaN },
      { ...wall, thickness: 0 },
      { ...wall, thickness: 101 },
      { ...wall, height: -1 },
      { ...wall, height: Infinity },
      { ...wall, height: 101 },
    ])
      expect(() => detectWallRooms([invalid])).toThrow();
  });

  it("rejects duplicate and empty ids and excessive wall/room counts", () => {
    const wall = rectangle()[0];
    expect(() => detectWallRooms([{ ...wall, id: "" }])).toThrow(
      "идентификатор",
    );
    expect(() => detectWallRooms([wall, wall])).toThrow("идентификатор");
    expect(() =>
      detectWallRooms(
        Array.from({ length: 1001 }, (_, index) => ({
          ...wall,
          id: String(index),
        })),
      ),
    ).toThrow("1000 стен");
    const tooManyRooms = Array.from({ length: 101 }, (_, index) =>
      rectangle(1, 1, index * 2, 0, `room${index}`),
    ).flat();
    expect(() => detectWallRooms(tooManyRooms)).toThrow("больше 100 помещений");
  });
});

/** Small deterministic PRNG so random plans are reproducible. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unit edges of a 4 × 4 cell grid with random gaps, directions and ID order. */
function randomGrid(seed: number): Wall[] {
  const next = random(seed);
  const walls: Wall[] = [];
  for (let line = 0; line <= 4; line++)
    for (let cell = 0; cell < 4; cell++)
      for (const horizontal of [true, false]) {
        if (next() < 0.35) continue;
        const a = horizontal ? { x: cell * 3, y: line * 3 } : { x: line * 3, y: cell * 3 };
        const b = horizontal ? { x: (cell + 1) * 3, y: line * 3 } : { x: line * 3, y: (cell + 1) * 3 };
        const [start, end] = next() < 0.5 ? [a, b] : [b, a];
        walls.push({ id: `w${Math.floor(next() * 1e6)}-${walls.length}`, start, end, thickness: 0.2, height: 2.7 });
      }
  return walls;
}

describe("stable wall room keys", () => {
  const roomAt = (walls: readonly Wall[], point: Point) =>
    detectWallRooms(walls).rooms.find(
      (room) => contains(point, room.outer) && !room.holes.some((hole) => contains(point, hole)),
    )!;

  it("depends only on the boundary wall IDs, not on coordinates, thickness, order or direction", () => {
    const walls = rectangle();
    const room = detectWallRooms(walls).rooms[0];
    expect(wallRoomKey(["wall-3", "wall-1", "wall-0", "wall-2"])).toBe(room.id);
    expect(wallRoomKey(["wall-0", "wall-1", "wall-2"])).not.toBe(room.id);
    const variants = [
      rectangle(5, 4, 12.5, -7.25),
      rectangle(6, 3),
      rectangle(5, 4, 0, 0, "wall", 0.35),
      [...walls].reverse(),
      walls.map((wall) => ({ ...wall, start: wall.end, end: wall.start })),
    ];
    for (const variant of variants) {
      const [moved] = detectWallRooms(variant).rooms;
      expect(moved.id).toBe(room.id);
      expect(moved.boundaryWallIds).toEqual(room.boundaryWallIds);
    }
    expect(detectWallRooms(variants[1]).rooms[0].area).toBeCloseTo(5.8 * 2.8, 10);
  });

  it("keeps the keys of untouched rooms when a neighbour is split, gets an island or grows", () => {
    const base = [...rectangle(10, 4), partition("middle", 5, 0, 5, 4), ...rectangle(3, 3, 20, 0, "far")];
    const left = roomAt(base, { x: 2, y: 2 });
    const right = roomAt(base, { x: 7, y: 2 });
    const far = roomAt(base, { x: 21.5, y: 1.5 });
    expect(new Set([left.id, right.id, far.id]).size).toBe(3);
    expect(left.boundaryWallIds).toEqual(["middle", "wall-0", "wall-2", "wall-3"]);
    expect(right.boundaryWallIds).toEqual(["middle", "wall-0", "wall-1", "wall-2"]);

    const split = [...base, partition("second", 7.5, 0, 7.5, 4)];
    expect(roomAt(split, { x: 2, y: 2 }).id).toBe(left.id);
    expect(roomAt(split, { x: 21.5, y: 1.5 }).id).toBe(far.id);
    const halves = [roomAt(split, { x: 6, y: 2 }).id, roomAt(split, { x: 9, y: 2 }).id];
    expect(new Set(halves).size).toBe(2);
    expect(halves).not.toContain(right.id);

    const island = [...base, partition("column", 7, 2, 8, 2, 0.4)];
    expect(roomAt(island, { x: 2, y: 2 }).id).toBe(left.id);
    expect(roomAt(island, { x: 6, y: 1 }).boundaryWallIds).toContain("column");
    expect(roomAt(island, { x: 6, y: 1 }).id).not.toBe(right.id);

    const grown = base.map((wall) => ({
      ...wall,
      start: wall.start.x === 10 ? { ...wall.start, x: 11 } : wall.start,
      end: wall.end.x === 10 ? { ...wall.end, x: 11 } : wall.end,
    }));
    expect(roomAt(grown, { x: 2, y: 2 }).id).toBe(left.id);
    expect(roomAt(grown, { x: 10.5, y: 2 }).id).toBe(right.id);
    expect(roomAt(grown, { x: 21.5, y: 1.5 }).id).toBe(far.id);
  });

  it("changes the key exactly when the set of boundary walls changes", () => {
    const divided = [...rectangle(), partition("middle", 2.5, 0, 2.5, 4)];
    const whole = detectWallRooms(rectangle()).rooms[0];
    expect(detectWallRooms(divided).rooms.map((room) => room.id)).not.toContain(whole.id);
    // Removing the partition restores the key: identity is the boundary set.
    expect(detectWallRooms(divided.filter((wall) => wall.id !== "middle")).rooms[0].id).toBe(whole.id);

    // An explicit T join renames part of the boundary, so the key changes with it.
    const plan: FloorPlan = { ...createEmptyPlan("keys"), roomMode: "walls", walls: [...rectangle(), partition("branch", 2, -2, 2, -0.2)] };
    const before = detectWallRooms(plan.walls).rooms[0];
    const diagnostic = analyzeWallConnections(plan.walls).find((item) => item.wallId === "branch" && item.endpoint === "end")!;
    const after = detectWallRooms(connectWallJunction(plan, diagnostic, "wall-0-after").walls).rooms[0];
    expect(after.area).toBeCloseTo(before.area, 10);
    expect(after.boundaryWallIds).toEqual([...before.boundaryWallIds, "wall-0-after"].sort());
    expect(after.id).toBe(wallRoomKey(after.boundaryWallIds));
    expect(after.id).not.toBe(before.id);
  });

  it("is the same after a JSON round trip and in a plan copy with the same walls", () => {
    const plan: FloorPlan = { ...createEmptyPlan("session"), roomMode: "walls", walls: [...rectangle(), partition("middle", 2.5, 0, 2.5, 4)] };
    const keys = detectWallRooms(plan.walls).rooms.map((room) => room.id);
    expect(keys).toHaveLength(2);
    const restored = floorPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(detectWallRooms(restored.walls).rooms.map((room) => room.id)).toEqual(keys);
    const copy = { ...structuredClone(plan), id: "variant", name: "Вариант" };
    expect(detectWallRooms(copy.walls).rooms.map((room) => room.id)).toEqual(keys);
  });

  it("keeps unique, order-independent and translation-stable keys on random grid plans", () => {
    let rooms = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const walls = randomGrid(seed);
      const detection = detectWallRooms(walls);
      const ids = detection.rooms.map((room) => room.id);
      expect(new Set(ids).size).toBe(ids.length);
      const wallIds = new Set(walls.map((wall) => wall.id));
      for (const room of detection.rooms) {
        expect(room.boundaryWallIds.length).toBeGreaterThan(2);
        expect(room.boundaryWallIds).toEqual([...new Set(room.boundaryWallIds)].sort());
        expect(room.boundaryWallIds.every((id) => wallIds.has(id))).toBe(true);
        expect(room.id).toBe(wallRoomKey(room.boundaryWallIds));
      }
      const next = random(seed + 1000);
      const shuffled = walls
        .map((wall) => ({ wall, order: next() }))
        .sort((a, b) => a.order - b.order)
        .map(({ wall }) => (next() < 0.5 ? wall : { ...wall, start: wall.end, end: wall.start }));
      expect(detectWallRooms(shuffled)).toEqual(detection);
      const moved = new Map(
        detectWallRooms(
          walls.map((wall) => ({
            ...wall,
            start: { x: wall.start.x + 7.5, y: wall.start.y - 4.25 },
            end: { x: wall.end.x + 7.5, y: wall.end.y - 4.25 },
          })),
        ).rooms.map((room) => [room.id, room]),
      );
      expect([...moved.keys()].sort()).toEqual([...ids].sort());
      for (const room of detection.rooms) expect(moved.get(room.id)!.area).toBeCloseTo(room.area, 9);
      rooms += ids.length;
    }
    expect(rooms).toBeGreaterThan(40);
  });
});
