import { afterEach, describe, expect, it } from "vitest";
import { FOOT, INCH, setUnits } from "@/lib/units";
import type { Underlay, Wall } from "@/domain/floor-plan/types";
import {
  findWallAt,
  gridLines,
  snapToGrid,
  moveHandleOffset,
  planBounds,
  snapWallPoint,
  underlayPixelAt,
  wallSolidSegments,
} from "./canvas-geometry";

describe("canvas grid", () => {
  it("draws 0.5 m lines from the camera origin and marks whole metres", () => {
    // 60 px per metre: a line every 30 px, the camera origin at x = 45 (a whole metre).
    const { vertical, horizontal } = gridLines({ x: 45, y: 0 }, 60, { width: 130, height: 61 });
    expect(vertical.map((line) => line.position)).toEqual([15, 45, 75, 105]);
    expect(vertical.map((line) => line.major)).toEqual([false, true, false, true]);
    expect(horizontal.map((line) => [line.position, line.major])).toEqual([[0, true], [30, false], [60, true]]);
  });

  it("coarsens the step by powers of ten so lines stay at least 16 px apart", () => {
    // 0.5 m at 2 px/m would be 1 px: the step becomes 50 m = 100 px.
    const { vertical } = gridLines({ x: 0, y: 0 }, 2, { width: 450, height: 10 });
    expect(vertical.map((line) => line.position)).toEqual([0, 100, 200, 300, 400]);
    expect(vertical.every((line) => line.major)).toBe(true);
  });

  it("draws nothing before the canvas has a size", () => {
    expect(gridLines({ x: 0, y: 0 }, 60, { width: 0, height: 0 })).toEqual({ vertical: [], horizontal: [] });
  });
});

describe("solid wall segments", () => {
  it("leaves gaps for openings in any order and merges overlapping ones", () => {
    expect(wallSolidSegments(5, [{ offset: 3, width: 1 }, { offset: 0.5, width: 0.9 }])).toEqual([
      { start: 0, end: 0.5 }, { start: 1.4, end: 3 }, { start: 4, end: 5 },
    ]);
    expect(wallSolidSegments(4, [{ offset: 1, width: 1.5 }, { offset: 2, width: 1 }])).toEqual([
      { start: 0, end: 1 }, { start: 3, end: 4 },
    ]);
  });

  it("has no stub for openings flush with the ends and keeps a free wall whole", () => {
    expect(wallSolidSegments(3, [{ offset: 0, width: 1 }, { offset: 2, width: 1 }])).toEqual([{ start: 1, end: 2 }]);
    expect(wallSolidSegments(3, [])).toEqual([{ start: 0, end: 3 }]);
  });
});

describe("move handle placement", () => {
  it("stays in the middle of a free wall", () => {
    expect(moveHandleOffset(8, [], 0.3)).toBe(4);
  });

  it("moves off a T-junction in the middle to the nearest free point", () => {
    // A branch rests exactly in the middle of the 8 m wall.
    expect(moveHandleOffset(8, [[4, 4]], 0.3)).toBeCloseTo(3.7, 12);
    // Openings count by their extent; the nearest side wins.
    expect(moveHandleOffset(8, [[3.5, 4.4]], 0.3)).toBeCloseTo(4.7, 12);
  });

  it("finds a gap between several junctions and openings and keeps clear of the ends", () => {
    expect(moveHandleOffset(10, [[2, 2], [3.6, 6.3], [8, 8]], 0.5)).toBeCloseTo(6.8, 12);
    expect(moveHandleOffset(10, [[0.2, 9.8]], 0.5)).toBe(5);
  });

  it("falls back to the middle for short walls, invalid input and fully covered walls", () => {
    expect(moveHandleOffset(0.4, [], 0.3)).toBe(0.2);
    expect(moveHandleOffset(Number.NaN, [], 0.3)).toBeNaN();
    expect(moveHandleOffset(6, [[1, 5]], 1)).toBe(3);
    expect(moveHandleOffset(6, [], -1)).toBe(3);
  });
});

const wall: Wall = {
  id: "wall-1",
  start: { x: 1, y: 2 },
  end: { x: 4, y: 6 },
  thickness: 0.2,
  height: 2.7,
};
const underlay: Underlay = {
  name: "plan.png",
  dataUrl: "data:image/png;base64,AA==",
  pixelWidth: 800,
  pixelHeight: 500,
  x: -2,
  y: 1,
  metersPerPixel: 0.01,
  opacity: 0.6,
  visible: true,
  calibrated: false,
};

