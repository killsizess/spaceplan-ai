import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import type { Wall } from "./types";
import { WALL_ROOM_FIXTURES } from "./wall-rooms.fixtures";
import { detectWallRooms, type WallRoom } from "./wall-rooms";

/**
 * Golden records of room detection for reference layouts. They catch silent changes
 * in polygon clipping (library update) or in our own contour handling. To accept an
 * intended change, run with UPDATE_WALL_ROOM_GOLDEN=1 and review the JSON diff.
 */
const GOLDEN_PATH = fileURLToPath(new URL("./wall-rooms.golden.json", import.meta.url));
const TOLERANCE = 2e-6;
const round = (value: number) => Math.round(value * 1e6) / 1e6 + 0;

interface RoomRecord {
  id: string;
  area: number;
  perimeter: number;
  vertices: number;
  holes: number[];
  bounds: [number, number, number, number];
  boundaryWallIds: string[];
}

const record = (room: WallRoom): RoomRecord => ({
  id: room.id,
  area: round(room.area),
  perimeter: round(room.perimeter),
  vertices: room.outer.length,
  holes: room.holes.map((hole) => hole.length),
  bounds: [room.bounds.minX, room.bounds.minY, room.bounds.maxX, room.bounds.maxY].map(round) as RoomRecord["bounds"],
  boundaryWallIds: [...room.boundaryWallIds],
});

const detect = (walls: readonly Wall[]) => detectWallRooms(walls).rooms;
const shoelace = (ring: readonly Point[]) =>
  Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;

/** Order-independent comparison: rooms are matched by their boundary key. */
function expectSameRooms(actual: readonly WallRoom[], expected: readonly WallRoom[], tolerance: number, shift = { x: 0, y: 0 }) {
  expect(actual.map((room) => room.id).sort()).toEqual(expected.map((room) => room.id).sort());
  for (const room of expected) {
    const other = actual.find((item) => item.id === room.id)!;
    expect(Math.abs(other.area - room.area)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(other.perimeter - room.perimeter)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(other.bounds.minX - shift.x - room.bounds.minX)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(other.bounds.maxY - shift.y - room.bounds.maxY)).toBeLessThanOrEqual(tolerance);
    expect(other.holes.length).toBe(room.holes.length);
    expect(other.boundaryWallIds).toEqual(room.boundaryWallIds);
  }
}

describe("wall room golden records", () => {
  const actual = Object.fromEntries(WALL_ROOM_FIXTURES.map(({ name, walls }) => [name, detect(walls).map(record)]));

  if (process.env.UPDATE_WALL_ROOM_GOLDEN === "1") {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  }
  // A lost file must fail the run, not silently accept the current output.
  const golden = (existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) : {}) as Record<string, RoomRecord[]>;

  it("has a record for every reference layout and nothing stale", () => {
    expect(existsSync(GOLDEN_PATH), "wall-rooms.golden.json is missing; regenerate with UPDATE_WALL_ROOM_GOLDEN=1").toBe(true);
    expect(Object.keys(golden).sort()).toEqual(WALL_ROOM_FIXTURES.map((fixture) => fixture.name).sort());
  });

  for (const { name } of WALL_ROOM_FIXTURES) {
    it(`matches the golden record: ${name}`, () => {
      const expected = golden[name];
      expect(expected, `no golden record for ${name}`).toBeDefined();
      const rooms = actual[name];
      expect(rooms.map(({ id, vertices, holes, boundaryWallIds }) => ({ id, vertices, holes, boundaryWallIds })))
        .toEqual(expected.map(({ id, vertices, holes, boundaryWallIds }) => ({ id, vertices, holes, boundaryWallIds })));
      rooms.forEach((room, index) => {
        const reference = expected[index];
        for (const [value, wanted] of [[room.area, reference.area], [room.perimeter, reference.perimeter], ...room.bounds.map((bound, at) => [bound, reference.bounds[at]])]) {
          expect(Math.abs(value - wanted)).toBeLessThanOrEqual(TOLERANCE);
        }
      });
    });
  }
});

describe("wall room detection invariants on reference layouts", () => {
  it("matches hand-computed areas, including the butt-end notch at a concave corner", () => {
    const area = (name: string) => detect(WALL_ROOM_FIXTURES.find((fixture) => fixture.name === name)!.walls).map((room) => room.area).sort((a, b) => a - b);
    // Inner faces at 0.1 m from the axes.
    expect(area("rectangle")).toEqual([expect.closeTo(4.8 * 3.8, 9)]);
    // 5.8 × 2.8 + 2.8 × 3.0, plus the 0.1 × 0.1 square that butt-ended walls leave free at the inner corner.
    expect(area("l-shape")).toEqual([expect.closeTo(24.65, 9)]);
    // Exterior 0.3 m, partition 0.1 m: 2.3 × 3.7 and 3.3 × 3.7.
    expect(area("mixed-thickness")).toEqual([expect.closeTo(8.51, 9), expect.closeTo(12.21, 9)]);
    // The box interior (0.8 × 0.8) is its own room; the outer room has the box as a hole:
    // 1.2 × 1.2 minus the four 0.1 × 0.1 notches butt ends leave at the box's outer corners.
    expect(area("nested-box")).toEqual([expect.closeTo(0.64, 9), expect.closeTo(7.8 * 5.8 - (1.2 * 1.2 - 4 * 0.01), 9)]);
    // A free-standing 3 × 0.2 m screen is a hole; a 1.5 m stub takes 0.2 × 1.4 m of the left room.
    expect(area("free-standing-screen")).toEqual([expect.closeTo(7.8 * 5.8 - 0.6, 9)]);
    expect(area("partitioned-apartment")).toEqual([expect.closeTo(10.64, 9), expect.closeTo(10.64, 9), expect.closeTo(5.8 * 5.8 - 0.28, 9)]);
    // A 0.5 m gap leaves the room open; a 0.05 m gap closes because the wall solids overlap.
    expect(area("open-gap")).toEqual([]);
    expect(area("hairline-gap")).toEqual([expect.closeTo(4.8 * 3.8, 9)]);
  });

  for (const { name, walls } of WALL_ROOM_FIXTURES) {
    it(`is consistent and independent of wall order, direction and position: ${name}`, () => {
      const rooms = detect(walls);
      const ids = new Set(walls.map((item) => item.id));
      for (const room of rooms) {
        // The reported area is the outer contour minus the holes.
        const contour = shoelace(room.outer) - room.holes.reduce((sum, hole) => sum + shoelace(hole), 0);
        expect(Math.abs(room.area - contour)).toBeLessThanOrEqual(1e-9);
        expect(room.boundaryWallIds).toEqual([...room.boundaryWallIds].sort());
        expect(room.boundaryWallIds.every((id) => ids.has(id))).toBe(true);
        const { minX, minY, maxX, maxY } = room.bounds;
        expect(room.labelPoint.x > minX && room.labelPoint.x < maxX && room.labelPoint.y > minY && room.labelPoint.y < maxY).toBe(true);
      }
      // Reversed walls in reverse order: the same rooms.
      const reordered = [...walls].reverse().map((item) => ({ ...item, start: item.end, end: item.start }));
      expectSameRooms(detect(reordered), rooms, 1e-9);
      // The whole plan moved far from the origin: the same rooms within float noise.
      const shift = { x: 123.4, y: -56.7 };
      const moved = walls.map((item) => ({
        ...item,
        start: { x: item.start.x + shift.x, y: item.start.y + shift.y },
        end: { x: item.end.x + shift.x, y: item.end.y + shift.y },
      }));
      expectSameRooms(detect(moved), rooms, 1e-6, shift);
    });
  }
});
