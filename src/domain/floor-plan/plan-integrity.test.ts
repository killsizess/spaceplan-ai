import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { addOpening, deleteObject, moveWallNode, updateWall } from "./construction";
import { connectWallJunction } from "./connect-wall-junction";
import { createSpatialExamplePlan } from "./examples";
import { createDefaultRoom, createEmptyPlan, createExamplePlan } from "./operations";
import { checkPlanIntegrity, checkPlanRelations } from "./plan-integrity";
import { addRectangularWallRoom, resizeRectangularWallRoom } from "./rectangular-wall-room";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Opening, Wall } from "./types";
import { analyzeWallConnections } from "./wall-diagnostics";
import { detectWallRooms } from "./wall-rooms";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 2.7 };
}

function door(id: string, wallId: string, offset: number, width = 0.9): Opening {
  return { id, wallId, kind: "door", offset, width, height: 2.1, sillHeight: 0 };
}

function planWithWall(): FloorPlan {
  return { ...createEmptyPlan("plan"), walls: [wall("w", { x: 0, y: 0 }, { x: 4, y: 0 })] };
}

const codes = (plan: FloorPlan) => checkPlanIntegrity(plan).issues.map((item) => item.code);

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe("plan integrity report", () => {
  it("accepts the shipped examples in both room modes without inventing issues", () => {
    for (const plan of [
      createExamplePlan(),
      createSpatialExamplePlan(),
      { ...createSpatialExamplePlan(), roomMode: "walls" as const },
    ]) {
      expect(checkPlanIntegrity(plan)).toEqual({ valid: true, issues: [], errors: 0, warnings: 0, notes: [] });
    }
    expect(checkPlanIntegrity(createEmptyPlan("empty")).valid).toBe(true);
  });

  it("reports non-finite and out-of-range numbers per object without throwing", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("numbers"),
      rooms: [{ ...createDefaultRoom(createEmptyPlan("p"), "room"), x: NaN }],
      walls: [
        wall("nan", { x: NaN, y: 0 }, { x: 1, y: 0 }),
        wall("far", { x: 0, y: 0 }, { x: 1001, y: 0 }),
        { ...wall("thin", { x: 0, y: 1 }, { x: 1, y: 1 }), thickness: 0 },
        { ...wall("tall", { x: 0, y: 2 }, { x: 1, y: 2 }), height: Infinity },
      ],
      openings: [{ ...door("door", "thin", 0.1), width: -1 }],
      wallRoomLabels: [{
        id: "label", name: "Кухня", kind: "kitchen", color: "#ffffff",
        anchor: { x: 0, y: -Infinity }, boundaryWallIds: ["nan"],
      }],
    };
    const report = checkPlanIntegrity(plan);
    expect(report.valid).toBe(false);
    const numbers = report.issues.filter((item) => item.code === "number.invalid");
    expect(numbers.map((item) => item.path)).toEqual([
      ["rooms", 0], ["walls", 0, "start"], ["walls", 1, "end"], ["walls", 2], ["walls", 3],
      ["openings", 0], ["wallRoomLabels", 0, "anchor"],
    ]);
    expect(numbers.map((item) => item.objectIds)).toEqual([
      ["room"], ["nan"], ["far"], ["thin"], ["tall"], ["door"], ["label"],
    ]);
    expect(report.issues.every((item) => item.message.length > 0)).toBe(true);
  });

  it("finds zero-length and over-long walls and points at the degenerate node", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("walls"),
      walls: [
        wall("zero", { x: 1, y: 1 }, { x: 1 + 0.5e-9, y: 1 }),
        wall("long", { x: -1000, y: -1000 }, { x: 1000, y: 1000 }),
        wall("fine", { x: 0, y: 0 }, { x: 2e-9, y: 0 }),
      ],
    };
    const report = checkPlanIntegrity(plan);
    expect(report.issues.map((item) => [item.code, item.objectIds])).toEqual([
      ["wall.degenerate", ["zero"]],
      ["wall.too-long", ["long"]],
    ]);
    expect(report.issues[0].point).toEqual({ x: 1, y: 1 });
  });

  it("checks opening references, bounds on both ends and overlaps on one wall", () => {
    const base = planWithWall();
    expect(codes({ ...base, openings: [door("d", "missing", 1)] })).toEqual(["opening.missing-wall"]);
    for (const opening of [
      door("d", "w", 3.2),
      door("d", "w", -0.5),
      { ...door("d", "w", 1), sillHeight: -0.1 },
      { ...door("d", "w", 1), height: 2.8 },
    ]) {
      const report = checkPlanIntegrity({ ...base, openings: [opening] });
      expect(report.issues.map((item) => [item.code, item.objectIds, item.path])).toEqual([
        ["opening.outside-wall", ["d", "w"], ["openings", 0]],
      ]);
    }
    expect(checkPlanIntegrity({ ...base, openings: [door("d", "w", 3.1)] }).valid).toBe(true);
    expect(codes({ ...base, openings: [door("a", "w", 0.5), door("b", "w", 1.3)] })).toEqual(["opening.overlap"]);
    expect(codes({ ...base, openings: [door("a", "w", 0.5), door("b", "w", 1.4)] })).toEqual([]);
  });

  it("reports each duplicated ID once across all object collections", () => {
    const base = planWithWall();
    const plan: FloorPlan = {
      ...base,
      rooms: [createDefaultRoom(base, "w")],
      openings: [door("d", "w", 1), door("d", "w", 2.5)],
    };
    const duplicates = checkPlanIntegrity(plan).issues.filter((item) => item.code === "id.duplicate");
    expect(duplicates.map((item) => [item.objectIds, item.path])).toEqual([
      [["w"], ["walls", 0, "id"]],
      [["d"], ["openings", 1, "id"]],
    ]);
  });

  it("separates overlapping manual rooms from rooms that only share an edge", () => {
    const [first, second] = createExamplePlan().rooms;
    const touching = { ...createEmptyPlan("rooms"), rooms: [first, second] };
    expect(codes(touching)).toEqual([]);
    expect(codes({ ...touching, rooms: [first, { ...second, x: second.x - 0.5 }] })).toEqual(["room.overlap"]);
  });

  it("reports unresolved wall rooms and skips the check for invalid walls", () => {
    const walls: Wall[] = [];
    for (let line = 0; line <= 11; line++) {
      walls.push(wall(`h${line}`, { x: 0, y: line * 2 }, { x: 22, y: line * 2 }));
      walls.push(wall(`v${line}`, { x: line * 2, y: 0 }, { x: line * 2, y: 22 }));
    }
    const grid: FloorPlan = { ...createEmptyPlan("grid"), roomMode: "walls", walls };
    const unresolved = checkPlanIntegrity(grid);
    expect(unresolved.issues.map((item) => item.code)).toEqual(["wall-rooms.unresolved"]);
    expect(unresolved.issues[0].message).toMatch(/больше 100 помещений/);
    expect(checkPlanIntegrity({ ...grid, roomMode: "manual" }).valid).toBe(true);
    const broken = { ...grid, walls: [...walls, wall("zero", { x: 1, y: 1 }, { x: 1, y: 1 })] };
    const report = checkPlanIntegrity(broken);
    expect(report.issues.map((item) => item.code)).toEqual(["wall.degenerate"]);
    expect(report.notes).toEqual(["Помещения по стенам не проверены: сначала исправьте некорректные стены."]);
  });

  it("warns about collinear duplicates and detached labels without invalidating the plan", () => {
    const base = planWithWall();
    const plan: FloorPlan = {
      ...base,
      walls: [...base.walls, wall("copy", { x: 3, y: 0 }, { x: 1, y: 0 })],
      wallRoomLabels: [{
        id: "label", name: "Кухня", kind: "kitchen", color: "#ffffff",
        anchor: { x: 1, y: 1 }, boundaryWallIds: ["deleted"],
      }],
    };
    const report = checkPlanIntegrity(plan);
    expect(report.valid).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(2);
    expect(report.issues.map((item) => [item.code, item.severity, item.objectIds, item.path])).toEqual([
      ["wall.overlap", "warning", ["w", "copy"], ["walls", 1]],
      ["label.detached", "warning", ["label"], ["wallRoomLabels", 0]],
    ]);
    expect(report.issues[0].point).toEqual({ x: 2, y: 0 });
    // A label keeping at least one live boundary wall is a normal edit history state.
    expect(codes({ ...plan, wallRoomLabels: [{ ...plan.wallRoomLabels[0], boundaryWallIds: ["deleted", "w"] }] }))
      .toEqual(["wall.overlap"]);
  });

  it("never mutates its input and returns the same report for the same plan", () => {
    const plan = freezeDeep({
      ...planWithWall(),
      walls: [wall("w", { x: 0, y: 0 }, { x: 4, y: 0 }), wall("w", { x: 0, y: 0 }, { x: 0, y: 0 })],
      openings: [door("d", "missing", -1)],
    });
    expect(() => checkPlanIntegrity(plan)).not.toThrow();
    expect(checkPlanIntegrity(plan)).toEqual(checkPlanIntegrity(structuredClone(plan)));
  });
});

