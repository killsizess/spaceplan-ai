import { describe, expect, it } from "vitest";
import { wallLength, type Point } from "@/domain/geometry";
import { connectWallJunction } from "./connect-wall-junction";
import { createDefaultRoom, createEmptyPlan } from "./operations";
import type { FloorPlan, Opening, Wall } from "./types";
import { analyzeWallConnections, type WallConnectionDiagnostic } from "./wall-diagnostics";
import { connectedWallIds, type WallEndpoint } from "./wall-nodes";
import { detectWallRooms } from "./wall-rooms";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 3 };
}

function junctionPlan(gap = 0.2): FloorPlan {
  return {
    ...createEmptyPlan("junction"),
    walls: [
      wall("source", { x: 2, y: gap }, { x: 2, y: 3 }),
      wall("target", { x: 0, y: 0 }, { x: 6, y: 0 }),
    ],
  };
}

function snapshot(plan: FloorPlan, endpoint: WallEndpoint = "start") {
  const diagnostic = analyzeWallConnections(plan.walls).find((item) =>
    item.wallId === "source" && item.endpoint === endpoint,
  );
  if (!diagnostic) throw new Error("Fixture must have a free endpoint.");
  return diagnostic;
}

function opening(id: string, offset: number, width: number): Opening {
  return { id, wallId: "target", kind: "door", offset, width, height: 2.1, sillHeight: 0 };
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

function expectSameOpeningPoints(before: FloorPlan, after: FloorPlan, id: string) {
  const original = openingPoints(before, id);
  const result = openingPoints(after, id);
  result.forEach((point, index) => {
    expect(Math.hypot(point.x - original[index].x, point.y - original[index].y)).toBeLessThanOrEqual(1e-9);
  });
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

describe("explicit T-junction", () => {
  it.each([0, 0.2, 0.3, -0.3])("moves the selected endpoint across %s m and splits only the target", (gap) => {
    const plan = junctionPlan(gap);
    plan.walls.push(wall("unrelated", { x: 20, y: 20 }, { x: 21, y: 20 }));
    plan.rooms = [createDefaultRoom(plan, "manual")];
    const before = structuredClone(plan);
    const result = connectWallJunction(plan, snapshot(plan), "second-half");
    expect(result.schemaVersion).toBe(9);
    expect(result.roomMode).toBe(plan.roomMode);
    expect(result.walls).toEqual([
      { ...plan.walls[0], start: { x: 2, y: 0 } },
      { ...plan.walls[1], end: { x: 2, y: 0 } },
      plan.walls[2],
      { ...plan.walls[1], id: "second-half", start: { x: 2, y: 0 } },
    ]);
    expect(result.rooms).toEqual(plan.rooms);
    expect(result.openings).toEqual(plan.openings);
    expect(connectedWallIds(result.walls, { x: 2, y: 0 })).toEqual(["second-half", "source", "target"]);
    expect(analyzeWallConnections(result.walls).some((item) => item.wallId === "source" && item.endpoint === "start"))
      .toBe(false);
    expect(plan).toEqual(before);
  });

  it("supports the source end and a reversed target without reversing either wall", () => {
    const plan = junctionPlan();
    plan.walls = plan.walls.map((item) => ({ ...item, start: item.end, end: item.start }));
    const result = connectWallJunction(plan, snapshot(plan, "end"), "second-half");
    expect(result.walls).toEqual([
      { ...plan.walls[0], end: { x: 2, y: 0 } },
      { ...plan.walls[1], end: { x: 2, y: 0 } },
      { ...plan.walls[1], id: "second-half", start: { x: 2, y: 0 } },
    ]);
  });

  it.each([false, true])("preserves diagonal openings and orientation (reversed target: %s)", (reversed) => {
    const plan = junctionPlan();
    const target = wall("target", { x: 0, y: 0 }, { x: 6, y: 8 });
    plan.walls = [
      wall("source", { x: 3.08, y: 3.94 }, { x: 5, y: 2.5 }),
      reversed ? { ...target, start: target.end, end: target.start } : target,
    ];
    plan.openings = [opening("before", 1, 1), opening("after", 7, 1.5)];
    const result = connectWallJunction(plan, snapshot(plan), "second-half");
    expect(result.walls[0].start.x).toBeCloseTo(3, 12);
    expect(result.walls[0].start.y).toBeCloseTo(4, 12);
    expect(result.walls[1].start).toEqual(plan.walls[1].start);
    expect(result.walls[2].end).toEqual(plan.walls[1].end);
    expect(wallLength(result.walls[1].start, result.walls[1].end)).toBeCloseTo(5, 12);
    expect(result.openings[0]).toEqual(plan.openings[0]);
    expect(result.openings[1]).toEqual({ ...plan.openings[1], wallId: "second-half", offset: 2 });
    for (const item of plan.openings) expectSameOpeningPoints(plan, result, item.id);
  });

  it.each([false, true])("keeps openings before and after the split at their world coordinates (reversed: %s)", (reversed) => {
    const plan = junctionPlan(0);
    if (reversed) plan.walls[1] = { ...plan.walls[1], start: plan.walls[1].end, end: plan.walls[1].start };
    const distance = reversed ? 4 : 2;
    plan.openings = [
      opening("before", distance - 1.2, 0.8),
      { ...opening("after", distance + 0.3, 0.7), kind: "window", height: 1.2, sillHeight: 0.8 },
      { ...opening("unrelated", 0.1, 0.8), wallId: "source" },
    ];
    const result = connectWallJunction(plan, snapshot(plan), "second-half");
    expect(result.openings[0]).toEqual(plan.openings[0]);
    expect(result.openings[1]).toEqual({ ...plan.openings[1], wallId: "second-half", offset: plan.openings[1].offset - distance });
    expect(result.openings[2]).toEqual(plan.openings[2]);
    for (const item of plan.openings) expectSameOpeningPoints(plan, result, item.id);
  });

  it.each([false, true])("supports openings touching both split boundaries (reversed: %s)", (reversed) => {
    const plan = junctionPlan(0);
    if (reversed) plan.walls[1] = { ...plan.walls[1], start: plan.walls[1].end, end: plan.walls[1].start };
    const distance = reversed ? 4 : 2;
    plan.openings = [opening("before", distance - 1, 1), opening("after", distance, 1)];
    const result = connectWallJunction(plan, snapshot(plan), "second-half");
    expect(result.openings[0]).toEqual(plan.openings[0]);
    expect(result.openings[1]).toEqual({ ...plan.openings[1], wallId: "second-half", offset: 0 });
    for (const item of plan.openings) expectSameOpeningPoints(plan, result, item.id);
  });

  it("handles boundary roundoff within node tolerance without a measurable opening shift", () => {
    const plan = junctionPlan(0);
    plan.openings = [opening("before", 1, 1 + 0.4e-9), opening("after", 2 - 0.4e-9, 1)];
    const result = connectWallJunction(plan, snapshot(plan), "second-half");
    expect(result.openings[0]).toEqual(plan.openings[0]);
    expect(result.openings[1].offset).toBe(0);
    for (const item of plan.openings) expectSameOpeningPoints(plan, result, item.id);
  });

  it.each([false, true])("rejects a split through an opening with no mutation (reversed: %s)", (reversed) => {
    const plan = junctionPlan(0);
    if (reversed) plan.walls[1] = { ...plan.walls[1], start: plan.walls[1].end, end: plan.walls[1].start };
    const distance = reversed ? 4 : 2;
    plan.openings = [opening("crossing", distance - 0.2, 0.8)];
    const before = structuredClone(plan);
    expect(() => connectWallJunction(plan, snapshot(plan), "second-half")).toThrow(/внутрь проёма/);
    expect(plan).toEqual(before);
  });

  it("keeps source openings in place and rejects shortening through one", () => {
    const plan = junctionPlan(-0.2);
    plan.walls[0] = { ...plan.walls[0], end: { x: 2, y: 2 } };
    // The joined start moves from y = -0.2 to 0; a door at y = 1.2..2 stays there.
    plan.openings = [{ ...opening("door", 1.4, 0.8), wallId: "source" }];
    const joined = connectWallJunction(plan, snapshot(plan), "second-half");
    expect(joined.openings[0].offset).toBeCloseTo(1.2, 12);
    expectSameOpeningPoints(plan, joined, "door");
    // A window at y = -0.1..0.7 would be cut by the new start.
    plan.openings = [{ ...opening("window", 0.1, 0.8), wallId: "source", kind: "window", height: 1.2, sillHeight: 0.8 }];
    const before = structuredClone(plan);
    expect(() => connectWallJunction(plan, snapshot(plan), "second-half")).toThrow(/Проём выходит за границы/);
    expect(plan).toEqual(before);
  });

  it.each([false, true])("preserves room geometry when splitting an already touching diagonal wall (reversed: %s)", (reversed) => {
    const plan = junctionPlan(0);
    const target = wall("target", { x: 3, y: 0 }, { x: 6, y: 4 });
    plan.roomMode = "walls";
    plan.walls = [
      wall("source", { x: 0, y: 2 }, { x: 4.5, y: 2 }),
      reversed ? { ...target, start: target.end, end: target.start } : target,
      wall("top", { x: 0, y: 0 }, { x: 6, y: 0 }),
      wall("right", { x: 6, y: 0 }, { x: 6, y: 4 }),
      wall("bottom", { x: 6, y: 4 }, { x: 0, y: 4 }),
      wall("left", { x: 0, y: 4 }, { x: 0, y: 0 }),
    ];
    const before = detectWallRooms(plan.walls).rooms;
    const result = connectWallJunction(plan, snapshot(plan, "end"), "second-half");
    const after = detectWallRooms(result.walls).rooms;
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(before.length);
    const sorted = (rooms: typeof before) => [...rooms].sort((a, b) => a.area - b.area);
    sorted(after).forEach((room, index) => {
      const original = sorted(before)[index];
      expect(room.area).toBeCloseTo(original.area, 10);
      expect(room.perimeter).toBeCloseTo(original.perimeter, 10);
      expect(room.holes).toEqual(original.holes);
      // Polygon union may retain an extra collinear vertex at the new node.
      expectSameBoundary(room.outer, original.outer);
      expectSameBoundary(original.outer, room.outer);
    });
  });

  it.each(["source", "target"])("rejects a stale moved %s geometry", (id) => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    const changed = {
      ...plan,
      walls: plan.walls.map((item) => item.id !== id ? item : id === "source"
        ? { ...item, start: { x: 2.01, y: 0.2 } }
        : { ...item, start: { x: 0, y: 0.01 }, end: { x: 6, y: 0.01 } }),
    };
    expect(() => connectWallJunction(changed, diagnostic, "second-half")).toThrow(/изменилось/);
  });

  it.each(["source", "target"])("rejects a stale deleted %s wall", (id) => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    expect(() => connectWallJunction({ ...plan, walls: plan.walls.filter((item) => item.id !== id) }, diagnostic, "second-half"))
      .toThrow(/изменилось/);
  });

  it("rejects changed candidate identity, kind, a newly connected end, and replay", () => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    const nearer = { ...plan, walls: [...plan.walls, wall("closer", { x: 0, y: 0.1 }, { x: 6, y: 0.1 })] };
    expect(() => connectWallJunction(nearer, diagnostic, "second-half")).toThrow(/изменилось/);
    const connected = { ...plan, walls: [...plan.walls, wall("attached", { x: 2, y: 0.2 }, { x: 4, y: 3 })] };
    expect(() => connectWallJunction(connected, diagnostic, "second-half")).toThrow(/изменилось/);
    const touching = { ...plan, walls: [{ ...plan.walls[0], start: { x: 2, y: 0 } }, plan.walls[1]] };
    expect(() => connectWallJunction(touching, { ...diagnostic, point: { x: 2, y: 0 } }, "second-half"))
      .toThrow(/изменилось/);
    const result = connectWallJunction(plan, diagnostic, "second-half");
    expect(() => connectWallJunction(result, diagnostic, "third-half")).toThrow(/изменилось/);
  });

  it("uses the live projection within node tolerance, preserving its precision", () => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    const changed = {
      ...plan,
      walls: [plan.walls[0], { ...plan.walls[1], start: { x: 0, y: 0.5e-9 }, end: { x: 6, y: 0.5e-9 } }],
    };
    expect(connectWallJunction(changed, diagnostic, "second-half").walls[0].start)
      .toEqual({ x: 2, y: 0.5e-9 });
  });

  it("rejects fabricated mid-wall candidates beyond the distance limit", () => {
    const plan = junctionPlan(0.31);
    const diagnostic: WallConnectionDiagnostic = {
      id: "wall-diagnostic:source:start", wallId: "source", endpoint: "start", point: { x: 2, y: 0.31 },
      kind: "near-wall", target: { wallId: "target", point: { x: 2, y: 0 } }, distance: 0.2,
    };
    expect(() => connectWallJunction(plan, diagnostic, "second-half")).toThrow(/изменилось/);
  });

  it("rejects endpoint targets, open ends and malformed candidate data", () => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    if (diagnostic.kind !== "near-wall") throw new Error("Expected near-wall fixture.");
    const open: WallConnectionDiagnostic = { id: diagnostic.id, wallId: diagnostic.wallId, endpoint: diagnostic.endpoint, point: diagnostic.point, kind: "open" };
    expect(() => connectWallJunction(plan, open, "second-half")).toThrow(/серединой стены/);
    expect(() => connectWallJunction(plan, { ...diagnostic, kind: "near-endpoint" }, "second-half"))
      .toThrow(/серединой стены/);
    expect(() => connectWallJunction(plan, { ...diagnostic, target: { ...diagnostic.target, endpoint: "end" as const } }, "second-half"))
      .toThrow(/серединой стены/);
    for (const distance of [NaN, Infinity, -0.1, 0.31]) {
      expect(() => connectWallJunction(plan, { ...diagnostic, distance }, "second-half")).toThrow(/Некорректное/);
    }
    for (const point of [{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 1001, y: 0 }]) {
      expect(() => connectWallJunction(plan, { ...diagnostic, point }, "second-half")).toThrow(/Координаты/);
      expect(() => connectWallJunction(plan, { ...diagnostic, target: { ...diagnostic.target, point } }, "second-half"))
        .toThrow(/Координаты/);
    }
    expect(() => connectWallJunction(plan, { ...diagnostic, target: { ...diagnostic.target, wallId: "source" } }, "second-half"))
      .toThrow(/Некорректное/);
    expect(() => connectWallJunction(plan, { ...diagnostic, endpoint: "invalid" as WallEndpoint }, "second-half"))
      .toThrow(/Некорректное/);
  });

  it.each(["", "x".repeat(101)])("rejects a new wall ID of invalid length %j", (id) => {
    const plan = junctionPlan();
    expect(() => connectWallJunction(plan, snapshot(plan), id)).toThrow(/от 1 до 100/);
  });

  it.each(["source", "target", "room", "door"])("rejects ID collisions with every object type: %s", (id) => {
    const plan = junctionPlan();
    plan.rooms = [createDefaultRoom(plan, "room")];
    plan.openings = [opening("door", 0.2, 0.8)];
    expect(() => connectWallJunction(plan, snapshot(plan), id)).toThrow(/уже существует/);
  });

  it("accepts the maximum ID length and the last available wall slot, rejecting the next split", () => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    for (let index = 0; index < 997; index++) {
      plan.walls.push(wall(`remote-${index}`, { x: -900 + index * 0.5, y: 100 }, { x: -900 + index * 0.5, y: 101 }));
    }
    const result = connectWallJunction(plan, diagnostic, "x".repeat(100));
    expect(result.walls).toHaveLength(1000);
    expect(() => connectWallJunction(result, diagnostic, "another-split")).toThrow(/уже 1000 стен/);
    expect(plan.walls).toHaveLength(999);
  });

  it.each([0, 0.5e-9])("rejects collinear or numerically degenerate branches at y=%s", (y) => {
    const plan = junctionPlan();
    plan.walls[0] = wall("source", { x: 2, y: 0.2 }, { x: 3, y });
    expect(() => connectWallJunction(plan, snapshot(plan), "second-half")).toThrow(/одной прямой/);
  });

  it("does not turn a tiny endpoint contact into a zero-length target segment", () => {
    const plan = junctionPlan();
    plan.walls[0] = wall("source", { x: 0.5e-9, y: 0 }, { x: 0.5e-9, y: 2 });
    const diagnostic: WallConnectionDiagnostic = {
      id: "wall-diagnostic:source:start", wallId: "source", endpoint: "start", point: plan.walls[0].start,
      kind: "junction", distance: 0, target: { wallId: "target", point: plan.walls[0].start },
    };
    expect(() => connectWallJunction(plan, diagnostic, "second-half")).toThrow(/изменилось/);
    expect(plan.walls).toHaveLength(2);
  });

  it("rejects invalid live coordinates, duplicate IDs and invalid opening data atomically", () => {
    const plan = junctionPlan();
    const diagnostic = snapshot(plan);
    expect(() => connectWallJunction({ ...plan, walls: [{ ...plan.walls[0], end: { x: NaN, y: 3 } }, plan.walls[1]] }, diagnostic, "second-half"))
      .toThrow(/Координаты/);
    expect(() => connectWallJunction({ ...plan, walls: [...plan.walls, plan.walls[1]] }, diagnostic, "second-half"))
      .toThrow(/уникальными/);
    expect(() => connectWallJunction({ ...plan, openings: [opening("invalid", NaN, 1)] }, diagnostic, "second-half"))
      .toThrow();
  });

  it("accepts deeply frozen input and leaves all originals unchanged", () => {
    const plan = junctionPlan();
    plan.openings = [opening("after", 3, 1)];
    const diagnostic = snapshot(plan);
    const before = structuredClone(plan);
    function freeze(value: unknown): void {
      if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
      }
    }
    freeze(plan);
    freeze(diagnostic);
    const result = connectWallJunction(plan, diagnostic, "second-half");
    expect(result.walls).toHaveLength(3);
    expect(result.openings[0].wallId).toBe("second-half");
    expect(plan).toEqual(before);
    expect(diagnostic).toEqual(snapshot(plan));
  });
});
