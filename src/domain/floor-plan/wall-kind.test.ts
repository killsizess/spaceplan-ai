import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "./operations";
import { bearingWallsRequirement, evaluateRequirements } from "./plan-requirements";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Wall } from "./types";
import { bearingAmong, bearingWallIds, wallKindOf, withWallKind } from "./wall-kind";

function wall(id: string, x1: number, y1: number, x2: number, y2: number, kind?: Wall["kind"]): Wall {
  return { id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 3, ...(kind ? { kind } : {}) };
}

function plan(): FloorPlan {
  return {
    ...createEmptyPlan("kinds"),
    roomMode: "manual",
    walls: [wall("a", 0, 0, 4, 0, "bearing"), wall("b", 4, 0, 4, 3, "partition"), wall("c", 4, 3, 0, 3), wall("d", 0, 3, 0, 0, "bearing")],
  };
}

const check = (value: FloorPlan, requirement: FloorPlan["requirements"][number]) =>
  evaluateRequirements({ ...value, requirements: [requirement] }, [], null)[0];

describe("wall type", () => {
  it("treats an absent type as unknown and never guesses one", () => {
    const value = plan();
    expect(value.walls.map(wallKindOf)).toEqual(["bearing", "partition", "unknown", "bearing"]);
    expect(wallKindOf(wall("x", 0, 0, 1, 0))).toBe("unknown");
    expect(bearingWallIds(value)).toEqual(["a", "d"]);
    expect(bearingAmong(value, ["b", "d"]).map((item) => item.id)).toEqual(["d"]);
  });

  it("sets and clears the type without leaving a field for unknown", () => {
    const base = wall("a", 0, 0, 4, 0);
    expect(withWallKind(base, "bearing")).toEqual({ ...base, kind: "bearing" });
    expect("kind" in withWallKind({ ...base, kind: "bearing" }, "unknown")).toBe(false);
    expect(withWallKind({ ...base, kind: "bearing" }, "unknown")).toEqual(base);
    expect(withWallKind({ ...base, kind: "bearing" }, "partition").kind).toBe("partition");
  });

  it("is accepted by the schema in every form and rejected otherwise", () => {
    expect(floorPlanSchema.safeParse(plan()).success).toBe(true);
    const wrong = { ...plan(), walls: [{ ...plan().walls[0], kind: "wall" }] };
    expect(floorPlanSchema.safeParse(wrong).success).toBe(false);
  });
});

describe("requirement: bearing walls kept", () => {
  it("snapshots only the bearing walls and refuses an empty snapshot", () => {
    const requirement = bearingWallsRequirement(plan().walls, "req");
    expect(requirement.walls.map((item) => item.wallId)).toEqual(["a", "d"]);
    expect(requirement.walls[0]).toEqual({ wallId: "a", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2 });
    expect(() => bearingWallsRequirement([wall("x", 0, 0, 1, 0), wall("y", 1, 0, 1, 1, "partition")], "r")).toThrow(/Нет несущих стен/);
  });

  it("is met while the walls keep axis, thickness and mark; direction does not matter", () => {
    const value = plan();
    const requirement = bearingWallsRequirement(value.walls, "req");
    expect(check(value, requirement).status).toBe("met");
    const reversed = { ...value, walls: value.walls.map((item) => item.id === "a" ? { ...item, start: item.end, end: item.start } : item) };
    expect(check(reversed, requirement).status).toBe("met");
  });

  it.each([
    ["deleted", (value: FloorPlan) => ({ ...value, walls: value.walls.filter((item) => item.id !== "a") })],
    ["moved", (value: FloorPlan) => ({ ...value, walls: value.walls.map((item) => item.id === "a" ? { ...item, end: { x: 5, y: 0 } } : item) })],
    ["thickness", (value: FloorPlan) => ({ ...value, walls: value.walls.map((item) => item.id === "a" ? { ...item, thickness: 0.3 } : item) })],
    ["unmarked", (value: FloorPlan) => ({ ...value, walls: value.walls.map((item) => item.id === "a" ? withWallKind(item, "partition") : item) })],
  ] as const)("is violated when a bearing wall is %s, and names the wall", (change, edit) => {
    const value = plan();
    const requirement = bearingWallsRequirement(value.walls, "req");
    const result = check(edit(value), requirement);
    expect(result.status).toBe("violated");
    const broken = result.findings.filter((finding) => finding.violates);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ wallId: "a", change });
    expect(result.findings.find((finding) => finding.wallId === "d")?.violates).toBe(false);
  });

  it("ignores walls marked bearing after the requirement was added", () => {
    const value = plan();
    const requirement = bearingWallsRequirement(value.walls, "req");
    const later = { ...value, walls: value.walls.map((item) => item.id === "c" ? withWallKind(item, "bearing") : item) };
    expect(check(later, requirement).findings).toHaveLength(2);
    expect(check(later, requirement).status).toBe("met");
  });

  it("is valid in the schema, stays out of room-level checks and rejects duplicates or an empty list", () => {
    const value = plan();
    const requirement = bearingWallsRequirement(value.walls, "req");
    expect(floorPlanSchema.safeParse({ ...value, requirements: [requirement] }).success).toBe(true);
    expect(floorPlanSchema.safeParse({ ...value, requirements: [{ ...requirement, walls: [] }] }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...value, requirements: [{ ...requirement, walls: [requirement.walls[0], requirement.walls[0]] }] }).success).toBe(false);
  });
});
