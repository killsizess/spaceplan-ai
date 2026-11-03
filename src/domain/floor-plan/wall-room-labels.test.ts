import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "./operations";
import { floorPlanSchema } from "./schema";
import { addRectangularWallRoom, resizeRectangularWallRoom } from "./rectangular-wall-room";
import { detectWallRooms, wallRoomKey } from "./wall-rooms";
import { connectWallJunction } from "./connect-wall-junction";
import { analyzeWallConnections } from "./wall-diagnostics";
import type { FloorPlan, Wall, WallRoomLabel } from "./types";
import {
  assignWallRoomLabel, reconcileWallRoomLabels, removeWallRoomLabel,
  resolveWallRoomLabels, setWallRoomLabel,
} from "./wall-room-labels";

const values = { name: "Спальня", kind: "bedroom" as const, color: "#aabbcc" };
function rectangle(x = 0, y = 0, width = 5, depth = 4, prefix = "wall"): Wall[] {
  const points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }];
  return points.map((start, index) => ({ id: `${prefix}-${index}`, start, end: points[(index + 1) % 4], thickness: 0.2, height: 3 }));
}
function planWith(walls = rectangle()): FloorPlan {
  return { ...createEmptyPlan("labels"), roomMode: "walls", walls };
}
function labelled(plan = planWith(), roomIndex = 0, id = "bedroom"): FloorPlan {
  return setWallRoomLabel(plan, detectWallRooms(plan.walls).rooms[roomIndex], values, id);
}
const attributes = (plan: FloorPlan) => resolveWallRoomLabels(plan).rooms.map((room) => [room.name, room.kind, room.color, room.labelId]);
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("persistent wall room labels", () => {
  it("preserves default names, geometry and detection warnings when no attributes are saved", () => {
    for (const plan of [planWith(), planWith([])]) {
      const detected = detectWallRooms(plan.walls);
      expect(resolveWallRoomLabels(plan)).toEqual({
        rooms: detected.rooms.map((room) => ({ ...room, kind: "other" })),
        warnings: detected.warnings,
        unassigned: [],
      });
    }
  });

  it("stores only attributes, an interior anchor and actual supporting wall IDs", () => {
    const original = planWith();
    const room = detectWallRooms(original.walls).rooms[0];
    const plan = setWallRoomLabel(original, { ...room, id: "remapped:view-id", name: "View" }, { ...values, name: "  Спальня  " }, "bedroom");
    expect(plan.wallRoomLabels).toEqual([{ id: "bedroom", ...values, anchor: room.labelPoint, boundaryWallIds: ["wall-0", "wall-1", "wall-2", "wall-3"] }]);
    expect(attributes(plan)).toEqual([["Спальня", "bedroom", "#aabbcc", "bedroom"]]);
    expect(resolveWallRoomLabels(plan).rooms[0].area).toBeCloseTo(18.24);
    expect(original.wallRoomLabels).toEqual([]);
    expect(floorPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(Object.keys(plan.wallRoomLabels[0]).sort()).toEqual(["anchor", "boundaryWallIds", "color", "id", "kind", "name"]);
  });

  it("updates the existing binding instead of creating a second label and skips unchanged attributes", () => {
    const plan = labelled();
    const room = resolveWallRoomLabels(plan).rooms[0];
    expect(setWallRoomLabel(plan, room, values, "ignored-new-id")).toBe(plan);
    const next = setWallRoomLabel(plan, room, { ...values, name: "Кабинет", kind: "other" }, "ignored-new-id");
    expect(next.wallRoomLabels).toHaveLength(1);
    expect(next.wallRoomLabels[0].id).toBe("bedroom");
    expect(next.wallRoomLabels[0].name).toBe("Кабинет");
  });

  it.each([
    { name: "" }, { name: "   " }, { name: "a".repeat(61) },
    { color: "red" }, { color: "#fff" }, { kind: "office" },
  ])("rejects malformed attributes atomically: %j", (invalid) => {
    const plan = labelled();
    const before = structuredClone(plan);
    expect(() => setWallRoomLabel(plan, detectWallRooms(plan.walls).rooms[0], { ...values, ...invalid } as typeof values, "new")).toThrow();
    expect(plan).toEqual(before);
  });

  it("validates finite anchors, unique boundary IDs, label counts and global object IDs", () => {
    const plan = labelled();
    for (const update of [
      { anchor: { x: NaN, y: 0 } }, { anchor: { x: 1001, y: 0 } },
      { boundaryWallIds: [] }, { boundaryWallIds: ["wall-0", "wall-0"] },
      { boundaryWallIds: [""] }, { boundaryWallIds: Array.from({ length: 1001 }, (_, index) => String(index)) },
      { id: "wall-0" }, { extra: true },
    ]) expect(floorPlanSchema.safeParse({ ...plan, wallRoomLabels: [{ ...plan.wallRoomLabels[0], ...update }] }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...plan, wallRoomLabels: Array.from({ length: 101 }, (_, index) => ({ ...plan.wallRoomLabels[0], id: `label-${index}` })) }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...plan, wallRoomLabels: [...plan.wallRoomLabels, plan.wallRoomLabels[0]] }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...plan, wallRoomLabels: [{ ...plan.wallRoomLabels[0], boundaryWallIds: ["deleted-wall"] }] }).success).toBe(true);
    expect(() => setWallRoomLabel(planWith(), detectWallRooms(plan.walls).rooms[0], values, "wall-0")).toThrow();
  });

  it("keeps labels after resizing, translation, reversal and thickness changes with stable walls", () => {
    const original = addRectangularWallRoom(createEmptyPlan("rectangle"), { x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 3 }, ["top", "right", "bottom", "left"]);
    const plan = labelled(original);
    const resized = resizeRectangularWallRoom(plan, detectWallRooms(plan.walls).rooms[0], 7, 6);
    expect(attributes(resized)).toEqual([["Спальня", "bedroom", "#aabbcc", "bedroom"]]);
    const moved = { ...resized, walls: resized.walls.map((wall) => ({ ...wall, start: { x: wall.end.x + 30, y: wall.end.y - 20 }, end: { x: wall.start.x + 30, y: wall.start.y - 20 }, thickness: 0.4 })) };
    const next = reconcileWallRoomLabels(plan, moved);
    expect(attributes(next)).toEqual(attributes(plan));
    expect(next.wallRoomLabels[0].anchor).toEqual(resolveWallRoomLabels(next).rooms[0].labelPoint);
    expect(next.wallRoomLabels[0].anchor.x).toBeGreaterThan(30);
    expect(plan.wallRoomLabels[0].anchor.x).toBeLessThan(10);
  });

  it("stores the room key as boundaryWallIds and keeps key and binding through resizing", () => {
    const original = addRectangularWallRoom(createEmptyPlan("key"), { x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 3 }, ["top", "right", "bottom", "left"]);
    const room = detectWallRooms(original.walls).rooms[0];
    const plan = labelled(original);
    expect(wallRoomKey(plan.wallRoomLabels[0].boundaryWallIds)).toBe(room.id);
    const resized = resizeRectangularWallRoom(plan, room, 7, 6);
    const [after] = resolveWallRoomLabels(resized).rooms;
    expect(after.id).toBe(room.id);
    expect(after.labelId).toBe("bedroom");
    expect(after.area).toBeCloseTo(42, 10);
    expect(wallRoomKey(resized.wallRoomLabels[0].boundaryWallIds)).toBe(after.id);
  });

  it("does not bind attributes by room order or view IDs when another room is added", () => {
    const plan = labelled();
    const next = { ...plan, walls: [...rectangle(-10, -10, 3, 3, "new"), ...plan.walls] };
    const result = resolveWallRoomLabels(next);
    expect(result.rooms[0].name).toBe("Помещение 1");
    expect(result.rooms[0].labelId).toBeUndefined();
    expect(result.rooms[1].name).toBe("Спальня");
    expect(result.rooms[1].labelId).toBe("bedroom");
  });

  it("tracks a physical boundary wall split by a T join without changing the room", () => {
    const original = planWith([...rectangle(), { id: "branch", start: { x: 2, y: -2 }, end: { x: 2, y: -0.2 }, thickness: 0.2, height: 3 }]);
    const plan = labelled(original);
    const diagnostic = analyzeWallConnections(plan.walls).find((item) => item.wallId === "branch" && item.endpoint === "end")!;
    const next = reconcileWallRoomLabels(plan, connectWallJunction(plan, diagnostic, "top-after"));
    expect(attributes(next)).toEqual(attributes(plan));
    expect(next.wallRoomLabels[0].boundaryWallIds).toContain("top-after");
    expect(next.wallRoomLabels[0].boundaryWallIds).not.toContain("branch");
    expect(next.wallRoomLabels[0].anchor).toEqual(resolveWallRoomLabels(next).rooms[0].labelPoint);
  });

  it("includes actual hole boundary support and never assigns an anchor inside a hole", () => {
    const walls = [...rectangle(), { id: "island", start: { x: 2, y: 2 }, end: { x: 3, y: 2 }, thickness: 0.4, height: 3 }];
    const plan = labelled(planWith(walls));
    expect(plan.wallRoomLabels[0].boundaryWallIds).toContain("island");
    expect(resolveWallRoomLabels(plan).rooms[0].holes).toHaveLength(1);
    const before = labelled();
    const next = reconcileWallRoomLabels(before, { ...before, walls });
    expect(resolveWallRoomLabels(next).unassigned).toHaveLength(1);
    expect(next.wallRoomLabels).toEqual(before.wallRoomLabels);
  });

  it("uses physical diagonal and concave boundary edges rather than room bounding boxes", () => {
    const points = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }, { x: 3, y: 3 }, { x: 0, y: 6 }];
    const walls = points.map((start, index): Wall => ({ id: `edge-${index}`, start, end: points[(index + 1) % points.length], thickness: 0.2, height: 3 }));
    const unrelated: Wall = { id: "outside", start: { x: 5, y: 4 }, end: { x: 5.5, y: 4 }, thickness: 0.2, height: 3 };
    const plan = labelled(planWith([...walls, unrelated]));
    expect(plan.wallRoomLabels[0].boundaryWallIds).toEqual(["edge-0", "edge-1", "edge-2", "edge-3", "edge-4"]);
    const moved = { ...plan, walls: plan.walls.map((wall) => ({ ...wall, start: { x: wall.start.x - 20, y: wall.start.y + 10 }, end: { x: wall.end.x - 20, y: wall.end.y + 10 } })) };
    expect(attributes(moved)).toEqual(attributes(plan));
  });

  it("follows an unambiguous interior anchor after an off-centre split and never copies it to both rooms", () => {
    const plan = labelled();
    const next = reconcileWallRoomLabels(plan, { ...plan, walls: [...plan.walls, { id: "partition", start: { x: 1, y: 0 }, end: { x: 1, y: 4 }, thickness: 0.2, height: 3 }] });
    const rooms = resolveWallRoomLabels(next).rooms;
    expect(rooms.filter((room) => room.labelId === "bedroom")).toHaveLength(1);
    expect(rooms[0].labelId).toBeUndefined();
    expect(rooms[1].name).toBe("Спальня");
    expect(next.wallRoomLabels[0].boundaryWallIds).toContain("partition");
    expect(next.wallRoomLabels[0].boundaryWallIds).not.toContain("wall-3");
  });

  it("requires an explicit reassignment when translation and changed boundary IDs make identity uncertain", () => {
    const plan = labelled();
    const movedWalls = rectangle(20, 20).map((wall, index) => index === 0 ? { ...wall, id: "replacement-top" } : wall);
    const moved = reconcileWallRoomLabels(plan, { ...plan, walls: movedWalls });
    expect(resolveWallRoomLabels(moved).rooms[0].labelId).toBeUndefined();
    expect(resolveWallRoomLabels(moved).unassigned).toEqual(plan.wallRoomLabels);
    expect(moved.wallRoomLabels).toEqual(plan.wallRoomLabels);
    const partition: Wall = { id: "partition", start: { x: 22.5, y: 20 }, end: { x: 22.5, y: 24 }, thickness: 0.2, height: 3 };
    const ambiguous = reconcileWallRoomLabels(plan, { ...plan, walls: [...movedWalls, partition] });
    expect(resolveWallRoomLabels(ambiguous).rooms.every((room) => room.labelId === undefined)).toBe(true);
    expect(ambiguous.wallRoomLabels).toEqual(plan.wallRoomLabels);
  });

  it("does not transfer a disappeared room name to a neighbour sharing most of its walls", () => {
    const divided = planWith([...rectangle(), { id: "partition", start: { x: 2.5, y: 0 }, end: { x: 2.5, y: 4 }, thickness: 0.2, height: 3 }]);
    const plan = labelled(divided);
    const opened = reconcileWallRoomLabels(plan, { ...plan, walls: plan.walls.filter((wall) => wall.id !== "wall-3") });
    const result = resolveWallRoomLabels(opened);
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0].bounds.minX).toBeCloseTo(2.6);
    expect(result.rooms[0].labelId).toBeUndefined();
    expect(result.unassigned).toEqual(plan.wallRoomLabels);
    expect(opened.wallRoomLabels).toEqual(plan.wallRoomLabels);
  });

  it("reports the 100-label limit without discarding existing orphan records", () => {
    const plan = labelled();
    const full = { ...plan, wallRoomLabels: Array.from({ length: 100 }, (_, index) => ({ ...plan.wallRoomLabels[0], id: `orphan-${index}`, boundaryWallIds: ["missing"], anchor: { x: -20, y: -20 } })) };
    expect(() => setWallRoomLabel(full, detectWallRooms(full.walls).rooms[0], values, "one-too-many")).toThrow("В одном плане может быть не больше 100 подписей помещений.");
    expect(full.wallRoomLabels).toHaveLength(100);
  });

  it("retains labels as unassigned on an ambiguous centered split instead of duplicating them", () => {
    const plan = labelled();
    const next = reconcileWallRoomLabels(plan, { ...plan, walls: [...plan.walls, { id: "partition", start: { x: 2.5, y: 0 }, end: { x: 2.5, y: 4 }, thickness: 0.2, height: 3 }] });
    const result = resolveWallRoomLabels(next);
    expect(result.rooms).toHaveLength(2);
    expect(result.rooms.every((room) => room.labelId === undefined)).toBe(true);
    expect(result.unassigned).toEqual(plan.wallRoomLabels);
    expect(result.warnings.join(" ")).toMatch(/Не привязано подписей/);
    expect(next.wallRoomLabels).toEqual(plan.wallRoomLabels);
  });

  it("keeps both names unassigned when two labelled rooms are merged", () => {
    const divided = planWith([...rectangle(), { id: "partition", start: { x: 2.5, y: 0 }, end: { x: 2.5, y: 4 }, thickness: 0.2, height: 3 }]);
    const first = labelled(divided);
    const plan = setWallRoomLabel(first, detectWallRooms(first.walls).rooms[1], { ...values, name: "Кухня", kind: "kitchen" }, "kitchen");
    const next = reconcileWallRoomLabels(plan, { ...plan, walls: plan.walls.filter((wall) => wall.id !== "partition") });
    expect(resolveWallRoomLabels(next).rooms).toHaveLength(1);
    expect(resolveWallRoomLabels(next).rooms[0].labelId).toBeUndefined();
    expect(resolveWallRoomLabels(next).unassigned).toHaveLength(2);
    expect(next.wallRoomLabels).toEqual(plan.wallRoomLabels);
    const room = resolveWallRoomLabels(next).rooms[0];
    const assigned = assignWallRoomLabel(next, "kitchen", room);
    expect(resolveWallRoomLabels(assigned).rooms[0].name).toBe("Кухня");
    expect(resolveWallRoomLabels(assigned).unassigned.map((label) => label.id)).toEqual(["bedroom"]);
  });

  it("does not choose between duplicated exact labels imported with unique IDs", () => {
    const plan = labelled();
    const ambiguous = { ...plan, wallRoomLabels: [...plan.wallRoomLabels, { ...plan.wallRoomLabels[0], id: "duplicate-name" }] };
    expect(resolveWallRoomLabels(ambiguous).rooms[0].labelId).toBeUndefined();
    expect(resolveWallRoomLabels(ambiguous).unassigned).toHaveLength(2);
    const room = detectWallRooms(plan.walls).rooms[0];
    expect(() => assignWallRoomLabel(ambiguous, "bedroom", room)).toThrow(/Несколько сохранённых записей/);
    expect(() => setWallRoomLabel(ambiguous, room, values, "third")).toThrow(/Несколько сохранённых записей/);
    expect(ambiguous.wallRoomLabels).toHaveLength(2);
    expect(resolveWallRoomLabels(removeWallRoomLabel(ambiguous, "duplicate-name")).rooms[0].labelId).toBe("bedroom");
  });

  it("retains disappeared room metadata and supports explicit reassignment or removal", () => {
    const plan = labelled();
    const opened = reconcileWallRoomLabels(plan, { ...plan, walls: plan.walls.slice(0, 3) });
    expect(resolveWallRoomLabels(opened).rooms).toEqual([]);
    expect(opened.wallRoomLabels).toEqual(plan.wallRoomLabels);
    const replacement = { ...opened, walls: rectangle(10, 10, 4, 3, "replacement") };
    const room = detectWallRooms(replacement.walls).rooms[0];
    const assigned = assignWallRoomLabel(replacement, "bedroom", { ...room, id: "view:remapped" });
    expect(attributes(assigned)).toEqual([["Спальня", "bedroom", "#aabbcc", "bedroom"]]);
    expect(assigned.wallRoomLabels[0].boundaryWallIds).toEqual(["replacement-0", "replacement-1", "replacement-2", "replacement-3"]);
    expect(removeWallRoomLabel(assigned, "bedroom").wallRoomLabels).toEqual([]);
    expect(assigned.wallRoomLabels).toHaveLength(1);
    expect(() => removeWallRoomLabel(assigned, "missing")).toThrow(/не найдена/);
  });

  it("rejects stale contours and reassignment to occupied targets or from assigned sources", () => {
    const plan = labelled();
    const room = detectWallRooms(plan.walls).rooms[0];
    const changed = { ...plan, walls: plan.walls.map((wall) => ({ ...wall, start: { x: wall.start.x + 1, y: wall.start.y }, end: { x: wall.end.x + 1, y: wall.end.y } })) };
    expect(() => setWallRoomLabel(changed, room, values, "new")).toThrow(/изменилось/);
    const orphan: WallRoomLabel = { ...plan.wallRoomLabels[0], id: "orphan", boundaryWallIds: ["gone"], anchor: { x: -20, y: -20 } };
    const withOrphan = { ...plan, wallRoomLabels: [...plan.wallRoomLabels, orphan] };
    expect(() => assignWallRoomLabel(withOrphan, "orphan", room)).toThrow(/уже связаны/);
    expect(() => assignWallRoomLabel(withOrphan, "missing", room)).toThrow(/не найдена/);
    const other = { ...withOrphan, walls: [...withOrphan.walls, ...rectangle(20, 20, 3, 3, "other")] };
    expect(() => assignWallRoomLabel(other, "bedroom", detectWallRooms(other.walls).rooms[1])).toThrow(/уже связаны/);
    expect(() => setWallRoomLabel(other, detectWallRooms(other.walls).rooms[1], values, "orphan")).toThrow(/уже существует/);
  });

  it("handles frozen inputs without mutation and skips analysis for manual mode", () => {
    const plan = deepFreeze(labelled());
    const before = structuredClone(plan);
    resolveWallRoomLabels(plan);
    const changed = setWallRoomLabel(plan, detectWallRooms(plan.walls).rooms[0], { ...values, color: "#112233" }, "new");
    expect(changed.wallRoomLabels[0].color).toBe("#112233");
    expect(plan).toEqual(before);
    const manual = { ...plan, roomMode: "manual" as const, walls: [{ ...plan.walls[0], end: plan.walls[0].start }] };
    expect(resolveWallRoomLabels(manual)).toEqual({ rooms: [], warnings: [], unassigned: plan.wallRoomLabels });
    expect(reconcileWallRoomLabels(plan, manual)).toBe(manual);
    expect(() => setWallRoomLabel(manual, detectWallRooms(plan.walls).rooms[0], values, "new")).toThrow(/Переключитесь/);
  });
});
