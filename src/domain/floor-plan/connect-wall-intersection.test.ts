import { describe, expect, it } from "vitest";
import { wallLength, type Point } from "@/domain/geometry";
import { connectWallIntersection } from "./connect-wall-intersection";
import { createDefaultRoom, createEmptyPlan } from "./operations";
import type { FloorPlan, Opening, Wall } from "./types";
import { analyzeWallIntersections, type WallIntersectionDiagnostic } from "./wall-intersections";
import { connectedWallIds, previewWallNode } from "./wall-nodes";
import { detectWallRooms } from "./wall-rooms";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 3 };
}

function crossingPlan(): FloorPlan {
  return {
    ...createEmptyPlan("crossing"),
    walls: [
      wall("horizontal", { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall("vertical", { x: 4, y: -4 }, { x: 4, y: 6 }),
    ],
  };
}

function snapshot(plan: FloorPlan): WallIntersectionDiagnostic {
  const diagnostic = analyzeWallIntersections(plan.walls).intersections[0];
  if (!diagnostic) throw new Error("Fixture must have an axis crossing.");
  return diagnostic;
}

function opening(id: string, wallId: string, offset: number, width: number): Opening {
  return { id, wallId, kind: "door", offset, width, height: 2.1, sillHeight: 0 };
}

function openingPoints(plan: FloorPlan, id: string): readonly [Point, Point] {
  const item = plan.openings.find((candidate) => candidate.id === id);
  if (!item) throw new Error("Opening missing.");
  const owner = plan.walls.find((candidate) => candidate.id === item.wallId);
  if (!owner) throw new Error("Opening wall missing.");
  const length = wallLength(owner.start, owner.end);
  const pointAt = (distance: number) => ({
    x: owner.start.x + (owner.end.x - owner.start.x) * distance / length,
    y: owner.start.y + (owner.end.y - owner.start.y) * distance / length,
  });
  return [pointAt(item.offset), pointAt(item.offset + item.width)];
}

function expectSameBoundary(first: readonly Point[], second: readonly Point[]) {
  for (const point of first) {
    expect(second.some((start, index) => {
      const end = second[(index + 1) % second.length];
      const dx = end.x - start.x, dy = end.y - start.y;
      const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy) < 1e-9;
    })).toBe(true);
  }
}

describe("explicit crossing connection", () => {
  it("creates four oriented segments and one shared node, retaining IDs, properties and inactive rooms", () => {
    const plan = crossingPlan();
    plan.walls[1] = { ...plan.walls[1], thickness: 0.3, height: 2.7 };
    plan.walls.push(wall("unrelated", { x: 20, y: 20 }, { x: 21, y: 20 }));
    plan.rooms = [createDefaultRoom(plan, "manual")];
    const before = structuredClone(plan);
    const result = connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"]);
    expect(result.walls).toEqual([
      { ...plan.walls[0], end: { x: 4, y: 0 } },
      { ...plan.walls[1], end: { x: 4, y: 0 } },
      plan.walls[2],
      { ...plan.walls[0], id: "h-after", start: { x: 4, y: 0 } },
      { ...plan.walls[1], id: "v-after", start: { x: 4, y: 0 } },
    ]);
    expect(result.schemaVersion).toBe(8);
    expect(result.roomMode).toBe(plan.roomMode);
    expect(result.rooms).toEqual(plan.rooms);
    expect(result.openings).toEqual(plan.openings);
    expect(connectedWallIds(result.walls, { x: 4, y: 0 })).toEqual(["h-after", "horizontal", "v-after", "vertical"]);
    expect(analyzeWallIntersections(result.walls).intersections).toEqual([]);
    const moved = previewWallNode(result.walls, "horizontal", "end", { x: 4.2, y: 0.3 });
    for (const id of ["horizontal", "vertical", "h-after", "v-after"]) {
      const item = moved.find((candidate) => candidate.id === id);
      expect(id.endsWith("after") ? item?.start : item?.end).toEqual({ x: 4.2, y: 0.3 });
    }
    expect(plan).toEqual(before);
  });

  it.each([false, true])("retains openings on both sides of both diagonal walls at world positions (reversed: %s)", (reversed) => {
    const plan = crossingPlan();
    plan.walls = [
      wall("horizontal", { x: 0, y: 0 }, { x: 6, y: 8 }),
      wall("vertical", { x: -1, y: 7 }, { x: 7, y: 1 }),
    ].map((item) => reversed ? { ...item, start: item.end, end: item.start } : item);
    plan.openings = [
      opening("h-before", "horizontal", 1, 1),
      { ...opening("h-after-opening", "horizontal", 7, 1.5), kind: "window", height: 1.2, sillHeight: 0.8 },
      opening("v-before", "vertical", 1.3, 0.7),
      { ...opening("v-after-opening", "vertical", 6, 1.2), kind: "window", height: 1.4, sillHeight: 0.9 },
    ];
    const result = connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"]);
    expect(result.walls[0].start).toEqual(plan.walls[0].start);
    expect(result.walls[1].start).toEqual(plan.walls[1].start);
    expect(result.walls[2].end).toEqual(plan.walls[0].end);
    expect(result.walls[3].end).toEqual(plan.walls[1].end);
    expect(result.walls[0].end.x).toBeCloseTo(3, 12);
    expect(result.walls[0].end.y).toBeCloseTo(4, 12);
    expect(result.openings[0]).toEqual(plan.openings[0]);
    expect(result.openings[1]).toEqual({ ...plan.openings[1], wallId: "h-after", offset: 2 });
    expect(result.openings[2]).toEqual(plan.openings[2]);
    expect(result.openings[3]).toEqual({ ...plan.openings[3], wallId: "v-after", offset: 1 });
    for (const item of plan.openings) {
      const before = openingPoints(plan, item.id);
      openingPoints(result, item.id).forEach((point, index) => {
        expect(Math.hypot(point.x - before[index].x, point.y - before[index].y)).toBeLessThanOrEqual(1e-9);
      });
    }
  });

  it.each([false, true])("preserves openings touching each split boundary (reverse: %s)", (reverse) => {
    const plan = crossingPlan();
    if (reverse) plan.walls = plan.walls.map((item) => ({ ...item, start: item.end, end: item.start }));
    const distance = reverse ? 6 : 4;
    plan.openings = [
      opening("h-before", "horizontal", distance - 1, 1), opening("h-after", "horizontal", distance, 1),
      opening("v-before", "vertical", distance - 1, 1), opening("v-after", "vertical", distance, 1),
    ];
    const result = connectWallIntersection(plan, snapshot(plan), ["h-downstream", "v-downstream"]);
    expect(result.openings).toEqual([
      plan.openings[0], { ...plan.openings[1], wallId: "h-downstream", offset: 0 },
      plan.openings[2], { ...plan.openings[3], wallId: "v-downstream", offset: 0 },
    ]);
  });

  it("applies the same sub-nanometre opening boundary tolerance as T-connections", () => {
    const plan = crossingPlan();
    plan.openings = [
      opening("before", "horizontal", 3, 1 + 0.4e-9),
      opening("after", "vertical", 4 - 0.4e-9, 1),
    ];
    const result = connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"]);
    expect(result.openings[0]).toEqual(plan.openings[0]);
    expect(result.openings[1]).toEqual({ ...plan.openings[1], wallId: "v-after", offset: 0 });
    const before = openingPoints(plan, "after");
    openingPoints(result, "after").forEach((point, index) => {
      expect(Math.hypot(point.x - before[index].x, point.y - before[index].y)).toBeLessThan(1e-9);
    });
  });

  it.each(["horizontal", "vertical"])("rejects crossing an opening on %s with no partial split or opening transfer", (wallId) => {
    const plan = crossingPlan();
    plan.openings = [opening("safe-after", "horizontal", 7, 1), opening("crossing-door", wallId, 3.5, 1)];
    const before = structuredClone(plan);
    expect(() => connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"])).toThrow(/внутрь проёма/);
    expect(plan).toEqual(before);
  });

  it.each([false, true])("preserves the physical geometry of all four rooms (reverse: %s)", (reverse) => {
    const plan = crossingPlan();
    plan.roomMode = "walls";
    plan.walls = [
      wall("horizontal", { x: 0, y: 5 }, { x: 10, y: 5 }),
      wall("vertical", { x: 4, y: 0 }, { x: 4, y: 10 }),
      wall("top", { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall("right", { x: 10, y: 0 }, { x: 10, y: 10 }),
      wall("bottom", { x: 10, y: 10 }, { x: 0, y: 10 }),
      wall("left", { x: 0, y: 10 }, { x: 0, y: 0 }),
    ].map((item) => reverse ? { ...item, start: item.end, end: item.start } : item);
    const before = detectWallRooms(plan.walls).rooms;
    const result = connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"]);
    const after = detectWallRooms(result.walls).rooms;
    expect(before).toHaveLength(4);
    expect(after).toHaveLength(4);
    const sorted = (rooms: typeof before) => [...rooms].sort((a, b) => a.labelPoint.x - b.labelPoint.x || a.labelPoint.y - b.labelPoint.y);
    sorted(after).forEach((room, index) => {
      const original = sorted(before)[index];
      expect(room.area).toBeCloseTo(original.area, 10);
      expect(room.perimeter).toBeCloseTo(original.perimeter, 10);
      expect(room.holes).toEqual(original.holes);
      expectSameBoundary(room.outer, original.outer);
      expectSameBoundary(original.outer, room.outer);
    });
  });

  it("accepts deeply frozen input, without moving the fixed wall ends", () => {
    const plan = crossingPlan();
    for (const item of plan.walls) {
      Object.freeze(item.start); Object.freeze(item.end); Object.freeze(item);
    }
    Object.freeze(plan.walls); Object.freeze(plan.rooms); Object.freeze(plan.openings); Object.freeze(plan);
    const result = connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"]);
    expect(result.walls[0].start).toEqual({ x: 0, y: 0 });
    expect(result.walls[2].end).toEqual({ x: 10, y: 0 });
    expect(plan.walls).toHaveLength(2);
  });

  it.each(["horizontal", "vertical"])("rejects a stale moved or deleted %s wall", (id) => {
    const plan = crossingPlan();
    const diagnostic = snapshot(plan);
    const changed = { ...plan, walls: plan.walls.map((item) => item.id !== id ? item : {
      ...item, start: { x: item.start.x + 0.01, y: item.start.y + 0.01 },
      end: { x: item.end.x + 0.01, y: item.end.y + 0.01 },
    }) };
    expect(() => connectWallIntersection(changed, diagnostic, ["h-after", "v-after"])).toThrow(/изменилось/);
    expect(() => connectWallIntersection({ ...plan, walls: plan.walls.filter((item) => item.id !== id) }, diagnostic, ["h-after", "v-after"]))
      .toThrow(/изменилось/);
  });

  it("rejects replay and an axis that now only touches an end or overlaps", () => {
    const plan = crossingPlan();
    const diagnostic = snapshot(plan);
    const result = connectWallIntersection(plan, diagnostic, ["h-after", "v-after"]);
    expect(() => connectWallIntersection(result, diagnostic, ["h-third", "v-third"])).toThrow(/изменилось/);
    const touching = { ...plan, walls: [plan.walls[0], { ...plan.walls[1], start: { x: 4, y: 0 } }] };
    const overlapping = { ...plan, walls: [plan.walls[0], { ...plan.walls[1], start: { x: 4, y: 0 }, end: { x: 8, y: 0 } }] };
    for (const changed of [touching, overlapping]) {
      expect(() => connectWallIntersection(changed, diagnostic, ["h-after", "v-after"])).toThrow(/изменилось/);
    }
  });

  it("uses the exact live intersection when snapshot drift is within node tolerance", () => {
    const plan = crossingPlan();
    const diagnostic = snapshot(plan);
    const changed = {
      ...plan, walls: [{ ...plan.walls[0], start: { x: 0, y: 0.5e-9 }, end: { x: 10, y: 0.5e-9 } }, plan.walls[1]],
    };
    const result = connectWallIntersection(changed, diagnostic, ["h-after", "v-after"]);
    expect(result.walls[0].end).toEqual({ x: 4, y: 0.5e-9 });
    expect(result.walls[1].end).toEqual(result.walls[0].end);
    expect(result.walls[2].start).toEqual(result.walls[0].end);
    expect(result.walls[3].start).toEqual(result.walls[0].end);
  });

  it.each([
    ["horizontal", "v-after"], ["same", "same"], ["", "v-after"], ["h-after", "x".repeat(101)],
  ] as const)("rejects invalid or duplicate downstream IDs %s and %s", (first, second) => {
    const plan = crossingPlan();
    expect(() => connectWallIntersection(plan, snapshot(plan), [first, second])).toThrow(/Идентификатор/);
    expect(plan.walls).toHaveLength(2);
  });

  it("checks new IDs against rooms and openings as well as walls", () => {
    const plan = crossingPlan();
    plan.rooms = [createDefaultRoom(plan, "manual")];
    plan.openings = [opening("door", "horizontal", 7, 1)];
    for (const duplicate of ["manual", "door"]) {
      expect(() => connectWallIntersection(plan, snapshot(plan), ["h-after", duplicate])).toThrow(/уже существует/);
    }
  });

  it("rejects malformed or fabricated diagnostic pairs and invalid points", () => {
    const plan = crossingPlan();
    const diagnostic = snapshot(plan);
    for (const wallIds of [["horizontal", "horizontal"], ["", "vertical"], ["vertical", "horizontal"], ["missing", "vertical"]] as const) {
      expect(() => connectWallIntersection(plan, { ...diagnostic, wallIds }, ["h-after", "v-after"])).toThrow();
    }
    for (const point of [{ x: NaN, y: 0 }, { x: 4.01, y: 0 }]) {
      expect(() => connectWallIntersection(plan, { ...diagnostic, point }, ["h-after", "v-after"])).toThrow();
    }
  });

  it("allows exactly 1000 resulting walls and rejects the whole edit at 999 original walls", () => {
    const plan = crossingPlan();
    plan.walls.push(...Array.from({ length: 996 }, (_, index) => wall(`extra-${index}`, { x: 100, y: 100 }, { x: 101, y: 100 })));
    const diagnostic = {
      id: 'wall-intersection:["horizontal","vertical"]',
      wallIds: ["horizontal", "vertical"] as const, point: { x: 4, y: 0 },
    };
    expect(connectWallIntersection(plan, diagnostic, ["h-after", "v-after"]).walls).toHaveLength(1000);
    plan.walls.push(wall("extra-997", { x: 100, y: 100 }, { x: 101, y: 100 }));
    const before = structuredClone(plan);
    expect(() => connectWallIntersection(plan, diagnostic, ["h-after", "v-after"])).toThrow(/1000 стен/);
    expect(plan).toEqual(before);
  });

  it("validates the assembled plan and preserves the original on a property error", () => {
    const plan = crossingPlan();
    plan.walls[1] = { ...plan.walls[1], height: -1 };
    const before = structuredClone(plan);
    expect(() => connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"])).toThrow(/Проверьте/);
    expect(plan).toEqual(before);
  });

  it("rejects a third wall through the crossing instead of leaving its axis unsplit and hidden", () => {
    const plan = crossingPlan();
    plan.walls.push(wall("third", { x: 1, y: -3 }, { x: 7, y: 3 }));
    const before = structuredClone(plan);
    const diagnostic = analyzeWallIntersections(plan.walls).intersections.find((item) => item.wallIds[1] === "vertical" && item.wallIds[0] === "horizontal");
    if (!diagnostic) throw new Error("Missing pair.");
    expect(() => connectWallIntersection(plan, diagnostic, ["h-after", "v-after"])).toThrow(/больше двух стен/);
    expect(plan).toEqual(before);
    expect(analyzeWallIntersections(plan.walls).intersections).toHaveLength(3);
  });

  it("allows a third wall ending at the crossing and includes it in the shared node", () => {
    const plan = crossingPlan();
    plan.walls.push(wall("third", { x: 1, y: -3 }, { x: 4, y: 0 }));
    const result = connectWallIntersection(plan, snapshot(plan), ["h-after", "v-after"]);
    expect(result.walls[2]).toEqual(plan.walls[2]);
    expect(connectedWallIds(result.walls, { x: 4, y: 0 })).toEqual(["h-after", "horizontal", "third", "v-after", "vertical"]);
  });
});