describe("one definition shared with the format schema", () => {
  const base = planWithWall();
  const rectangle = addRectangularWallRoom(createEmptyPlan("rect"), {
    x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 2.7,
  }, ["top", "right", "bottom", "left"]);
  const variants: [string, FloorPlan][] = [
    ["valid wall", base],
    ["valid rectangle room", rectangle],
    ["valid example", createSpatialExamplePlan()],
    ["NaN coordinate", { ...base, walls: [wall("w", { x: NaN, y: 0 }, { x: 4, y: 0 })] }],
    ["coordinate beyond 1000 m", { ...base, walls: [wall("w", { x: 0, y: 0 }, { x: 1000.5, y: 0 })] }],
    ["zero-length wall", { ...base, walls: [wall("w", { x: 2, y: 2 }, { x: 2, y: 2 })] }],
    ["wall longer than 2000 m", { ...base, walls: [wall("w", { x: -1000, y: -1000 }, { x: 1000, y: 1000 })] }],
    ["zero thickness", { ...base, walls: [{ ...base.walls[0], thickness: 0 }] }],
    ["height above 100 m", { ...base, walls: [{ ...base.walls[0], height: 101 }] }],
    ["missing opening wall", { ...base, openings: [door("d", "x", 1)] }],
    ["negative opening offset", { ...base, openings: [door("d", "w", -0.1)] }],
    ["opening past the wall end", { ...base, openings: [door("d", "w", 3.5)] }],
    ["opening above the wall", { ...base, openings: [{ ...door("d", "w", 1), height: 3 }] }],
    ["zero opening width", { ...base, openings: [door("d", "w", 1, 0)] }],
    ["overlapping openings", { ...base, openings: [door("a", "w", 0), door("b", "w", 0.5)] }],
    ["duplicate IDs", { ...base, openings: [door("w", "w", 1)] }],
    ["tiny manual room", { ...base, rooms: [{ ...createDefaultRoom(base, "r"), width: 0.4 }] }],
    ["manual room beyond 1000 m", { ...base, rooms: [{ ...createDefaultRoom(base, "r"), x: 998 }] }],
    ["overlapping manual rooms", { ...base, rooms: [createDefaultRoom(base, "a"), { ...createDefaultRoom(base, "b"), x: 1 }] }],
    ["label anchor beyond 1000 m", { ...rectangle, wallRoomLabels: [{
      id: "l", name: "A", kind: "other", color: "#ffffff", anchor: { x: 0, y: 2000 }, boundaryWallIds: ["top"],
    }] }],
    ["repeated label boundary", { ...rectangle, wallRoomLabels: [{
      id: "l", name: "A", kind: "other", color: "#ffffff", anchor: { x: 1, y: 1 }, boundaryWallIds: ["top", "top"],
    }] }],
    ["collinear duplicate is only a warning", { ...base, walls: [...base.walls, wall("copy", { x: 0, y: 0 }, { x: 4, y: 0 })] }],
    ["valid requirements", { ...base, requirements: [
      { id: "r1", type: "room-min-area", kind: "kitchen", minArea: 8 },
      { id: "r2", type: "room-max-area", kind: "hall", maxArea: 12 },
      { id: "r3", type: "rooms-connected", kind: "kitchen", otherKind: "hall", byDoor: true },
      { id: "r4", type: "wall-fixed", wallId: "w", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2 },
    ] }],
    ["pinned wall that no longer exists is still valid", { ...base, requirements: [
      { id: "r", type: "wall-fixed", wallId: "gone", start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, thickness: 0.2 },
    ] }],
    ["zero requirement area", { ...base, requirements: [{ id: "r", type: "room-min-area", kind: "kitchen", minArea: 0 }] }],
    ["unknown requirement kind", { ...base, requirements: [{ id: "r", type: "room-not-walkthrough", kind: "garage" as never }] }],
    ["pinned wall without thickness", { ...base, requirements: [
      { id: "r", type: "wall-fixed", wallId: "w", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0 },
    ] }],
    ["pinned wall with NaN point", { ...base, requirements: [
      { id: "r", type: "wall-fixed", wallId: "w", start: { x: NaN, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2 },
    ] }],
    ["requirement ID repeats a wall ID", { ...base, requirements: [{ id: "w", type: "room-not-walkthrough", kind: "hall" }] }],
    ["requirement for one room", { ...base, requirements: [{ id: "r", type: "room-min-area", kind: "hall", minArea: 4, labelId: "any-label" }] }],
    ["requirement with an empty room reference", { ...base, requirements: [{ id: "r", type: "room-not-walkthrough", kind: "hall", labelId: "" }] }],
  ];

  it.each(variants)("%s: schema and integrity agree on validity", (_name, plan) => {
    expect(checkPlanIntegrity(plan).valid).toBe(floorPlanSchema.safeParse(plan).success);
  });

  it("feeds the schema the same messages in the same order as before", () => {
    const plan: FloorPlan = {
      ...base,
      rooms: [createDefaultRoom(base, "w")],
      openings: [door("missing-host", "nowhere", 1), door("long", "w", 3.5), door("a", "w", 0), door("b", "w", 0.5)],
    };
    expect(checkPlanRelations(plan).map((item) => item.message)).toEqual([
      "Идентификаторы объектов должны быть уникальными.",
      "У проёма должна быть существующая стена.",
      "Проём выходит за границы стены.",
      "Проёмы на одной стене не должны перекрываться.",
    ]);
    const parsed = floorPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.filter((item) => item.code === "custom").map((item) => item.path)).toEqual([
      ["walls", 0, "id"], ["openings", 0, "wallId"], ["openings", 1], ["openings", 3],
    ]);
  });
});

