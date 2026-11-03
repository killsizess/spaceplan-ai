import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { addOpening, moveWallNode, updateWall } from "./construction";
import { createEmptyPlan } from "./operations";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Wall } from "./types";
import {
  connectedWallIds,
  previewWallNode,
  previewWallUpdate,
  rebaseOpenings,
  sameWallNode,
} from "./wall-nodes";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 3 };
}

function cornerWalls(): Wall[] {
  return [
    wall("top", { x: 0, y: 0 }, { x: 4, y: 0 }),
    wall("right", { x: 4, y: 0 }, { x: 4, y: 3 }),
    wall("bottom", { x: 0, y: 3 }, { x: 4, y: 3 }),
    wall("left", { x: 0, y: 3 }, { x: 0, y: 0 }),
    wall("branch", { x: 6, y: -1 }, { x: 4, y: 0 }),
  ];
}

function planWith(walls = cornerWalls()): FloorPlan {
  return { ...createEmptyPlan("plan"), walls };
}

describe("coincident wall endpoints", () => {
  it("uses finite Euclidean distance of at most 1e-9 m without bridging real gaps", () => {
    const point = { x: 0, y: 0 };
    expect(sameWallNode(point, { x: 1e-9, y: 0 })).toBe(true);
    expect(sameWallNode(point, { x: 1.01e-9, y: 0 })).toBe(false);
    expect(sameWallNode(point, { x: 0.8e-9, y: 0.8e-9 })).toBe(false);
    expect(sameWallNode(point, { x: 0.00001, y: 0 })).toBe(false);
    expect(sameWallNode({ x: NaN, y: 0 }, point)).toBe(false);
    expect(sameWallNode({ x: Infinity, y: 0 }, { x: Infinity, y: 0 })).toBe(false);
  });

  it("returns sorted unique wall IDs, including reversed walls, but no mid-edge contacts", () => {
    const walls = [
      ...cornerWalls(),
      wall("middle", { x: 2, y: 0 }, { x: 6, y: 0 }),
      wall("gap", { x: 4.00001, y: 0 }, { x: 5, y: 1 }),
    ];
    expect(connectedWallIds([...walls, walls[0]], { x: 4, y: 0 })).toEqual([
      "branch", "right", "top",
    ]);
    expect(connectedWallIds(walls, { x: 2, y: 0 })).toEqual(["middle"]);
    expect(() => connectedWallIds(walls, { x: NaN, y: 0 })).toThrow();
  });
});

