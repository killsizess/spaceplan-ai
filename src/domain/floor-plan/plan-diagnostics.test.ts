import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { analyzeDoorWallCollisions, type DoorWallCollision } from "./door-collisions";
import { analyzeDoorPairCollisions, type DoorPairCollision } from "./door-pair-collisions";
import { createEmptyPlan } from "./operations";
import { summarizePlanDiagnostics, type PlanDiagnosticSources } from "./plan-diagnostics";
import type { Wall } from "./types";
import { analyzeWallConnections, type WallConnectionDiagnostic } from "./wall-diagnostics";
import { analyzeWallIntersections, type WallIntersectionDiagnostic } from "./wall-intersections";
import { analyzeWallOverlaps, type WallOverlapDiagnostic } from "./wall-overlaps";

function emptySources(): PlanDiagnosticSources {
  return {
    connections: [],
    intersections: { intersections: [], truncated: false },
    overlaps: { overlaps: [], truncated: false },
    doorWalls: { collisions: [], truncated: false },
    doorPairs: { collisions: [], truncated: false },
  };
}

function freeEnd(id: string, wallId = id, point: Point = { x: 0, y: 0 }): WallConnectionDiagnostic {
  return { id, wallId, endpoint: "end", point, kind: "open" };
}

function nearEnd(id: string, wallId: string, targetWallId: string,
  endpoint: "start" | "end" = "end", targetEndpoint: "start" | "end" = "start",
): WallConnectionDiagnostic {
  return {
    id, wallId, endpoint, point: { x: 1, y: 0 }, kind: "near-endpoint",
    target: { wallId: targetWallId, endpoint: targetEndpoint, point: { x: 1.1, y: 0 } }, distance: 0.1,
  };
}

const intersection: WallIntersectionDiagnostic = {
  id: "crossing", wallIds: ["first", "second"], point: { x: 2, y: 3 },
};
const overlap: WallOverlapDiagnostic = {
  id: "overlap", wallIds: ["first", "third"], point: { x: 1, y: 0 }, length: 2,
};
const doorWall: DoorWallCollision = {
  id: "door-wall", doorId: "door-one", wallId: "second", point: { x: 3, y: 4 },
};
const doorPair: DoorPairCollision = {
  id: "door-pair", doorIds: ["door-one", "door-two"], point: { x: 4, y: 5 },
};

