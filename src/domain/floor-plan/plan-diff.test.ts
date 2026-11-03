import { describe, expect, it } from "vitest";
import { addWall, addOpening, deleteObject } from "./construction";
import { createSpatialExamplePlan } from "./examples";
import { moveWall } from "./move-wall";
import { createExamplePlan } from "./operations";
import { diffPlans, planMetrics } from "./plan-diff";
import { addRequirement } from "./plan-requirements";
import type { FloorPlan, RoomKind } from "./types";
import { reconcileWallRoomLabels, setWallRoomLabel } from "./wall-room-labels";
import { detectWallRooms } from "./wall-rooms";

function apartment(): FloorPlan {
  let plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
  const kinds: [RoomKind, (x: number, y: number) => boolean][] = [
    ["living", (x, y) => x < 5 && y < 4], ["kitchen", (x, y) => x > 5 && x < 8 && y < 4],
    ["hall", (x, y) => x > 8 && y < 5], ["bathroom", (x, y) => x > 8 && y > 5],
    ["bedroom", (x, y) => x < 4 && y > 4], ["other", (x, y) => x > 4 && x < 8 && y > 4],
  ];
  for (const room of detectWallRooms(plan.walls).rooms) {
    const [kind] = kinds.find(([, test]) => test(room.labelPoint.x, room.labelPoint.y))!;
    plan = setWallRoomLabel(plan, room, { name: kind, kind, color: "#dddddd" }, `label-${kind}`);
  }
  return plan;
}

describe("plan comparison", () => {
  it("finds no difference between a plan and its renamed copy", () => {
    const plan = apartment();
    const copy = { ...structuredClone(plan), id: "variant", name: "Вариант" };
    const diff = diffPlans(plan, copy);
    expect(diff.identical).toBe(true);
    expect(diff.walls).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.movedOpenings).toEqual([]);
    expect(diff.changedWallLength).toBe(0);
    expect(diff.after).toEqual(diff.before);
    // 80 m² by the axes; 73.42 m² of floor inside the walls in six rooms.
    expect(diff.before.totalArea).toBeCloseTo(73.42, 2);
    expect(diff.before.roomCount).toBe(6);
    expect(diff.before).toMatchObject({ wallCount: 9, doorCount: 7, windowCount: 5, roomsComputed: true });
  });

  it("describes a moved partition: changed walls, carried doors, wall work and areas", () => {
    const base = apartment();
    // As in the editor: the move and the label rebinding form one transaction.
    const variant = reconcileWallRoomLabels(base, moveWall(base, "partition-v8", { x: 0.3, y: 0 }));
    const diff = diffPlans(base, variant);
    expect(diff.identical).toBe(false);
    // The partition and the two walls resting on it changed.
    expect(diff.walls).toEqual({ added: [], removed: [], changed: ["partition-v8", "partition-h4", "partition-h5"] });
    expect(diff.openings.changed).toEqual([]);
    expect(diff.movedOpenings).toEqual(["door-kitchen-hall", "door-bathroom"]);
    // Labels were rebound to the new geometry, but nobody renamed or recoloured a room.
    expect(variant.wallRoomLabels).not.toEqual(base.wallRoomLabels);
    expect(diff.wallRoomLabels).toEqual({ added: [], removed: [], changed: [] });
    const renamed = { ...variant, wallRoomLabels: variant.wallRoomLabels.map((label) => label.kind === "kitchen" ? { ...label, name: "Кухня-гостиная" } : label) };
    expect(diffPlans(base, renamed).wallRoomLabels.changed).toEqual(["label-kitchen"]);
    // 8 m partition, partition-h4 grown to 8.3 m, partition-h5 shortened from 2 m.
    expect(diff.changedWallLength).toBeCloseTo(8 + 8.3 + 2, 9);
    expect(diff.after.areaByKind.kitchen - diff.before.areaByKind.kitchen).toBeCloseTo(0.3 * 3.84, 9);
    expect(diff.after.totalArea).toBeCloseTo(diff.before.totalArea, 9);
    expect(diff.after.roomCount).toBe(6);
  });

  it("is symmetric and reports added and removed objects, requirements and labels", () => {
    const base = apartment();
    let variant = addWall(base, { id: "new-wall", start: { x: 1, y: 1 }, end: { x: 3, y: 1 }, thickness: 0.1, height: 2.7 });
    variant = addOpening(variant, { id: "new-window", wallId: "outer-top", kind: "window", offset: 3.5, width: 1, height: 1.2, sillHeight: 0.9 });
    variant = deleteObject(variant, "partition-v4");
    variant = addRequirement(variant, { id: "req", type: "room-min-area", kind: "kitchen", minArea: 10 });
    const forward = diffPlans(base, variant);
    expect(forward.walls).toEqual({ added: ["new-wall"], removed: ["partition-v4"], changed: [] });
    expect(forward.openings).toEqual({ added: ["new-window"], removed: ["door-study-bedroom"], changed: [] });
    expect(forward.requirements.added).toEqual(["req"]);
    expect(forward.changedWallLength).toBeCloseTo(2 + 4, 9);
    // Removing the bedroom-study partition merges two rooms into one.
    expect(forward.after.roomCount).toBe(5);
    const backward = diffPlans(variant, base);
    expect(backward.walls).toEqual({ added: forward.walls.removed, removed: forward.walls.added, changed: [] });
    expect(backward.openings.added).toEqual(forward.openings.removed);
    expect(backward.requirements.removed).toEqual(["req"]);
    expect(backward.before).toEqual(forward.after);
    expect(backward.after).toEqual(forward.before);
    expect(backward.changedWallLength).toBeCloseTo(forward.changedWallLength, 12);
    expect(diffPlans(base, { ...base, wallRoomLabels: [] }).wallRoomLabels.removed).toHaveLength(6);
  });

  it("measures manual rectangles in manual mode and never throws on uncomputable rooms", () => {
    const manual = planMetrics(createExamplePlan());
    expect(manual).toMatchObject({ roomMode: "manual", totalArea: 80, roomCount: 6, wallCount: 0 });
    expect(manual.areaByKind.living).toBe(20);
    const broken = planMetrics({ ...apartment(), walls: [] , openings: [] });
    expect(broken).toMatchObject({ roomsComputed: true, roomCount: 0, totalArea: 0 });
  });
});