describe("immutable wall-node preview", () => {
  it("moves every coincident endpoint in a multi-wall corner and retains untouched references", () => {
    const walls = cornerWalls();
    const before = structuredClone(walls);
    const target = { x: 5, y: 1 };
    const preview = previewWallNode(walls, "top", "end", target);
    expect(preview[0].end).toEqual(target);
    expect(preview[1].start).toEqual(target);
    expect(preview[4].end).toEqual(target);
    expect(preview[2]).toBe(walls[2]);
    expect(preview[3]).toBe(walls[3]);
    expect(preview[1].height).toBe(walls[1].height);
    expect(preview[4].thickness).toBe(walls[4].thickness);
    expect(walls).toEqual(before);
  });

  it("does not connect a nearby gap or the middle of another wall", () => {
    const walls = [
      ...cornerWalls(),
      wall("middle", { x: 2, y: 0 }, { x: 6, y: 0 }),
      wall("gap", { x: 4.00001, y: 0 }, { x: 5, y: 1 }),
    ];
    const moved = previewWallNode(walls, "top", "end", { x: 5, y: 2 });
    expect(moved[5]).toBe(walls[5]);
    expect(moved[6]).toBe(walls[6]);
    const tMove = previewWallNode(walls, "middle", "start", { x: 2, y: 1 });
    expect(tMove[0]).toBe(walls[0]);
  });

  it("maps both old nodes simultaneously even when the selected wall reverses direction", () => {
    const walls = cornerWalls();
    const selected = walls[0];
    const moved = previewWallUpdate(walls, {
      ...selected,
      start: selected.end,
      end: selected.start,
    });
    expect(moved[0].start).toEqual({ x: 4, y: 0 });
    expect(moved[0].end).toEqual({ x: 0, y: 0 });
    expect(moved[1].start).toEqual({ x: 0, y: 0 });
    expect(moved[3].end).toEqual({ x: 4, y: 0 });
    expect(moved[4].end).toEqual({ x: 0, y: 0 });
  });

  it("supports an independent edit and dimension-only changes without touching neighbors", () => {
    const walls = cornerWalls();
    const independent = previewWallNode(walls, "top", "end", { x: 5, y: 1 }, false);
    expect(independent[0].end).toEqual({ x: 5, y: 1 });
    for (let index = 1; index < walls.length; index++) {
      expect(independent[index]).toBe(walls[index]);
    }
    const resized = previewWallUpdate(walls, { ...walls[0], thickness: 0.3, height: 4 });
    for (let index = 1; index < walls.length; index++) {
      expect(resized[index]).toBe(walls[index]);
    }
  });

  it("returns the original readonly array for exact no-ops without rounding real moves", () => {
    const walls: readonly Wall[] = Object.freeze(cornerWalls());
    expect(previewWallNode(walls, "top", "start", { x: 0, y: 0 })).toBe(walls);
    expect(previewWallUpdate(walls, { ...walls[0], start: { x: 0, y: 0 } })).toBe(walls);
    expect(previewWallNode(walls, "top", "start", { x: 0.5e-9, y: 0 })).not.toBe(walls);
  });

  it("allows transient collapsed geometry but rejects missing IDs and invalid points", () => {
    const walls = cornerWalls();
    const collapsed = previewWallNode(walls, "top", "end", walls[0].start);
    expect(collapsed[0].start).toEqual(collapsed[0].end);
    expect(() => previewWallNode(walls, "missing", "end", { x: 1, y: 1 })).toThrow(/не найдена/);
    expect(() => previewWallNode(walls, "", "end", { x: 1, y: 1 })).toThrow();
    for (const point of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 1001, y: 0 }]) {
      expect(() => previewWallNode(walls, "top", "end", point)).toThrow();
    }
  });
});

