import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { connectWallEndpoints } from "./connect-wall-endpoints";
import { createEmptyPlan } from "./operations";
import type { FloorPlan, Wall } from "./types";
import { analyzeWallConnections, type WallConnectionDiagnostic } from "./wall-diagnostics";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 3 };
}

function gapPlan(): FloorPlan {
  return {
    ...createEmptyPlan("join"),
    walls: [
      wall("source", { x: 0, y: 0 }, { x: 2, y: 0 }),
      wall("target", { x: 2.1, y: 0 }, { x: 4, y: 0 }),
    ],
  };
}

function snapshot(plan: FloorPlan, wallId = "source", endpoint = "end") {
  const diagnostic = analyzeWallConnections(plan.walls).find((item) =>
    item.wallId === wallId && item.endpoint === endpoint,
  );
  if (!diagnostic) throw new Error("Fixture must have a free endpoint.");
  return diagnostic;
}

describe("explicit endpoint connection", () => {
  it("moves only the selected free endpoint to the exact target, preserving IDs and other geometry", () => {
    const plan = gapPlan();
    const before = structuredClone(plan);
    const diagnostic = snapshot(plan);
    const result = connectWallEndpoints(plan, diagnostic);
    expect(result).not.toBe(plan);
    expect(result.walls[0]).toEqual({ ...plan.walls[0], end: { x: 2.1, y: 0 } });
    expect(result.walls[1]).toEqual(plan.walls[1]);
    expect(result.schemaVersion).toBe(6);
    expect(result.rooms).toEqual(plan.rooms);
    expect(result.openings).toEqual(plan.openings);
    expect(plan).toEqual(before);
    expect(snapshot(plan)).toEqual(diagnostic);
    expect(analyzeWallConnections(result.walls).filter((item) => item.kind === "near-endpoint"))
      .toEqual([]);
  });

  it("supports a reversed source and target orientation", () => {
    const plan = gapPlan();
    plan.walls = plan.walls.map((item) => ({ ...item, start: item.end, end: item.start }));
    const result = connectWallEndpoints(plan, snapshot(plan, "source", "start"));
    expect(result.walls[0].start).toEqual(plan.walls[1].end);
    expect(result.walls[0].end).toEqual(plan.walls[0].end);
    expect(result.walls[1]).toEqual(plan.walls[1]);
  });

  it("can join in the opposite direction while keeping the chosen target fixed", () => {
    const plan = gapPlan();
    const result = connectWallEndpoints(plan, snapshot(plan, "target", "start"));
    expect(result.walls[1].start).toEqual(plan.walls[0].end);
    expect(result.walls[1].end).toEqual(plan.walls[1].end);
    expect(result.walls[0]).toEqual(plan.walls[0]);
  });

  it("joins an existing multi-wall corner without moving any of its walls", () => {
    const plan = gapPlan();
    plan.walls.push(wall("corner", { x: 2.1, y: -2 }, { x: 2.1, y: 0 }));
    const diagnostic = snapshot(plan);
    const result = connectWallEndpoints(plan, diagnostic);
    expect(result.walls[0].end).toEqual({ x: 2.1, y: 0 });
    expect(result.walls.slice(1)).toEqual(plan.walls.slice(1));
  });

  it("accepts the inclusive 0.3 m boundary and leaves submillimeter precision intact", () => {
    const plan = gapPlan();
    plan.walls[0] = wall("source", { x: -2, y: 0 }, { x: 0, y: 0 });
    plan.walls[1] = wall("target", { x: 0.3, y: 0 }, { x: 2, y: 0 });
    expect(connectWallEndpoints(plan, snapshot(plan)).walls[0].end).toEqual({ x: 0.3, y: 0 });
    plan.walls[1] = wall("target", { x: 0.123456789, y: 0 }, { x: 2, y: 0 });
    expect(connectWallEndpoints(plan, snapshot(plan)).walls[0].end.x).toBe(0.123456789);
  });

  it("uses the live target coordinate when an insignificant snapshot drift is within node tolerance", () => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    const changed = {
      ...plan,
      walls: plan.walls.map((item) => item.id === "target"
        ? { ...item, start: { x: item.start.x + 0.5e-9, y: 0 } } : item),
    };
    const result = connectWallEndpoints(changed, diagnostic);
    expect(result.walls[0].end).toEqual(changed.walls[1].start);
  });

  it("rolls back a wall shrink when an existing opening would no longer fit", () => {
    const plan = gapPlan();
    plan.walls[1] = wall("target", { x: 1.8, y: 0 }, { x: 1.8, y: -3 });
    plan.openings = [{
      id: "door", wallId: "source", kind: "door", offset: 1.2, width: 0.7,
      height: 2.1, sillHeight: 0,
    }];
    const before = structuredClone(plan);
    expect(() => connectWallEndpoints(plan, snapshot(plan))).toThrow(/Проём выходит за границы/);
    expect(plan).toEqual(before);
  });

  it("rejects a connection that would collapse the source onto its other endpoint", () => {
    const plan = gapPlan();
    plan.walls = [
      wall("source", { x: 0, y: 0 }, { x: 0.2, y: 0 }),
      wall("target", { x: 0, y: 0 }, { x: -2, y: 0 }),
    ];
    const before = structuredClone(plan);
    expect(() => connectWallEndpoints(plan, snapshot(plan))).toThrow(/ненулевую/);
    expect(plan).toEqual(before);
  });

  it.each(["source", "target"])("rejects a stale moved %s coordinate", (wallId) => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    const changed = {
      ...plan,
      walls: plan.walls.map((item) => item.id !== wallId ? item : {
        ...item,
        ...(wallId === "source" ? { end: { x: 1.99, y: 0 } } : { start: { x: 2.11, y: 0 } }),
      }),
    };
    expect(() => connectWallEndpoints(changed, diagnostic)).toThrow(/изменилось/);
  });

  it.each(["source", "target"])("rejects a stale deleted %s wall", (wallId) => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    expect(() => connectWallEndpoints({
      ...plan, walls: plan.walls.filter((item) => item.id !== wallId),
    }, diagnostic)).toThrow(/изменилось/);
  });

  it("rechecks the nearest candidate after another endpoint is added", () => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    const changed = {
      ...plan,
      walls: [...plan.walls, wall("closer", { x: 2.05, y: 0 }, { x: 2.05, y: -2 })],
    };
    expect(() => connectWallEndpoints(changed, diagnostic)).toThrow(/изменилось/);
  });

  it("rejects a source that has already become connected and rejects replay after success", () => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    const joined = connectWallEndpoints(plan, diagnostic);
    expect(() => connectWallEndpoints(joined, diagnostic)).toThrow(/изменилось/);
    const changed = {
      ...plan,
      walls: [...plan.walls, wall("new-connection", { x: 2, y: 0 }, { x: 2, y: -2 })],
    };
    expect(() => connectWallEndpoints(changed, diagnostic)).toThrow(/изменилось/);
  });

  it("rejects targets beyond 0.3 m even when supplied with a fabricated nearby diagnostic", () => {
    const plan = gapPlan();
    plan.walls[1] = wall("target", { x: 2.31, y: 0 }, { x: 4, y: 0 });
    const fabricated: WallConnectionDiagnostic = {
      id: "wall-diagnostic:source:end", wallId: "source", endpoint: "end",
      point: { x: 2, y: 0 }, kind: "near-endpoint", distance: 0.1,
      target: { wallId: "target", endpoint: "start", point: { x: 2.31, y: 0 } },
    };
    expect(() => connectWallEndpoints(plan, fabricated)).toThrow(/изменилось/);
  });

  it("rejects T-contacts, near-wall projections and open ends instead of splitting walls", () => {
    const plan = gapPlan();
    plan.walls = [
      wall("source", { x: 2, y: 0 }, { x: 2, y: 2 }),
      wall("target", { x: 0, y: 0 }, { x: 4, y: 0 }),
    ];
    expect(() => connectWallEndpoints(plan, snapshot(plan, "source", "start")))
      .toThrow(/только два близких конца/);
    const nearby = { ...plan, walls: [{ ...plan.walls[0], start: { x: 2, y: 0.1 } }, plan.walls[1]] };
    expect(() => connectWallEndpoints(nearby, snapshot(nearby, "source", "start")))
      .toThrow(/только два близких конца/);
    expect(() => connectWallEndpoints(plan, snapshot(plan, "source", "end")))
      .toThrow(/только два близких конца/);
    expect(plan.walls).toHaveLength(2);
  });

  it("rejects invalid snapshot points, distance and same-wall targets", () => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    if (diagnostic.kind !== "near-endpoint") throw new Error("Expected nearby end.");
    for (const point of [{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 1001, y: 0 }]) {
      expect(() => connectWallEndpoints(plan, { ...diagnostic, point })).toThrow(/Координаты/);
      expect(() => connectWallEndpoints(plan, {
        ...diagnostic, target: { ...diagnostic.target, point },
      })).toThrow(/Координаты/);
    }
    for (const distance of [NaN, Infinity, -1, 0.31]) {
      expect(() => connectWallEndpoints(plan, { ...diagnostic, distance })).toThrow(/Некорректное/);
    }
    expect(() => connectWallEndpoints(plan, {
      ...diagnostic, target: { ...diagnostic.target, wallId: "source" },
    })).toThrow(/Некорректное/);
    expect(() => connectWallEndpoints(plan, {
      ...diagnostic, target: { wallId: "target", point: diagnostic.target.point },
    })).toThrow(/только два близких конца/);
  });

  it("rejects invalid live source geometry and duplicate wall IDs", () => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    const invalid = { ...plan, walls: [{ ...plan.walls[0], start: { x: NaN, y: 0 } }, plan.walls[1]] };
    expect(() => connectWallEndpoints(invalid, diagnostic)).toThrow(/Координаты/);
    expect(() => connectWallEndpoints({ ...plan, walls: [...plan.walls, plan.walls[0]] }, diagnostic))
      .toThrow(/уникальными/);
  });

  it("accepts a frozen plan and diagnostic without mutating any source values", () => {
    const plan = gapPlan();
    const diagnostic = snapshot(plan);
    if (diagnostic.kind !== "near-endpoint") throw new Error("Expected nearby end.");
    const before = structuredClone(plan);
    for (const item of plan.walls) {
      Object.freeze(item.start);
      Object.freeze(item.end);
      Object.freeze(item);
    }
    Object.freeze(plan.walls);
    Object.freeze(plan.rooms);
    Object.freeze(plan.openings);
    Object.freeze(plan);
    Object.freeze(diagnostic.point);
    Object.freeze(diagnostic.target.point);
    Object.freeze(diagnostic.target);
    Object.freeze(diagnostic);
    expect(connectWallEndpoints(plan, diagnostic).walls[0].end).toEqual({ x: 2.1, y: 0 });
    expect(plan).toEqual(before);
  });
});
