import { describe, expect, it } from "vitest";
import { DEFAULT_DOOR_SWING, doorSwingLocal, doorSwingWorld } from "./door-swing";
import type { DoorSwing, Opening, Wall } from "./types";

const wall: Wall = {
  id: "wall",
  start: { x: -2, y: 3 },
  end: { x: 8, y: 3 },
  thickness: 0.2,
  height: 2.7,
};
const door: Opening = {
  id: "door",
  wallId: wall.id,
  kind: "door",
  offset: 1,
  width: 0.9,
  height: 2.1,
  sillHeight: 0,
};

const cases: DoorSwing[] = [
  { hinge: "start", side: "left" },
  { hinge: "start", side: "right" },
  { hinge: "end", side: "left" },
  { hinge: "end", side: "right" },
];

describe("doorSwingLocal", () => {
  it.each(cases)("keeps a nominal-width quarter-circle for $hinge / $side", (swing) => {
    const result = doorSwingLocal({ ...door, door: swing });
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected door geometry");
    const hingeX = swing.hinge === "start" ? 0 : door.width;
    const openY = swing.side === "left" ? -door.width : door.width;
    expect(result.hinge).toEqual({ x: hingeX, y: 0 });
    expect(result.closedEnd).toEqual({ x: door.width - hingeX, y: 0 });
    expect(result.openEnd).toEqual({ x: hingeX, y: openY });
    expect(result.arc).toHaveLength(33);
    expect(result.arc[0]).toEqual(result.closedEnd);
    expect(result.arc.at(-1)).toEqual(result.openEnd);
    expect(result.bounds).toEqual({
      minX: 0,
      minY: Math.min(0, openY),
      maxX: door.width,
      maxY: Math.max(0, openY),
    });
    for (const point of result.arc) {
      expect(Math.hypot(point.x - hingeX, point.y)).toBeCloseTo(door.width, 12);
      expect(point.x).toBeGreaterThanOrEqual(-1e-12);
      expect(point.x).toBeLessThanOrEqual(door.width + 1e-12);
      expect(point.y * openY).toBeGreaterThanOrEqual(0);
    }
  });

  it("preserves the original default without mutating frozen inputs", () => {
    const input = Object.freeze({ ...door });
    const before = JSON.stringify(input);
    expect(DEFAULT_DOOR_SWING).toEqual({ hinge: "start", side: "left" });
    expect(Object.isFrozen(DEFAULT_DOOR_SWING)).toBe(true);
    expect(doorSwingLocal(input)).toEqual(doorSwingLocal({ ...door, door: { ...DEFAULT_DOOR_SWING } }));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not produce a swing for a window", () => {
    expect(doorSwingLocal({ ...door, kind: "window" })).toBeNull();
  });

  it.each([
    { offset: NaN },
    { offset: -1 },
    { width: Infinity },
    { width: 0 },
    { width: -1 },
    { height: NaN },
    { height: 0 },
    { sillHeight: -1 },
    { sillHeight: Infinity },
  ])("rejects nonfinite or nonpositive door geometry %#", (change) => {
    expect(() => doorSwingLocal({ ...door, ...change })).toThrow();
  });

  it("rejects invalid direction values instead of silently choosing a side", () => {
    for (const invalid of [
      { hinge: "middle", side: "left" },
      { hinge: "start", side: "up" },
    ]) {
      expect(() => doorSwingLocal({ ...door, door: invalid } as unknown as Opening)).toThrow(/направление/);
    }
  });
});