describe("editor operations keep the model consistent", () => {
  const ok = (plan: FloorPlan) => {
    const report = checkPlanIntegrity(plan);
    expect(report.issues.filter((item) => item.severity === "error")).toEqual([]);
    return plan;
  };

  it("stays error-free through room creation, doors, resizing, node moves, joins and deletion", () => {
    let plan = ok(addRectangularWallRoom(createEmptyPlan("flow"), {
      x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 2.7,
    }, ["top", "right", "bottom", "left"]));
    plan = ok(addOpening(plan, door("entry", "left", 1)));
    plan = ok(addOpening(plan, { ...door("window", "top", 2, 1.2), kind: "window", height: 1.2, sillHeight: 0.9 }));
    plan = ok(resizeRectangularWallRoom(plan, detectWallRooms(plan.walls).rooms[0], 6, 5));
    plan = ok(moveWallNode(plan, "top", "start", { x: -0.1, y: -1.1 }));
    plan = ok(updateWall(plan, { ...plan.walls[0], height: 3 }));
    plan = ok({ ...plan, walls: [...plan.walls, wall("stub", { x: 3, y: 2 }, { x: 3, y: 4.9 })] });
    const free = analyzeWallConnections(plan.walls).find((item) => item.wallId === "stub" && item.endpoint === "end");
    expect(free?.kind).toBe("near-wall");
    plan = ok(connectWallJunction(plan, free!, "bottom-2"));
    plan = ok(deleteObject(plan, "top"));
    expect(plan.openings.map((item) => item.id)).toEqual(["entry"]);
  });
});
