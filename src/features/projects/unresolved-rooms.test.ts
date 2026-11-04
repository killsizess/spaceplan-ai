import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import { checkPlanIntegrity } from "@/domain/floor-plan/plan-integrity";
import { floorPlanLoadSchema, floorPlanSchema } from "@/domain/floor-plan/schema";
import { spatialBounds } from "@/domain/floor-plan/spatial";
import type { FloorPlan, Wall } from "@/domain/floor-plan/types";
import { editorReducer, initialEditorState } from "@/features/editor/editor-state";
import { detectViewRooms } from "@/features/editor/view-rooms";
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

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 3,
});

/** An 11 × 11 grid of 2 m cells: 121 rooms, more than the 100 the editor can derive. */
function grid(): FloorPlan {
  const walls: Wall[] = [];
  for (let line = 0; line <= 11; line++) {
    walls.push(wall(`h${line}`, 0, line * 2, 22, line * 2));
    walls.push(wall(`v${line}`, line * 2, 0, line * 2, 22));
  }
  return { ...createEmptyPlan("grid"), name: "Сетка", roomMode: "walls", walls };
}

describe("a project whose rooms cannot be computed", () => {
  it("is refused by the editing schema but opened by the loading schema, unchanged", () => {
    const plan = grid();
    const strict = floorPlanSchema.safeParse(plan);
    expect(strict.success).toBe(false);
    expect(strict.error?.issues[0].message).toMatch(/больше 100 помещений/);
    const loaded = floorPlanLoadSchema.safeParse(plan);
    expect(loaded.success).toBe(true);
    expect(loaded.data).toEqual(plan);
  });

  it("still enforces every other rule when loading", () => {
    const broken = { ...grid(), walls: [...grid().walls, wall("zero", 1, 1, 1, 1)] };
    expect(floorPlanLoadSchema.safeParse(broken).success).toBe(false);
    const orphan = { ...grid(), openings: [{ id: "o", wallId: "missing", kind: "door", offset: 0, width: 1, height: 2, sillHeight: 0 }] };
    expect(floorPlanLoadSchema.safeParse(orphan).success).toBe(false);
  });

  it("opens from an imported file, from storage and into an export, with nothing lost", () => {
    const plan = grid();
    const text = JSON.stringify(plan);
    expect(parsePlanFile(text)).toEqual(plan);
    const storage = new MemoryStorage();
    const key = PROJECT_PREFIX + plan.id;
    const raw = JSON.stringify({ storageVersion: 1, revision: "r1", updatedAt: now, plan });
    storage.setItem(key, raw);
    expect(listProjects(storage).unreadableCount).toBe(0);
    expect(listProjects(storage).projects).toHaveLength(1);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
    expect(storage.getItem(key)).toBe(raw);
    expect(parsePlanFile(serializePlan(plan))).toEqual(plan);
    saveProject(storage, plan, "r1", "r2", now);
    expect(readProject(storage, plan.id)!.plan.walls).toHaveLength(24);
  });

  it("is explained to the user: the reason is reported and no room is shown", () => {
    const plan = grid();
    const detection = detectViewRooms(plan);
    expect(detection.rooms).toEqual([]);
    expect(detection.unresolved).toMatch(/больше 100 помещений/);
    expect(detection.warnings).toEqual([detection.unresolved]);
    const report = checkPlanIntegrity(plan);
    expect(report.valid).toBe(false);
    expect(report.issues.map((item) => item.code)).toEqual(["wall-rooms.unresolved"]);
    expect(detectViewRooms({ ...plan, roomMode: "manual" }).unresolved).toBeUndefined();
  });

  it("does not break the 3D bounds or deleting a wall", () => {
    const plan = grid();
    expect(() => spatialBounds(plan)).not.toThrow();
    expect(spatialBounds(plan).minY).toBe(0);
    const state = initialEditorState(plan);
    const deleted = editorReducer(state, { type: "delete", id: "h0" });
    expect(deleted.error).toBeNull();
    expect(deleted.plan.walls).toHaveLength(23);
  });

  it("keeps saved room labels exactly as they were while rooms are not computable", () => {
    const label = { id: "label", name: "Зал", kind: "living" as const, color: "#aabbcc", anchor: { x: 1, y: 1 }, boundaryWallIds: ["h0", "h1", "v0", "v1"] };
    const plan = { ...grid(), wallRoomLabels: [label] };
    const state = initialEditorState(plan);
    const next = editorReducer(state, { type: "delete", id: "h5" });
    expect(next.error).toBeNull();
    expect(next.plan.wallRoomLabels).toEqual([label]);
  });

  it("rejects an edit that leaves the rooms uncomputable, with the reason, and changes nothing", () => {
    const state = initialEditorState(grid());
    const target = state.plan.walls[0];
    const refused = editorReducer(state, { type: "wall:update", wall: { ...target, thickness: 0.25 }, connectEndpoints: false });
    expect(refused.error).toMatch(/больше 100 помещений/);
    expect(refused.plan).toBe(state.plan);
    expect(refused.past).toHaveLength(0);
  });

  it("accepts the edits that fix it, and the notice goes away", () => {
    let state = initialEditorState(grid());
    for (const id of ["h11", "v11"]) state = editorReducer(state, { type: "delete", id });
    expect(state.error).toBeNull();
    expect(detectViewRooms(state.plan).unresolved).toBeUndefined();
    expect(detectViewRooms(state.plan).rooms).toHaveLength(100);
    const undone = editorReducer(editorReducer(state, { type: "undo" }), { type: "undo" });
    expect(undone.plan.walls).toHaveLength(24);
    expect(detectViewRooms(undone.plan).unresolved).toMatch(/больше 100 помещений/);
  });

  it("can switch to manual rooms without touching walls", () => {
    const state = initialEditorState(grid());
    const manual = editorReducer(state, { type: "roomMode:set", mode: "manual" });
    expect(manual.error).toBeNull();
    expect(manual.plan.roomMode).toBe("manual");
    expect(manual.plan.walls).toEqual(state.plan.walls);
  });
});