describe("atomic connected wall edits", () => {
  it("commits both corners in one valid plan while preserving each neighbor's dimensions", () => {
    const original = planWith();
    original.walls[1] = { ...original.walls[1], height: 2.8, thickness: 0.15 };
    const before = structuredClone(original);
    const changed = updateWall(original, {
      ...original.walls[0],
      start: { x: -1, y: 0 },
      end: { x: 5, y: 1 },
      thickness: 0.3,
      height: 3.2,
    });
    expect(changed.walls[1]).toMatchObject({ start: { x: 5, y: 1 }, height: 2.8, thickness: 0.15 });
    expect(changed.walls[3].end).toEqual({ x: -1, y: 0 });
    expect(changed.walls[4].end).toEqual({ x: 5, y: 1 });
    expect(floorPlanSchema.safeParse(changed).success).toBe(true);
    expect(original).toEqual(before);
    expect(updateWall(original, { ...original.walls[0] })).toBe(original);
    expect(moveWallNode(original, "top", "end", { x: 4, y: 0 })).toBe(original);
  });

  it("supports opt-out for both whole-wall and single-node operations", () => {
    const original = planWith();
    const target = { x: 5, y: 1 };
    const moved = moveWallNode(original, "top", "end", target, false);
    expect(moved.walls[0].end).toEqual(target);
    expect(moved.walls.slice(1)).toEqual(original.walls.slice(1));
    const updated = updateWall(original, { ...original.walls[0], end: target }, false);
    expect(updated).toEqual(moved);
  });

  it("rejects selected or neighboring collapses, missing walls and invalid input atomically", () => {
    const original = planWith();
    const before = structuredClone(original);
    for (const point of [
      { x: NaN, y: 0 },
      { x: 1001, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 3 },
    ]) {
      expect(() => moveWallNode(original, "top", "end", point)).toThrow();
      expect(original).toEqual(before);
    }
    expect(() => moveWallNode(original, "missing", "start", { x: 1, y: 1 })).toThrow(/не найдена/);
    expect(() => updateWall(original, { ...original.walls[0], id: "missing" })).toThrow(/не найдена/);
    expect(() => updateWall(original, { ...original.walls[0], height: 0 })).toThrow();
  });

  it("rejects the whole edit when a connected neighbor no longer fits its opening", () => {
    const original = addOpening(planWith(), {
      id: "door",
      wallId: "right",
      kind: "door",
      offset: 1.5,
      width: 1,
      height: 2.1,
      sillHeight: 0,
    });
    const before = structuredClone(original);
    // The right wall would start at y = 1.6, inside the door at y = 1.5..2.5.
    expect(() => moveWallNode(original, "top", "end", { x: 4, y: 1.6 })).toThrow(/границы/);
    expect(original).toEqual(before);
    expect(moveWallNode(original, "top", "end", { x: 4, y: 1.6 }, false).walls[1]).toEqual(original.walls[1]);
  });

  it("keeps openings at their plan position when only a wall start moves", () => {
    const original = addOpening(planWith(), {
      id: "door", wallId: "right", kind: "door", offset: 1.5, width: 1, height: 2.1, sillHeight: 0,
    });
    const moved = moveWallNode(original, "top", "end", { x: 4, y: 1 });
    expect(moved.walls[1]).toMatchObject({ start: { x: 4, y: 1 }, end: { x: 4, y: 3 } });
    // Still y = 1.5..2.5 on the plan, now measured from the new start.
    expect(moved.openings).toEqual([{ ...original.openings[0], offset: 0.5 }]);
    const lengthened = moveWallNode(original, "top", "end", { x: 4, y: -2 });
    expect(lengthened.openings[0].offset).toBeCloseTo(3.5, 12);
  });
});

describe("opening anchoring", () => {
  const door = {
    id: "door", wallId: "wall", kind: "door" as const, offset: 2, width: 0.9, height: 2.1, sillHeight: 0,
  };
  const base = wall("wall", { x: 0, y: 0 }, { x: 10, y: 0 });

  it("anchors openings to the unmoved end, independent of the stored wall direction", () => {
    const openings = [door, { ...door, id: "other-wall", wallId: "other" }];
    const startMoved = rebaseOpenings([base], [{ ...base, start: { x: -3, y: 0 } }], openings);
    expect(startMoved[0].offset).toBe(5);
    expect(startMoved[1]).toBe(openings[1]);
    const endMoved = rebaseOpenings([base], [{ ...base, end: { x: 13, y: 0 } }], openings);
    expect(endMoved).toBe(openings);
    const translated = rebaseOpenings(
      [base],
      [{ ...base, start: { x: 0, y: 1 }, end: { x: 10, y: 1 } }],
      openings,
    );
    expect(translated).toBe(openings);
    // A wall pivoting around its end keeps the opening 7.1 m from that end.
    const pivoted = rebaseOpenings([base], [{ ...base, start: { x: -5, y: 8 } }], openings);
    expect(pivoted[0].offset).toBeCloseTo(9, 12);
    expect(rebaseOpenings([base], [base], openings)).toBe(openings);
  });

  it("returns out-of-wall offsets for validation and clamps only roundoff", () => {
    const cut = rebaseOpenings([base], [{ ...base, start: { x: 3, y: 0 } }], [door]);
    expect(cut[0].offset).toBe(-1);
    const flush = rebaseOpenings([base], [{ ...base, start: { x: 2 + 0.5e-9, y: 0 } }], [door]);
    expect(flush[0].offset).toBe(0);
    expect(() => moveWallNode(
      { ...planWith([base]), openings: [door] }, "wall", "start", { x: 3, y: 0 },
    )).toThrow(/Проём выходит за границы стены/);
  });
});
