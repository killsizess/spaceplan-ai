import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import type { Wall } from "./types";
import { analyzeWallOverlaps } from "./wall-overlaps";

function wall(id: string, start: Point, end: Point, thickness = 0.2): Wall {
  return { id, start, end, thickness, height: 2.7 };
}

describe("collinear wall overlaps", () => {
  it("reports duplicated walls in either direction with the shared length and middle", () => {
    const walls = [
      wall("b", { x: 0, y: 0 }, { x: 4, y: 0 }),
      wall("a", { x: 4, y: 0 }, { x: 0, y: 0 }, 0.12),
    ];
    const before = structuredClone(walls);
    expect(analyzeWallOverlaps(walls)).toEqual({
      overlaps: [{ id: 'wall-overlap:["a","b"]', wallIds: ["a", "b"], point: { x: 2, y: 0 }, length: 4 }],
      truncated: false,
    });
    expect(walls).toEqual(before);
  });

  it("measures a partial overlap and a short wall lying on a long diagonal wall", () => {
    const partial = analyzeWallOverlaps([
      wall("long", { x: 0, y: 0 }, { x: 6, y: 0 }),
      wall("redrawn", { x: 4, y: 0 }, { x: 9, y: 0 }),
    ]).overlaps;
    expect(partial).toHaveLength(1);
    expect(partial[0].length).toBeCloseTo(2, 12);
    expect(partial[0].point.x).toBeCloseTo(5, 12);
    const diagonal = analyzeWallOverlaps([
      wall("diagonal", { x: 0, y: 0 }, { x: 30, y: 40 }),
      wall("piece", { x: 3, y: 4 }, { x: 3.0003, y: 4.0004 }),
    ]).overlaps;
    expect(diagonal).toHaveLength(1);
    expect(diagonal[0].length).toBeCloseTo(0.0005, 12);
  });

  it("ignores touching ends, T-contacts, crossings and parallel neighbours", () => {
    expect(analyzeWallOverlaps([
      wall("left", { x: 0, y: 0 }, { x: 4, y: 0 }),
      wall("right", { x: 4, y: 0 }, { x: 8, y: 0 }),
      wall("t", { x: 2, y: 0 }, { x: 2, y: 3 }),
      wall("cross", { x: 6, y: -1 }, { x: 6, y: 1 }),
      wall("parallel", { x: 0, y: 0.15 }, { x: 4, y: 0.15 }),
      wall("almost", { x: 0, y: 2e-9 }, { x: 4, y: 2e-9 }),
    ])).toEqual({ overlaps: [], truncated: false });
    // Within the node tolerance the axes are the same line.
    expect(analyzeWallOverlaps([
      wall("left", { x: 0, y: 0 }, { x: 4, y: 0 }),
      wall("same", { x: 1, y: 0.5e-9 }, { x: 3, y: 0.5e-9 }),
    ]).overlaps).toHaveLength(1);
  });

  it("orders pairs by ID independently of input order and reports a bounded list", () => {
    const walls = ["c", "a", "d", "b"].map((id) => wall(id, { x: 0, y: 0 }, { x: 2, y: 0 }));
    const result = analyzeWallOverlaps(walls);
    expect(result.overlaps.map((overlap) => overlap.wallIds)).toEqual([
      ["a", "b"], ["a", "c"], ["a", "d"], ["b", "c"], ["b", "d"], ["c", "d"],
    ]);
    expect(analyzeWallOverlaps([...walls].reverse())).toEqual(result);
    const limited = analyzeWallOverlaps(walls, 2);
    expect(limited.overlaps).toEqual(result.overlaps.slice(0, 2));
    expect(limited.truncated).toBe(true);
    expect(analyzeWallOverlaps(walls, 6).truncated).toBe(false);
  });

  it("rejects invalid input like the other wall diagnostics", () => {
    const valid = wall("a", { x: 0, y: 0 }, { x: 1, y: 0 });
    for (const limit of [0, 1.5, 1001, NaN]) {
      expect(() => analyzeWallOverlaps([valid], limit)).toThrow(/Лимит/);
    }
    expect(() => analyzeWallOverlaps([valid, valid])).toThrow(/уникальными/);
    expect(() => analyzeWallOverlaps([{ ...valid, id: "" }])).toThrow(/идентификатор/);
    expect(() => analyzeWallOverlaps([{ ...valid, end: { x: NaN, y: 0 } }])).toThrow(/Координаты/);
    expect(() => analyzeWallOverlaps([{ ...valid, end: valid.start }])).toThrow(/ненулевую/);
  });
});
