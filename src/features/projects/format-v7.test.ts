import { describe, expect, it } from "vitest";
import { createEmptyPlan, createExamplePlan } from "@/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "@/domain/floor-plan/types";
import {
  listProjects,
  parsePlanFile,
  PROJECT_PREFIX,
  readProject,
  saveProject,
  serializePlan,
} from "./project-repository";
import { MemoryStorage } from "./project-test-helpers";

const now = "2026-11-04T00:00:00.000Z";

function wall(id: string, x1: number, y1: number, x2: number, y2: number, kind?: Wall["kind"]): Wall {
  return { id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 3, ...(kind ? { kind } : {}) };
}

/** A plan exactly as format 6 wrote it: no wall type, no origin. */
function versionSixPlan() {
  const plan: FloorPlan = {
    ...createEmptyPlan("six"),
    walls: [wall("a", 0, 0, 4, 0), wall("b", 4, 0, 4, 3)],
    openings: [{ id: "door", wallId: "a", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0 }],
  };
  return { ...plan, schemaVersion: 6 };
}

describe("format 7", () => {
  it("opens a version 6 file as version 7 without changing any data", () => {
    const old = versionSixPlan();
    const opened = parsePlanFile(JSON.stringify(old));
    expect(opened.schemaVersion).toBe(7);
    expect(opened).toEqual({ ...old, schemaVersion: 7 });
    expect(opened.walls.every((item) => !("kind" in item))).toBe(true);
    expect(opened).not.toHaveProperty("origin");
  });

  it("reads a stored version 6 record without writing it and upgrades on the next save", () => {
    const old = versionSixPlan();
    const storage = new MemoryStorage();
    const key = PROJECT_PREFIX + old.id;
    const raw = JSON.stringify({ storageVersion: 1, revision: "r1", updatedAt: now, plan: old });
    storage.setItem(key, raw);
    const read = readProject(storage, old.id)!;
    expect(read.plan.schemaVersion).toBe(7);
    expect(listProjects(storage).unreadableCount).toBe(0);
    expect(storage.getItem(key)).toBe(raw);
    saveProject(storage, read.plan, "r1", "r2", now);
    expect(JSON.parse(storage.getItem(key)!).plan.schemaVersion).toBe(7);
  });

  it("does not bless data that format 6 never had", () => {
    const old = versionSixPlan();
    const withKind = { ...old, walls: [{ ...old.walls[0], kind: "bearing" }, old.walls[1]] };
    expect(() => parsePlanFile(JSON.stringify(withKind))).toThrow();
    const origin = {
      planId: "src", planName: "Источник", createdAt: now,
      snapshot: { roomMode: "manual", rooms: [], walls: [], openings: [], wallRoomLabels: [], requirements: [] },
    };
    expect(() => parsePlanFile(JSON.stringify({ ...old, origin }))).toThrow();
    const requirement = {
      id: "r", type: "bearing-walls-kept",
      walls: [{ wallId: "a", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2 }],
    };
    expect(() => parsePlanFile(JSON.stringify({ ...old, requirements: [requirement] }))).toThrow();
  });

  it("keeps wall types through export, import and storage", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("typed"),
      walls: [wall("a", 0, 0, 4, 0, "bearing"), wall("b", 4, 0, 4, 3, "partition"), wall("c", 4, 3, 0, 3)],
    };
    const copy = parsePlanFile(serializePlan(plan));
    expect(copy).toEqual(plan);
    expect(copy.walls.map((item) => item.kind)).toEqual(["bearing", "partition", undefined]);
    const storage = new MemoryStorage();
    saveProject(storage, plan, null, "r1", now);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
  });

  it("rejects a wall type that is not one of the three", () => {
    const plan = { ...createEmptyPlan("bad"), walls: [wall("a", 0, 0, 4, 0)] };
    const broken = { ...plan, walls: [{ ...plan.walls[0], kind: "load-bearing" }] };
    expect(() => parsePlanFile(JSON.stringify(broken))).toThrow();
    expect(() => parsePlanFile(JSON.stringify({ ...plan, walls: [{ ...plan.walls[0], kind: null }] }))).toThrow();
  });

  it("refuses version 8 and still opens the example plan", () => {
    expect(() => parsePlanFile(JSON.stringify({ ...createExamplePlan(), schemaVersion: 8 }))).toThrow(/от 1 до 7/);
    expect(parsePlanFile(serializePlan(createExamplePlan())).schemaVersion).toBe(7);
  });
});
