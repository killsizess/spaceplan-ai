import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import type { Wall } from "./types";
import { analyzeWallConnections } from "./wall-diagnostics";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 3 };
}

function square(): Wall[] {
  return [
    wall("top", { x: 0, y: 0 }, { x: 5, y: 0 }),
    wall("right", { x: 5, y: 0 }, { x: 5, y: 4 }),
    wall("bottom", { x: 5, y: 4 }, { x: 0, y: 4 }),
    wall("left", { x: 0, y: 4 }, { x: 0, y: 0 }),
  ];
}

describe("wall connection diagnostics", () => {
  it("returns no diagnostics for a closed square, irrespective of wall directions", () => {
    expect(analyzeWallConnections(square())).toEqual([]);
    expect(analyzeWallConnections(square().map((item) => ({
      ...item, start: item.end, end: item.start,
    })))).toEqual([]);
    expect(analyzeWallConnections([])).toEqual([]);
  });

  it("finds the two open ends of a U-shaped contour in stable wall/endpoint order", () => {
    const diagnostics = analyzeWallConnections(square().filter((item) => item.id !== "left"));
    expect(diagnostics).toEqual([
      {
        id: "wall-diagnostic:bottom:end", wallId: "bottom", endpoint: "end",
        point: { x: 0, y: 4 }, kind: "open",
      },
      {
        id: "wall-diagnostic:top:start", wallId: "top", endpoint: "start",
        point: { x: 0, y: 0 }, kind: "open",
      },
    ]);
  });

  it("reports both ends of a small axial gap without treating wall thickness as closure", () => {
    const walls = [
      wall("a", { x: 0, y: 0 }, { x: 2, y: 0 }),
      wall("b", { x: 2.1, y: 0 }, { x: 4, y: 0 }),
    ];
    const diagnostics = analyzeWallConnections(walls);
    const nearby = diagnostics.filter((item) => item.kind === "near-endpoint");
    expect(nearby).toHaveLength(2);
    expect(nearby[0]).toMatchObject({
      wallId: "a", endpoint: "end", target: { wallId: "b", endpoint: "start", point: { x: 2.1, y: 0 } },
    });
    expect(nearby[1]).toMatchObject({
      wallId: "b", endpoint: "start", target: { wallId: "a", endpoint: "end", point: { x: 2, y: 0 } },
    });
    expect(nearby[0].distance).toBeCloseTo(0.1, 12);
    expect(diagnostics.filter((item) => item.kind === "open")).toHaveLength(2);
    expect(analyzeWallConnections(walls.map((item) => ({ ...item, thickness: 2, height: 7 }))))
      .toEqual(diagnostics);
  });

  it("marks a T contact as an unsplit junction instead of a connected endpoint", () => {
    const diagnostics = analyzeWallConnections([
      wall("trunk", { x: 0, y: 0 }, { x: 4, y: 0 }),
      wall("branch", { x: 2, y: 0 }, { x: 2, y: 2 }),
    ]);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics[0]).toEqual({
      id: "wall-diagnostic:branch:start", wallId: "branch", endpoint: "start",
      point: { x: 2, y: 0 }, kind: "junction", distance: 0,
      target: { wallId: "trunk", point: { x: 2, y: 0 } },
    });
    expect(diagnostics.filter((item) => item.kind === "junction")).toHaveLength(1);
  });

  it("finds the perpendicular projection near the interior of another wall", () => {
    const diagnostic = analyzeWallConnections([
      wall("trunk", { x: 0, y: 0 }, { x: 4, y: 0 }),
      wall("branch", { x: 2, y: 0.1 }, { x: 2, y: 2 }),
    ])[0];
    expect(diagnostic).toMatchObject({
      wallId: "branch", endpoint: "start", kind: "near-wall", distance: 0.1,
      target: { wallId: "trunk", point: { x: 2, y: 0 } },
    });
    expect(diagnostic.target).not.toHaveProperty("endpoint");
  });

  it("projects diagonally and uses Euclidean distances", () => {
    const diagnostic = analyzeWallConnections([
      wall("diagonal", { x: -2, y: -2 }, { x: 2, y: 2 }),
      wall("source", { x: 0, y: 0.2 }, { x: 0, y: 2 }),
    ]).find((item) => item.wallId === "source" && item.endpoint === "start");
    expect(diagnostic).toMatchObject({ kind: "near-wall", target: { wallId: "diagonal" } });
    expect(diagnostic?.target?.point.x).toBeCloseTo(0.1, 12);
    expect(diagnostic?.target?.point.y).toBeCloseTo(0.1, 12);
    expect(diagnostic?.distance).toBeCloseTo(Math.SQRT2 * 0.1, 12);
  });

  it("does not use the same wall as a target, even for very short walls", () => {
    expect(analyzeWallConnections([wall("short", { x: 0, y: 0 }, { x: 0.01, y: 0 })]))
      .toMatchObject([
        { wallId: "short", endpoint: "start", kind: "open" },
        { wallId: "short", endpoint: "end", kind: "open" },
      ]);
  });

  it("omits every coincident end in a three-wall corner and ignores extra mid-wall contacts", () => {
    const walls = [
      wall("a", { x: -1, y: 0 }, { x: 0, y: 0 }),
      wall("b", { x: 0, y: 0 }, { x: 1, y: 0 }),
      wall("c", { x: 0, y: 0 }, { x: 0, y: 1 }),
      wall("trunk", { x: -2, y: 0 }, { x: 2, y: 0 }),
    ];
    const diagnostics = analyzeWallConnections(walls);
    expect(diagnostics.some((item) => item.point.x === 0 && item.point.y === 0)).toBe(false);
    expect(diagnostics).toHaveLength(5);
  });

  it("matches the shared-node Euclidean tolerance without merging nearby real gaps", () => {
    const source = wall("a", { x: 0, y: -1 }, { x: 0, y: 0 });
    const connected = wall("b", { x: 1e-9, y: 0 }, { x: 1, y: 0 });
    expect(analyzeWallConnections([source, connected])).toHaveLength(2);
    const gap = { ...connected, start: { x: 1.01e-9, y: 0 } };
    const diagnostics = analyzeWallConnections([source, gap]);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics[1]).toMatchObject({ wallId: "a", endpoint: "end", kind: "near-endpoint" });
    const diagonalGap = { ...connected, start: { x: 0.8e-9, y: 0.8e-9 } };
    expect(analyzeWallConnections([source, diagonalGap])).toHaveLength(4);
  });

  it("uses the same tolerance for unsplit mid-wall junctions", () => {
    const diagnostic = analyzeWallConnections([
      wall("a", { x: 2, y: 0.5e-9 }, { x: 2, y: 2 }),
      wall("b", { x: 0, y: 0 }, { x: 4, y: 0 }),
    ])[0];
    expect(diagnostic.kind).toBe("junction");
    expect(diagnostic.distance).toBe(0.5e-9);
  });

  it("prefers an endpoint when an interior projection is equally near", () => {
    const diagnostic = analyzeWallConnections([
      wall("source", { x: 0, y: 0 }, { x: 0, y: 2 }),
      wall("a-segment", { x: 0.1, y: -1 }, { x: 0.1, y: 1 }),
      wall("z-endpoint", { x: -0.1, y: 0 }, { x: -1, y: 0 }),
    ]).find((item) => item.wallId === "source" && item.endpoint === "start");
    expect(diagnostic).toMatchObject({
      kind: "near-endpoint", distance: 0.1, target: { wallId: "z-endpoint", endpoint: "start" },
    });
  });

  it("does not let the node tolerance hide a genuinely closer mid-wall junction", () => {
    const diagnostic = analyzeWallConnections([
      wall("source", { x: 0, y: 0 }, { x: 0, y: 2 }),
      wall("endpoint", { x: 1.5e-9, y: 0 }, { x: 1, y: 0 }),
      wall("segment", { x: -1, y: 0.5e-9 }, { x: 1, y: 0.5e-9 }),
    ]).find((item) => item.wallId === "source" && item.endpoint === "start");
    expect(diagnostic).toMatchObject({
      kind: "junction", distance: 0.5e-9, target: { wallId: "segment" },
    });
  });

  it("breaks equal-distance target ties by ID and stays identical after input reordering", () => {
    const walls = [
      wall("source", { x: 0, y: 0 }, { x: 0, y: 2 }),
      wall("zeta", { x: 0.1, y: 0 }, { x: 1, y: 0 }),
      wall("alpha", { x: -0.1, y: 0 }, { x: -1, y: 0 }),
    ];
    const diagnostics = analyzeWallConnections(walls);
    expect(diagnostics.find((item) => item.wallId === "source" && item.endpoint === "start"))
      .toMatchObject({ target: { wallId: "alpha" } });
    expect(analyzeWallConnections([...walls].reverse())).toEqual(diagnostics);
    expect(analyzeWallConnections([walls[1], walls[2], walls[0]])).toEqual(diagnostics);
    expect(new Set(diagnostics.map((item) => item.id)).size).toBe(diagnostics.length);
  });

  it("searches a closed finite segment and falls back to its endpoint outside the projection", () => {
    const diagnostic = analyzeWallConnections([
      wall("source", { x: 0, y: 0 }, { x: 0, y: -2 }),
      wall("target", { x: 0.1, y: 0.1 }, { x: 1, y: 0.1 }),
    ])[0];
    expect(diagnostic).toMatchObject({
      kind: "near-endpoint", target: { wallId: "target", endpoint: "start", point: { x: 0.1, y: 0.1 } },
    });
    expect(diagnostic.distance).toBeCloseTo(Math.SQRT2 * 0.1, 12);
  });

  it("honors an explicit distance threshold including zero and the inclusive boundary", () => {
    const walls = [
      wall("a", { x: -1, y: 0 }, { x: 0, y: 0 }),
      wall("b", { x: 0.25, y: 0 }, { x: 1, y: 0 }),
    ];
    expect(analyzeWallConnections(walls, 0.25).filter((item) => item.kind === "near-endpoint"))
      .toHaveLength(2);
    expect(analyzeWallConnections(walls, 0.249).every((item) => item.kind === "open")).toBe(true);
    expect(analyzeWallConnections(walls, 0).every((item) => item.kind === "open")).toBe(true);
    expect(analyzeWallConnections([
      wall("a", { x: 2, y: 0 }, { x: 2, y: 2 }),
      wall("b", { x: 0, y: 0 }, { x: 4, y: 0 }),
    ], 0)[0].kind).toBe("junction");
  });

  it("does not infer a node from crossing wall interiors", () => {
    const diagnostics = analyzeWallConnections([
      wall("horizontal", { x: -2, y: 0 }, { x: 2, y: 0 }),
      wall("vertical", { x: 0, y: -2 }, { x: 0, y: 2 }),
    ]);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.every((item) => item.kind === "open")).toBe(true);
  });

  it("accepts frozen inputs and returns independent point values", () => {
    const walls = [
      wall("a", { x: 0, y: 0 }, { x: 2, y: 0 }),
      wall("b", { x: 2.1, y: 0 }, { x: 4, y: 0 }),
    ];
    const original = structuredClone(walls);
    for (const item of walls) {
      Object.freeze(item.start);
      Object.freeze(item.end);
      Object.freeze(item);
    }
    Object.freeze(walls);
    const result = analyzeWallConnections(walls);
    expect(walls).toEqual(original);
    expect(result[0].point).not.toBe(walls[0].start);
    expect(result[1].target?.point).not.toBe(walls[1].start);
    expect(analyzeWallConnections(walls)).toEqual(result);
  });

  it("rejects invalid geometry before producing a partial result", () => {
    for (const point of [
      { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: -Infinity },
      { x: 1000.001, y: 0 }, { x: 0, y: -1001 },
    ]) {
      expect(() => analyzeWallConnections([wall("bad", point, { x: 1, y: 1 })])).toThrow(/Координаты/);
    }
    expect(() => analyzeWallConnections([wall("zero", { x: 0, y: 0 }, { x: 0, y: 0 })]))
      .toThrow(/ненулевую/);
    expect(() => analyzeWallConnections([wall("tiny", { x: 0, y: 0 }, { x: 1e-9, y: 0 })]))
      .toThrow(/ненулевую/);
  });

  it("rejects duplicate/invalid IDs, too many walls and invalid thresholds", () => {
    expect(() => analyzeWallConnections([square()[0], square()[0]])).toThrow(/уникальными/);
    for (const id of ["", "x".repeat(101)]) {
      expect(() => analyzeWallConnections([{ ...square()[0], id }])).toThrow(/идентификатор/);
    }
    const tooMany = Array.from({ length: 1001 }, (_, index) => ({ ...square()[0], id: `wall-${index}` }));
    expect(() => analyzeWallConnections(tooMany)).toThrow(/1000 стен/);
    for (const distance of [NaN, Infinity, -Infinity, -0.1, 1000.1]) {
      expect(() => analyzeWallConnections([], distance)).toThrow(/от 0 до 1000/);
    }
  });
});