describe("doorSwingWorld", () => {
  it.each(cases)("transforms the local $hinge / $side swing for arbitrary rotations", (swing) => {
    for (const degrees of [0, 17, 90, 124, 198, 270, -37]) {
      const angle = degrees * Math.PI / 180;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const rotatedWall = {
        ...wall,
        end: { x: wall.start.x + 10 * ux, y: wall.start.y + 10 * uy },
      };
      const input = Object.freeze({ ...door, door: Object.freeze(swing) });
      const before = JSON.stringify({ rotatedWall, input });
      const result = doorSwingWorld(rotatedWall, input);
      const local = doorSwingLocal(input);
      if (!result || !local) throw new Error("Expected door geometry");
      const transform = (point: { x: number; y: number }) => ({
        x: wall.start.x + (door.offset + point.x) * ux - point.y * uy,
        y: wall.start.y + (door.offset + point.x) * uy + point.y * ux,
      });
      for (const key of ["hinge", "closedEnd", "openEnd"] as const) {
        const expected = transform(local[key]);
        expect(result[key].x).toBeCloseTo(expected.x, 12);
        expect(result[key].y).toBeCloseTo(expected.y, 12);
      }
      for (let index = 0; index < result.arc.length; index++) {
        const expected = transform(local.arc[index]);
        expect(result.arc[index].x).toBeCloseTo(expected.x, 12);
        expect(result.arc[index].y).toBeCloseTo(expected.y, 12);
      }
      for (const point of [result.hinge, ...result.arc]) {
        expect(point.x).toBeGreaterThanOrEqual(result.bounds.minX - 1e-12);
        expect(point.x).toBeLessThanOrEqual(result.bounds.maxX + 1e-12);
        expect(point.y).toBeGreaterThanOrEqual(result.bounds.minY - 1e-12);
        expect(point.y).toBeLessThanOrEqual(result.bounds.maxY + 1e-12);
      }
      expect(JSON.stringify({ rotatedWall, input })).toBe(before);
    }
  });

  it("includes the exact rotated arc extremum between samples", () => {
    const angle = 17 * Math.PI / 180;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const result = doorSwingWorld({
      ...wall,
      end: { x: wall.start.x + 10 * ux, y: wall.start.y + 10 * uy },
    }, door);
    if (!result) throw new Error("Expected door geometry");
    expect(result.bounds.maxX).toBeCloseTo(result.hinge.x + door.width, 12);
    expect(Math.max(...result.arc.map((point) => point.x))).toBeLessThan(result.bounds.maxX - 1e-7);
    expect(result.bounds.minX).toBe(result.hinge.x);
    expect(result.bounds.minY).toBeCloseTo(result.hinge.y - door.width * ux, 12);
    expect(result.bounds.maxY).toBeCloseTo(result.hinge.y + door.width * uy, 12);
  });

  it.each(cases)("finds tight analytical bounds in every quadrant for $hinge / $side", (swing) => {
    for (const degrees of [13, 103, 193, 283]) {
      const angle = degrees * Math.PI / 180;
      const result = doorSwingWorld({
        ...wall,
        end: { x: wall.start.x + 10 * Math.cos(angle), y: wall.start.y + 10 * Math.sin(angle) },
      }, { ...door, door: swing });
      if (!result) throw new Error("Expected door geometry");
      const c = {
        x: result.closedEnd.x - result.hinge.x,
        y: result.closedEnd.y - result.hinge.y,
      };
      const o = {
        x: result.openEnd.x - result.hinge.x,
        y: result.openEnd.y - result.hinge.y,
      };
      // A dense independent sweep approaches each tight bound from within.
      const points = [result.hinge];
      for (let index = 0; index <= 4096; index++) {
        const theta = index / 4096 * Math.PI / 2;
        points.push({
          x: result.hinge.x + c.x * Math.cos(theta) + o.x * Math.sin(theta),
          y: result.hinge.y + c.y * Math.cos(theta) + o.y * Math.sin(theta),
        });
      }
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const sampled = {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      };
      for (const key of ["minX", "maxX", "minY", "maxY"] as const) {
        expect(result.bounds[key]).toBeCloseTo(sampled[key], 7);
      }
    }
  });

  it("retains the same physical swing when wall, hinge and side reverse together", () => {
    const forward = doorSwingWorld(wall, door);
    const reversed = doorSwingWorld({ ...wall, start: wall.end, end: wall.start }, {
      ...door,
      offset: 10 - door.offset - door.width,
      door: { hinge: "end", side: "right" },
    });
    if (!forward || !reversed) throw new Error("Expected door geometry");
    for (const key of ["hinge", "closedEnd", "openEnd"] as const) {
      expect(reversed[key].x).toBeCloseTo(forward[key].x, 12);
      expect(reversed[key].y).toBeCloseTo(forward[key].y, 12);
    }
    expect(reversed.bounds).toEqual(forward.bounds);
  });

  it("returns null for windows without inventing a leaf", () => {
    expect(doorSwingWorld(wall, { ...door, kind: "window" })).toBeNull();
  });

  it.each([
    { ...wall, start: { x: NaN, y: 0 } },
    { ...wall, end: wall.start },
    { ...wall, thickness: 0 },
    { ...wall, thickness: Infinity },
    { ...wall, height: NaN },
    { ...wall, height: -1 },
    { ...wall, id: "another" },
  ])("rejects invalid or unrelated walls %#", (invalid) => {
    expect(() => doorSwingWorld(invalid, door)).toThrow();
  });

  it.each([
    { offset: 9.5 },
    { height: 3 },
    { width: NaN },
    { offset: Infinity },
  ])("rejects nonfinite or out-of-wall openings %#", (change) => {
    expect(() => doorSwingWorld(wall, { ...door, ...change })).toThrow();
  });
});