describe("canvas construction coordinates", () => {
  it("projects to diagonal walls in metres from the start", () => {
    const target = findWallAt({ x: 2.58, y: 3.94 }, [wall], 60);
    expect(target?.wall.id).toBe(wall.id);
    expect(target?.offset).toBeCloseTo(2.5);
    expect(target?.distance).toBeCloseTo(0.1);
    expect(findWallAt({ x: 5, y: 1 }, [wall], 60)).toBeNull();
  });
  it("clamps projection at an endpoint and selects the nearest wall", () => {
    expect(findWallAt({ x: 0.97, y: 1.96 }, [wall], 60)?.offset).toBe(0);
    const upper: Wall = {
      ...wall,
      id: "upper",
      start: { x: 0, y: 0 },
      end: { x: 5, y: 0 },
    };
    const lower: Wall = {
      ...upper,
      id: "lower",
      start: { x: 0, y: 0.1 },
      end: { x: 5, y: 0.1 },
    };
    expect(findWallAt({ x: 3, y: 0.09 }, [upper, lower], 60)?.wall.id).toBe(
      "lower",
    );
  });
  it("snaps wall ends using a fixed screen radius, then falls back to the grid", () => {
    expect(snapWallPoint({ x: 1.09, y: 2.08 }, [wall], 60)).toEqual(wall.start);
    expect(snapWallPoint({ x: 1.09, y: 2.08 }, [wall], 150)).toEqual({
      x: 1.1,
      y: 2.1,
    });
    expect(snapWallPoint({ x: -1.23, y: 0.67 }, [], 60)).toEqual({
      x: -1.2,
      y: 0.7,
    });
  });
  it("excludes all shared source endpoints when dragging a wall node", () => {
    const connected: Wall = {
      ...wall,
      id: "connected",
      start: { ...wall.start },
      end: { x: 7, y: 2 },
    };
    expect(
      snapWallPoint({ x: 1.09, y: 2.08 }, [wall, connected], 60, wall.start),
    ).toEqual({ x: 1.1, y: 2.1 });
    expect(
      snapWallPoint({ x: 6.91, y: 2.08 }, [wall, connected], 60, wall.start),
    ).toEqual(connected.end);
    expect(
      snapWallPoint({ x: 4.09, y: 6.08 }, [wall, connected], 60, wall.start),
    ).toEqual(wall.end);
  });
  it("keeps calibration coordinates unsnapped and rejects points outside the image", () => {
    const point = underlayPixelAt({ x: -0.765, y: 3.222 }, underlay);
    expect(point?.x).toBeCloseTo(123.5);
    expect(point?.y).toBeCloseTo(222.2);
    expect(underlayPixelAt({ x: -2.01, y: 3 }, underlay)).toBeNull();
    expect(underlayPixelAt({ x: 1, y: 6.01 }, underlay)).toBeNull();
    expect(underlayPixelAt({ x: 6, y: 6 }, underlay)).toEqual({
      x: 800,
      y: 500,
    });
  });
  it("includes wall thickness and visible image bounds when fitting", () => {
    const bounds = planBounds([], [wall], underlay);
    expect(bounds).toEqual([
      { x: 0.9, y: 1.9, width: 3.2, height: 4.2 },
      { x: -2, y: 1, width: 8, height: 5 },
    ]);
    expect(planBounds([], [], { ...underlay, visible: false })).toEqual([]);
  });
  it("fits the swept door sector outside the wall, while windows add no swing", () => {
    const horizontal: Wall = { ...wall, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } };
    const opening = { id: "door", wallId: wall.id, kind: "door" as const, offset: 1, width: 1, height: 2.1, sillHeight: 0 };
    expect(planBounds([], [horizontal], undefined, [opening])).toContainEqual({ x: 1, y: -1, width: 1, height: 1 });
    expect(planBounds([], [horizontal], undefined, [{ ...opening, kind: "window" }])).toHaveLength(1);
    expect(planBounds([], [horizontal], undefined, [{ ...opening, door: { hinge: "end", side: "right" } }])).toContainEqual({ x: 1, y: 0, width: 1, height: 1 });
  });
});

describe("in feet", () => {
  afterEach(() => setUnits("metric"));

  it("draws a line each foot and marks every five feet", () => {
    setUnits("imperial");
    const { vertical } = gridLines({ x: 0, y: 0 }, 100, { width: 400, height: 100 });
    expect(vertical[1].position).toBeCloseTo(100 * FOOT, 6);
    expect(vertical.filter((line) => line.major).map((line) => Math.round(line.position))).toEqual([0, 152, 305]);
  });

  it("snaps the pointer to three inches", () => {
    setUnits("imperial");
    expect(snapToGrid(1)).toBeCloseTo(39 * INCH, 10);
  });
});
