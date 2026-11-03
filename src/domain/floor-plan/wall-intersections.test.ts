import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import type { Wall } from "./types";
import { analyzeWallIntersections } from "./wall-intersections";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 3 };
}

const horizontal = wall("horizontal", { x: 0, y: 0 }, { x: 6, y: 0 });
const vertical = wall("vertical", { x: 2, y: -3 }, { x: 2, y: 4 });

describe("proper wall-axis intersections", () => {
  it.each([false, true])("finds an axis crossing independently of wall order (reverse: %s)", (reverse) => {
    const input = reverse ? [vertical, horizontal] : [horizontal, vertical];
    const result = analyzeWallIntersections(input);
    expect(result).toEqual({
      intersections: [{
        id: 'wall-intersection:["horizontal","vertical"]',
        wallIds: ["horizontal", "vertical"], point: { x: 2, y: 0 },
      }],
      truncated: false,
    });
  });

  it.each([false, true])("supports reversed diagonal axes (reverse: %s)", (reverse) => {
    const first = wall("a", { x: -3, y: -2 }, { x: 3, y: 6 });
    const second = wall("b", { x: -4, y: 5 }, { x: 4, y: -1 });
    const result = analyzeWallIntersections(reverse
      ? [first, second].map((item) => ({ ...item, start: item.end, end: item.start }))
      : [first, second]);
    expect(result.intersections).toHaveLength(1);
    expect(result.intersections[0].point.x).toBeCloseTo(0, 12);
    expect(result.intersections[0].point.y).toBeCloseTo(2, 12);
  });

  it.each([
    [wall("a", { x: 0, y: 0 }, { x: 1, y: 0 }), wall("b", { x: 0, y: -1e-12 }, { x: 1, y: 1e-12 })],
    [wall("a", { x: 0, y: 0 }, { x: 1, y: 1 }), wall("b", { x: 0, y: -5e-13 }, { x: 1, y: 1 + 5e-13 })],
  ])("keeps a numerically resolved tiny crossing angle without a metre-scale parallel cutoff", (first, second) => {
    const result = analyzeWallIntersections([first, second]);
    expect(result.intersections).toHaveLength(1);
    const point = result.intersections[0].point;
    expect(point.x).toBeGreaterThan(0.49);
    expect(point.x).toBeLessThan(0.51);
    expect(Math.abs(point.y - point.x * first.end.y)).toBeLessThan(1e-12);
  });

  it.each([
    wall("other", { x: 2, y: 0 }, { x: 2, y: 4 }),
    wall("other", { x: 2, y: -4 }, { x: 2, y: 0 }),
    wall("other", { x: 6, y: 0 }, { x: 6, y: 4 }),
    wall("other", { x: 7, y: -4 }, { x: 7, y: 4 }),
    wall("other", { x: 0, y: 1 }, { x: 6, y: 1 }),
    wall("other", { x: 2, y: 0 }, { x: 8, y: 0 }),
    wall("other", { x: 6, y: 0 }, { x: 0, y: 0 }),
  ])("excludes T contacts, common ends, outside intersections, parallel axes and overlaps", (other) => {
    expect(analyzeWallIntersections([horizontal, other])).toEqual({ intersections: [], truncated: false });
  });

  it.each([0.5e-9, 1e-9, 6 - 0.5e-9])("excludes intersection %s at the endpoint tolerance", (x) => {
    expect(analyzeWallIntersections([horizontal, { ...vertical, start: { x, y: -3 }, end: { x, y: 4 } }]).intersections)
      .toHaveLength(0);
  });

  it("measures endpoint tolerance in metres on both walls, retaining an interior crossing", () => {
    const long = wall("long", { x: -1000, y: 0 }, { x: 1000, y: 0 });
    const closeToEnd = wall("vertical", { x: -1000 + 2e-9, y: -1 }, { x: -1000 + 2e-9, y: 1 });
    expect(analyzeWallIntersections([long, closeToEnd]).intersections).toHaveLength(1);
    const secondNearEnd = { ...vertical, start: { x: 2, y: -0.5e-9 } };
    expect(analyzeWallIntersections([horizontal, secondNearEnd]).intersections).toHaveLength(0);
  });

  it("returns stable pair order and collision-free IDs even when wall IDs contain delimiters", () => {
    const input = [
      wall("a:b", { x: -2, y: 0 }, { x: 2, y: 0 }),
      wall("a", { x: 0, y: -2 }, { x: 0, y: 2 }),
      wall("b:c", { x: -2, y: -2 }, { x: 2, y: 2 }),
      wall("c", { x: -2, y: 2 }, { x: 2, y: -2 }),
    ];
    const result = analyzeWallIntersections(input);
    expect(result).toEqual(analyzeWallIntersections([...input].reverse()));
    expect(result.intersections.map((item) => item.wallIds)).toEqual([
      ["a", "a:b"], ["a", "b:c"], ["a", "c"], ["a:b", "b:c"], ["a:b", "c"], ["b:c", "c"],
    ]);
    expect(new Set(result.intersections.map((item) => item.id)).size).toBe(6);
  });

  it("supports deeply frozen input and returns separately owned point snapshots", () => {
    const input = [structuredClone(horizontal), structuredClone(vertical)];
    for (const item of input) {
      Object.freeze(item.start);
      Object.freeze(item.end);
      Object.freeze(item);
    }
    Object.freeze(input);
    const result = analyzeWallIntersections(input);
    expect(result.intersections[0].point).not.toBe(input[0].start);
    expect(Object.isFrozen(result.intersections[0].point)).toBe(false);
    Object.assign(result.intersections[0].point, { x: 123 });
    expect(input).toEqual([horizontal, vertical]);
    expect(analyzeWallIntersections(input).intersections[0].point).toEqual({ x: 2, y: 0 });
  });

  it("caps records in stable order and indicates more matches without claiming their total", () => {
    const input = Array.from({ length: 101 }, (_, index) =>
      wall(`h${String(index).padStart(3, "0")}`, { x: 0, y: index }, { x: 1, y: index }),
    );
    input.push(wall("vertical", { x: 0.5, y: -1 }, { x: 0.5, y: 102 }));
    const limited = analyzeWallIntersections([...input].reverse());
    expect(limited.intersections).toHaveLength(100);
    expect(limited.truncated).toBe(true);
    expect(limited.intersections[0].wallIds).toEqual(["h000", "vertical"]);
    expect(limited.intersections[99].wallIds).toEqual(["h099", "vertical"]);
    expect(analyzeWallIntersections(input, 101)).toMatchObject({ truncated: false });
    expect(analyzeWallIntersections(input, 2)).toEqual({ intersections: limited.intersections.slice(0, 2), truncated: true });
    expect(analyzeWallIntersections([horizontal, vertical], 1).truncated).toBe(false);
  });

  it.each([0, -1, 1.1, 1001, NaN, Infinity])("rejects invalid record limit %s", (limit) => {
    expect(() => analyzeWallIntersections([], limit)).toThrow(/Лимит/);
  });

  it.each([NaN, Infinity, -Infinity, 1000.1])("rejects invalid coordinates %s before scanning pairs", (x) => {
    expect(() => analyzeWallIntersections([{ ...horizontal, start: { x, y: 0 } }])).toThrow(/Координаты/);
  });

  it.each(["", "x".repeat(101)])("rejects malformed wall IDs", (id) => {
    expect(() => analyzeWallIntersections([{ ...horizontal, id }])).toThrow(/идентификатор/);
  });

  it("rejects zero walls, duplicate IDs and excessive wall counts without silently truncating validation", () => {
    expect(() => analyzeWallIntersections([{ ...horizontal, end: horizontal.start }])).toThrow(/ненулевую/);
    expect(() => analyzeWallIntersections([horizontal, { ...vertical, id: horizontal.id }])).toThrow(/уникальными/);
    expect(() => analyzeWallIntersections(Array.from({ length: 1001 }, (_, index) => ({ ...horizontal, id: String(index) }))))
      .toThrow(/1000 стен/);
    expect(analyzeWallIntersections([])).toEqual({ intersections: [], truncated: false });
  });
});