function allSources(): PlanDiagnosticSources {
  return {
    connections: [freeEnd("free-end")],
    intersections: { intersections: [intersection], truncated: false },
    overlaps: { overlaps: [overlap], truncated: false },
    doorWalls: { collisions: [doorWall], truncated: false },
    doorPairs: { collisions: [doorPair], truncated: false },
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe("live plan diagnostics summary", () => {
  it("returns a neutral empty report without a grade or invented missing checks", () => {
    expect(summarizePlanDiagnostics(emptySources())).toEqual({
      items: [], total: 0, incomplete: false,
      counts: { connections: 0, intersections: 0, overlaps: 0, "door-wall": 0, "door-pair": 0 },
      truncated: { connections: false, intersections: false, overlaps: false, "door-wall": false, "door-pair": false },
    });
  });

  it("keeps all five categories in stable order and retains the original navigation payloads", () => {
    const sources = allSources();
    const report = summarizePlanDiagnostics(sources);
    expect(report.items.map((item) => item.kind)).toEqual(["connections", "intersections", "overlaps", "door-wall", "door-pair"]);
    expect(report.items.map((item) => item.diagnostic)).toEqual([sources.connections[0], intersection, overlap, doorWall, doorPair]);
    expect(report.items[0].diagnostic).toBe(sources.connections[0]);
    expect(report.items[1].diagnostic).toBe(intersection);
    expect(report.items[2].diagnostic).toBe(overlap);
    expect(report.items[3].diagnostic).toBe(doorWall);
    expect(report.items[4].diagnostic).toBe(doorPair);
    expect(report.counts).toEqual({ connections: 1, intersections: 1, overlaps: 1, "door-wall": 1, "door-pair": 1 });
    expect(report.total).toBe(5);
    expect(report.incomplete).toBe(false);
  });

  it("represents reciprocal near endpoints once with a stable minimum-ID source", () => {
    const first = nearEnd("z-source", "wall-a", "wall-b");
    const second = nearEnd("a-source", "wall-b", "wall-a", "start", "end");
    const forward = summarizePlanDiagnostics({ ...emptySources(), connections: [first, second] });
    const backward = summarizePlanDiagnostics({ ...emptySources(), connections: [second, first] });
    expect(forward).toEqual(backward);
    expect(forward.total).toBe(1);
    expect(forward.counts.connections).toBe(1);
    expect(forward.items[0].diagnostic).toBe(second);
    expect(first.id).toBe("z-source");
  });

  it("does not combine one-way near links to different target ends", () => {
    const first = nearEnd("a", "wall-a", "wall-b");
    const second = nearEnd("b", "wall-b", "wall-c", "start", "end");
    const report = summarizePlanDiagnostics({ ...emptySources(), connections: [first, second] });
    expect(report.total).toBe(2);
    expect(report.items.map((item) => item.diagnostic.id).sort()).toEqual(["a", "b"]);
  });

  it("distinguishes two endpoint pairs even when they involve the same walls", () => {
    const report = summarizePlanDiagnostics({ ...emptySources(), connections: [
      nearEnd("a-start", "a", "b", "start", "end"),
      nearEnd("b-end", "b", "a", "end", "start"),
      nearEnd("a-end", "a", "b", "end", "start"),
      nearEnd("b-start", "b", "a", "start", "end"),
    ] });
    expect(report.total).toBe(2);
    expect(report.items.map((item) => item.diagnostic.id).sort()).toEqual(["a-end", "a-start"]);
  });

  it("does not collapse separate free ends or T-contact actions sharing the same point", () => {
    const connections: WallConnectionDiagnostic[] = [
      freeEnd("free-a", "a"), freeEnd("free-b", "b"),
      { id: "junction-a", kind: "junction", wallId: "c", endpoint: "start", point: { x: 0, y: 0 }, target: { wallId: "d", point: { x: 0, y: 0 } }, distance: 0 },
      { id: "junction-b", kind: "junction", wallId: "e", endpoint: "end", point: { x: 0, y: 0 }, target: { wallId: "d", point: { x: 0, y: 0 } }, distance: 0 },
      { id: "near-wall", kind: "near-wall", wallId: "f", endpoint: "end", point: { x: 0, y: 0 }, target: { wallId: "d", point: { x: 0, y: 0.1 } }, distance: 0.1 },
    ];
    expect(summarizePlanDiagnostics({ ...emptySources(), connections }).total).toBe(5);
  });

  it("does not merge a near-endpoint source lacking a target endpoint with another source", () => {
    const first: WallConnectionDiagnostic = {
      id: "first", kind: "near-endpoint", wallId: "a", endpoint: "end", point: { x: 0, y: 0 },
      target: { wallId: "b", point: { x: 0.1, y: 0 } }, distance: 0.1,
    };
    const second = { ...first, id: "second", wallId: "c" };
    expect(summarizePlanDiagnostics({ ...emptySources(), connections: [first, second] }).total).toBe(2);
  });

  it("deduplicates identical IDs independently within every category", () => {
    const sources = allSources();
    sources.connections = [...sources.connections, ...sources.connections];
    sources.intersections.intersections = [intersection, { ...intersection }];
    sources.overlaps.overlaps = [overlap, { ...overlap }];
    sources.doorWalls.collisions = [doorWall, { ...doorWall }];
    sources.doorPairs.collisions = [doorPair, { ...doorPair }];
    expect(summarizePlanDiagnostics(sources).counts).toEqual({
      connections: 1, intersections: 1, overlaps: 1, "door-wall": 1, "door-pair": 1,
    });
  });

  it("namespaces identical source IDs from different diagnostic kinds", () => {
    const sources: PlanDiagnosticSources = {
      connections: [freeEnd("same")],
      intersections: { intersections: [{ ...intersection, id: "same" }], truncated: false },
      overlaps: { overlaps: [{ ...overlap, id: "same" }], truncated: false },
      doorWalls: { collisions: [{ ...doorWall, id: "same" }], truncated: false },
      doorPairs: { collisions: [{ ...doorPair, id: "same" }], truncated: false },
    };
    const report = summarizePlanDiagnostics(sources);
    expect(new Set(report.items.map((item) => item.id)).size).toBe(5);
  });

  it("sorts each category by stable item ID independently of input order", () => {
    const sources: PlanDiagnosticSources = {
      connections: [freeEnd("z"), freeEnd("a"), nearEnd("near-z", "z", "b"), nearEnd("near-a", "a", "b")],
      intersections: { intersections: [{ ...intersection, id: "z" }, { ...intersection, id: "a" }], truncated: false },
      overlaps: { overlaps: [{ ...overlap, id: "z" }, { ...overlap, id: "a" }], truncated: false },
      doorWalls: { collisions: [{ ...doorWall, id: "z" }, { ...doorWall, id: "a" }], truncated: false },
      doorPairs: { collisions: [{ ...doorPair, id: "z" }, { ...doorPair, id: "a" }], truncated: false },
    };
    const reversed: PlanDiagnosticSources = {
      connections: [...sources.connections].reverse(),
      intersections: { ...sources.intersections, intersections: [...sources.intersections.intersections].reverse() },
      overlaps: { ...sources.overlaps, overlaps: [...sources.overlaps.overlaps].reverse() },
      doorWalls: { ...sources.doorWalls, collisions: [...sources.doorWalls.collisions].reverse() },
      doorPairs: { ...sources.doorPairs, collisions: [...sources.doorPairs.collisions].reverse() },
    };
    const report = summarizePlanDiagnostics(sources);
    expect(report).toEqual(summarizePlanDiagnostics(reversed));
    for (const kind of ["connections", "intersections", "overlaps", "door-wall", "door-pair"] as const) {
      const ids = report.items.filter((item) => item.kind === kind).map((item) => item.id);
      expect(ids).toEqual([...ids].sort());
    }
  });

  it.each(["intersections", "overlaps", "door-wall", "door-pair"] as const)("propagates the %s cap without inventing the full count", (kind) => {
    const sources = allSources();
    if (kind === "intersections") sources.intersections.truncated = true;
    if (kind === "overlaps") sources.overlaps.truncated = true;
    if (kind === "door-wall") sources.doorWalls.truncated = true;
    if (kind === "door-pair") sources.doorPairs.truncated = true;
    const report = summarizePlanDiagnostics(sources);
    expect(report.incomplete).toBe(true);
    expect(report.truncated[kind]).toBe(true);
    expect(report.truncated.connections).toBe(false);
    expect(report.total).toBe(5);
    expect(Object.values(report.counts).reduce((sum, count) => sum + count, 0)).toBe(5);
  });

  it("retains every independent cap flag and does not cap the returned free-end list", () => {
    const sources = allSources();
    sources.connections = Array.from({ length: 137 }, (_, index) => freeEnd(`end-${index}`));
    sources.intersections.truncated = sources.overlaps.truncated = sources.doorWalls.truncated = sources.doorPairs.truncated = true;
    const report = summarizePlanDiagnostics(sources);
    expect(report.counts.connections).toBe(137);
    expect(report.total).toBe(141);
    expect(report.truncated).toEqual({
      connections: false, intersections: true, overlaps: true, "door-wall": true, "door-pair": true,
    });
  });

  it("reflects an explicit cap even with no supplied rows instead of claiming a complete empty result", () => {
    const sources = emptySources();
    sources.doorPairs.truncated = true;
    expect(summarizePlanDiagnostics(sources)).toMatchObject({ total: 0, incomplete: true, truncated: { "door-pair": true } });
  });

  it("summarizes a real closed wall plan without modifying model v5 or adding persisted diagnostics", () => {
    const points = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }];
    const walls: Wall[] = points.map((start, index) => ({ id: `wall-${index}`, start, end: points[(index + 1) % points.length], thickness: 0.2, height: 2.7 }));
    const plan = { ...createEmptyPlan("closed-plan"), walls };
    const before = JSON.stringify(plan);
    const report = summarizePlanDiagnostics({
      connections: analyzeWallConnections(plan.walls),
      intersections: analyzeWallIntersections(plan.walls),
      overlaps: analyzeWallOverlaps(plan.walls),
      doorWalls: analyzeDoorWallCollisions(plan.walls, plan.openings),
      doorPairs: analyzeDoorPairCollisions(plan.walls, plan.openings),
    });
    expect(report.total).toBe(0);
    expect(report.incomplete).toBe(false);
    expect(JSON.stringify(plan)).toBe(before);
    expect(plan.schemaVersion).toBe(11);
    expect(Object.keys(plan)).not.toContain("diagnostics");
  });

  it("combines the two directional rows of a real small wall-end gap only once", () => {
    const walls: Wall[] = [
      { id: "a", start: { x: -2, y: 0 }, end: { x: 0, y: 0 }, thickness: 0.2, height: 2.7 },
      { id: "b", start: { x: 0.1, y: 0 }, end: { x: 2, y: 0 }, thickness: 0.2, height: 2.7 },
    ];
    const connections = analyzeWallConnections(walls);
    expect(connections.filter((item) => item.kind === "near-endpoint")).toHaveLength(2);
    expect(connections).toHaveLength(4);
    const report = summarizePlanDiagnostics({ ...emptySources(), connections });
    expect(report.counts.connections).toBe(3);
    expect(report.items.filter((item) => item.kind === "connections" && item.diagnostic.kind === "near-endpoint")).toHaveLength(1);
  });

  it("accepts deeply frozen source arrays and returns fresh report containers", () => {
    const sources = freezeDeep(allSources());
    const before = JSON.stringify(sources);
    const first = summarizePlanDiagnostics(sources);
    const second = summarizePlanDiagnostics(sources);
    expect(first).toEqual(second);
    expect(first.items).not.toBe(second.items);
    expect(first.counts).not.toBe(second.counts);
    expect(first.truncated).not.toBe(second.truncated);
    first.items.pop();
    first.counts.connections = 99;
    expect(JSON.stringify(sources)).toBe(before);
    expect(second.total).toBe(5);
    expect(second.counts.connections).toBe(1);
  });
});
