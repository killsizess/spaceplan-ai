import { describe, expect, it } from "vitest";
import {
  createDefaultRoom,
  createEmptyPlan,
} from "@/domain/floor-plan/operations";
import { editorReducer, initialEditorState } from "./editor-state";
import type { Wall } from "@/domain/floor-plan/types";
import { detectWallRooms, wallRoomDetectionStats } from "@/domain/floor-plan/wall-rooms";
import { floorPlanSchema } from "@/domain/floor-plan/schema";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { analyzeWallIntersections } from "@/domain/floor-plan/wall-intersections";
import { resolveWallRoomLabels, setWallRoomLabel } from "@/domain/floor-plan/wall-room-labels";

function connectedPlan() {
  const plan = createEmptyPlan("connected");
  const walls: Wall[] = [
    { id: "top", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 3 },
    { id: "right", start: { x: 5, y: 0 }, end: { x: 5, y: 4 }, thickness: 0.2, height: 3 },
    { id: "bottom", start: { x: 5, y: 4 }, end: { x: 0, y: 4 }, thickness: 0.2, height: 3 },
    { id: "left", start: { x: 0, y: 4 }, end: { x: 0, y: 0 }, thickness: 0.2, height: 3 },
  ];
  return { ...plan, roomMode: "walls" as const, walls, rooms: [createDefaultRoom(plan, "manual")] };
}

describe("editor history", () => {
  it("connects a crossing and transfers both walls' openings in one undoable action", () => {
    const plan = createEmptyPlan("crossing");
    plan.walls = [
      { id: "a", start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, thickness: 0.2, height: 3 },
      { id: "b", start: { x: 4, y: -4 }, end: { x: 4, y: 6 }, thickness: 0.2, height: 3 },
    ];
    plan.openings = [
      { id: "door", wallId: "a", offset: 7, width: 1, kind: "door", height: 2.1, sillHeight: 0 },
      { id: "window", wallId: "b", offset: 5, width: 1, kind: "window", height: 1.2, sillHeight: 0.8 },
    ];
    const diagnostic = analyzeWallIntersections(plan.walls).intersections[0];
    const initial = { ...initialEditorState(plan), selectedId: "window", future: [createEmptyPlan("old-redo")] };
    const action = { type: "wall:connect-intersection" as const, diagnostic, newWallIds: ["a-after", "b-after"] as const };
    const joined = editorReducer(initial, action);
    expect(joined.error).toBeNull();
    expect(joined.selectedId).toBe("a");
    expect(joined.plan.walls).toHaveLength(4);
    expect(joined.plan.openings).toEqual([
      { ...plan.openings[0], wallId: "a-after", offset: 3 },
      { ...plan.openings[1], wallId: "b-after", offset: 1 },
    ]);
    expect(joined.past).toEqual([plan]);
    expect(joined.future).toEqual([]);
    const undone = editorReducer(joined, { type: "undo" });
    expect(undone.plan).toBe(plan);
    expect(undone.past).toEqual([]);
    expect(undone.future).toEqual([joined.plan]);
    const redone = editorReducer(undone, { type: "redo" });
    expect(redone.plan).toBe(joined.plan);
    expect(redone.past).toEqual([plan]);
    const replayed = editorReducer(redone, { ...action, newWallIds: ["a-third", "b-third"] });
    expect(replayed.error).toMatch(/изменилось/);
    expect(replayed.plan).toBe(redone.plan);
    expect(replayed.selectedId).toBe(redone.selectedId);
    expect(replayed.past).toBe(redone.past);
    expect(replayed.future).toBe(redone.future);
  });

  it("preserves the plan, selection and both history stacks when the second crossing wall has a blocking opening", () => {
    const plan = createEmptyPlan("blocked-crossing");
    plan.walls = [
      { id: "a", start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, thickness: 0.2, height: 3 },
      { id: "b", start: { x: 4, y: -4 }, end: { x: 4, y: 6 }, thickness: 0.2, height: 3 },
    ];
    plan.openings = [
      { id: "safe-door", wallId: "a", offset: 7, width: 1, kind: "door", height: 2.1, sillHeight: 0 },
      { id: "blocked-door", wallId: "b", offset: 3.5, width: 1, kind: "door", height: 2.1, sillHeight: 0 },
    ];
    const initial = {
      ...initialEditorState(plan), selectedId: "blocked-door",
      past: [createEmptyPlan("previous")], future: [createEmptyPlan("redo")],
    };
    const rejected = editorReducer(initial, {
      type: "wall:connect-intersection", diagnostic: analyzeWallIntersections(plan.walls).intersections[0],
      newWallIds: ["a-after", "b-after"],
    });
    expect(rejected.error).toMatch(/внутрь проёма/);
    expect(rejected.plan).toBe(initial.plan);
    expect(rejected.selectedId).toBe(initial.selectedId);
    expect(rejected.past).toBe(initial.past);
    expect(rejected.future).toBe(initial.future);
    expect(rejected.plan.openings).toEqual(plan.openings);
  });

  it("preserves both histories and selection after stale crossing geometry or duplicate split IDs", () => {
    const plan = createEmptyPlan("stale-crossing");
    plan.walls = [
      { id: "a", start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, thickness: 0.2, height: 3 },
      { id: "b", start: { x: 4, y: -4 }, end: { x: 4, y: 6 }, thickness: 0.2, height: 3 },
    ];
    const diagnostic = analyzeWallIntersections(plan.walls).intersections[0];
    const changed = { ...plan, walls: [plan.walls[0], { ...plan.walls[1], start: { x: 4.1, y: -4 }, end: { x: 4.1, y: 6 } }] };
    const initial = {
      ...initialEditorState(changed), selectedId: "b",
      past: [createEmptyPlan("previous")], future: [plan],
    };
    for (const newWallIds of [["a-after", "b-after"], ["a", "b-after"]] as const) {
      const rejected = editorReducer(initial, { type: "wall:connect-intersection", diagnostic, newWallIds });
      expect(rejected.error).toMatch(newWallIds[0] === "a" ? /уже существует/ : /изменилось/);
      expect(rejected.plan).toBe(initial.plan);
      expect(rejected.selectedId).toBe(initial.selectedId);
      expect(rejected.past).toBe(initial.past);
      expect(rejected.future).toBe(initial.future);
    }
  });

  it("rejects a pair through a third wall without creating a partly connected node or losing redo", () => {
    const plan = createEmptyPlan("triple-crossing");
    plan.walls = [
      { id: "a", start: { x: -3, y: 0 }, end: { x: 3, y: 0 }, thickness: 0.2, height: 3 },
      { id: "b", start: { x: 0, y: -3 }, end: { x: 0, y: 3 }, thickness: 0.2, height: 3 },
      { id: "c", start: { x: -3, y: -3 }, end: { x: 3, y: 3 }, thickness: 0.2, height: 3 },
    ];
    const initial = {
      ...initialEditorState(plan), selectedId: "c",
      past: [createEmptyPlan("previous")], future: [createEmptyPlan("redo")],
    };
    const rejected = editorReducer(initial, {
      type: "wall:connect-intersection", diagnostic: analyzeWallIntersections(plan.walls).intersections[0],
      newWallIds: ["a-after", "b-after"],
    });
    expect(rejected.error).toMatch(/больше двух стен/);
    expect(rejected.plan).toBe(initial.plan);
    expect(rejected.selectedId).toBe(initial.selectedId);
    expect(rejected.past).toBe(initial.past);
    expect(rejected.future).toBe(initial.future);
    expect(analyzeWallIntersections(rejected.plan.walls).intersections).toHaveLength(3);
  });

  it("creates a T-junction and transfers openings in one undoable and redoable action", () => {
    const plan = createEmptyPlan("junction");
    plan.walls = [
      { id: "source", start: { x: 2, y: 0.2 }, end: { x: 2, y: 3 }, thickness: 0.2, height: 3 },
      { id: "target", start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, thickness: 0.2, height: 3 },
    ];
    plan.openings = [{ id: "door", wallId: "target", offset: 3, width: 1, kind: "door", height: 2.1, sillHeight: 0 }];
    const diagnostic = analyzeWallConnections(plan.walls).find((item) => item.wallId === "source" && item.endpoint === "start");
    if (!diagnostic) throw new Error("Fixture must have a free end.");
    const previous = createEmptyPlan("previous");
    const initial = {
      ...initialEditorState(plan), selectedId: "door", past: [previous], future: [createEmptyPlan("redo")],
    };
    const joined = editorReducer(initial, { type: "wall:connect-junction", diagnostic, newWallId: "second-half" });
    expect(joined.error).toBeNull();
    expect(joined.selectedId).toBe("source");
    expect(joined.plan.walls).toHaveLength(3);
    expect(joined.plan.walls[0].start).toEqual({ x: 2, y: 0 });
    expect(joined.plan.openings).toEqual([{ ...plan.openings[0], wallId: "second-half", offset: 1 }]);
    expect(joined.past).toEqual([previous, plan]);
    expect(joined.future).toEqual([]);
    const undone = editorReducer(joined, { type: "undo" });
    expect(undone.plan).toBe(plan);
    expect(undone.plan.openings[0].wallId).toBe("target");
    expect(undone.past).toEqual([previous]);
    expect(undone.future).toEqual([joined.plan]);
    const redone = editorReducer(undone, { type: "redo" });
    expect(redone.plan).toBe(joined.plan);
    expect(redone.past).toEqual([previous, plan]);
    const replayed = editorReducer(joined, { type: "wall:connect-junction", diagnostic, newWallId: "third-half" });
    expect(replayed.error).toMatch(/изменилось/);
    expect(replayed.plan).toBe(joined.plan);
    expect(replayed.selectedId).toBe(joined.selectedId);
    expect(replayed.past).toBe(joined.past);
    expect(replayed.future).toBe(joined.future);
  });

  it("preserves the plan, selection and both history stacks when a T-junction crosses an opening", () => {
    const plan = createEmptyPlan("junction-opening");
    plan.walls = [
      { id: "source", start: { x: 2, y: 0 }, end: { x: 2, y: 3 }, thickness: 0.2, height: 3 },
      { id: "target", start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, thickness: 0.2, height: 3 },
    ];
    plan.openings = [{ id: "door", wallId: "target", offset: 1.5, width: 1, kind: "door", height: 2.1, sillHeight: 0 }];
    const diagnostic = analyzeWallConnections(plan.walls).find((item) => item.wallId === "source" && item.endpoint === "start");
    if (!diagnostic) throw new Error("Fixture must have a free end.");
    const initial = {
      ...initialEditorState(plan), selectedId: "door",
      past: [createEmptyPlan("previous")], future: [createEmptyPlan("redo")],
    };
    const rejected = editorReducer(initial, { type: "wall:connect-junction", diagnostic, newWallId: "second-half" });
    expect(rejected.error).toMatch(/внутрь проёма/);
    expect(rejected.plan).toBe(initial.plan);
    expect(rejected.selectedId).toBe(initial.selectedId);
    expect(rejected.past).toBe(initial.past);
    expect(rejected.future).toBe(initial.future);
    expect(rejected.plan.openings).toEqual(plan.openings);
  });

  it("preserves both histories after a stale T-junction or duplicate split ID", () => {
    const plan = createEmptyPlan("stale-junction");
    plan.walls = [
      { id: "source", start: { x: 2, y: 0.2 }, end: { x: 2, y: 3 }, thickness: 0.2, height: 3 },
      { id: "target", start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, thickness: 0.2, height: 3 },
    ];
    const diagnostic = analyzeWallConnections(plan.walls).find((item) => item.wallId === "source" && item.endpoint === "start");
    if (!diagnostic) throw new Error("Fixture must have a free end.");
    const changed = { ...plan, walls: [{ ...plan.walls[0], start: { x: 2.1, y: 0.2 } }, plan.walls[1]] };
    const initial = {
      ...initialEditorState(changed), selectedId: "target",
      past: [createEmptyPlan("previous")], future: [plan],
    };
    for (const newWallId of ["second-half", "target"]) {
      const rejected = editorReducer(initial, { type: "wall:connect-junction", diagnostic, newWallId });
      expect(rejected.error).toMatch(newWallId === "target" ? /уже существует/ : /изменилось/);
      expect(rejected.plan).toBe(initial.plan);
      expect(rejected.selectedId).toBe(initial.selectedId);
      expect(rejected.past).toBe(initial.past);
      expect(rejected.future).toBe(initial.future);
    }
  });

  it("joins an explicitly selected endpoint in one undoable action and rejects repeated snapshots", () => {
    const plan = connectedPlan();
    plan.walls[0] = { ...plan.walls[0], end: { x: 4.8, y: 0 } };
    const diagnostic = analyzeWallConnections(plan.walls).find((item) =>
      item.wallId === "top" && item.endpoint === "end",
    );
    if (!diagnostic) throw new Error("Fixture must have a free end.");
    const initial = { ...initialEditorState(plan), selectedId: "right" };
    const joined = editorReducer(initial, { type: "wall:connect-endpoints", diagnostic });
    expect(joined.error).toBeNull();
    expect(joined.selectedId).toBe("top");
    expect(joined.plan.walls[0].end).toEqual({ x: 5, y: 0 });
    expect(joined.plan.walls.slice(1)).toEqual(plan.walls.slice(1));
    expect(joined.plan.rooms).toEqual(plan.rooms);
    expect(joined.plan.openings).toEqual(plan.openings);
    expect(joined.past).toEqual([plan]);
    expect(joined.future).toEqual([]);
    const replayed = editorReducer(joined, { type: "wall:connect-endpoints", diagnostic });
    expect(replayed.error).toMatch(/изменилось/);
    expect(replayed.plan).toBe(joined.plan);
    expect(replayed.past).toBe(joined.past);
    expect(replayed.future).toBe(joined.future);
    const undone = editorReducer(joined, { type: "undo" });
    expect(undone.plan).toBe(plan);
    expect(undone.past).toEqual([]);
    const redone = editorReducer(undone, { type: "redo" });
    expect(redone.plan).toBe(joined.plan);
    expect(redone.past).toEqual([plan]);
  });

  it("preserves plan, selection and both history stacks after a stale endpoint connection", () => {
    const plan = connectedPlan();
    plan.walls[0] = { ...plan.walls[0], end: { x: 4.8, y: 0 } };
    const diagnostic = analyzeWallConnections(plan.walls).find((item) =>
      item.wallId === "top" && item.endpoint === "end",
    );
    if (!diagnostic) throw new Error("Fixture must have a free end.");
    const previous = createEmptyPlan("previous");
    const changed = {
      ...plan,
      walls: plan.walls.map((item) => item.id === "right"
        ? { ...item, start: { x: 5.1, y: 0 } } : item),
    };
    const initial = {
      ...initialEditorState(changed), selectedId: "left", past: [previous], future: [plan],
    };
    const rejected = editorReducer(initial, { type: "wall:connect-endpoints", diagnostic });
    expect(rejected.error).toMatch(/изменилось/);
    expect(rejected.plan).toBe(initial.plan);
    expect(rejected.selectedId).toBe(initial.selectedId);
    expect(rejected.past).toBe(initial.past);
    expect(rejected.future).toBe(initial.future);
  });

  it("keeps a door and redo intact when joining a nearby endpoint would shrink its wall too far", () => {
    const plan = createEmptyPlan("join-door");
    plan.walls = [
      { id: "source", start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, thickness: 0.2, height: 3 },
      { id: "target", start: { x: 1.8, y: 0 }, end: { x: 1.8, y: -3 }, thickness: 0.2, height: 3 },
    ];
    plan.openings = [{
      id: "door", wallId: "source", kind: "door", offset: 1.2, width: 0.7,
      height: 2.1, sillHeight: 0,
    }];
    const diagnostic = analyzeWallConnections(plan.walls).find((item) =>
      item.wallId === "source" && item.endpoint === "end",
    );
    if (!diagnostic) throw new Error("Fixture must have a free end.");
    const initial = { ...initialEditorState(plan), future: [createEmptyPlan("redo")] };
    const rejected = editorReducer(initial, { type: "wall:connect-endpoints", diagnostic });
    expect(rejected.error).toMatch(/Проём выходит за границы/);
    expect(rejected.plan).toBe(initial.plan);
    expect(rejected.past).toBe(initial.past);
    expect(rejected.future).toBe(initial.future);
    expect(rejected.plan.openings).toEqual(plan.openings);
  });

  it("creates and resizes a physical rectangular room as separate atomic history entries", () => {
    const empty = createEmptyPlan("p");
    const initial = initialEditorState({ ...empty, rooms: [createDefaultRoom(empty, "manual")] });
    const created = editorReducer(initial, {
      type: "wall-room:add",
      input: { x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 2.7 },
      wallIds: ["top", "right", "bottom", "left"],
    });
    expect(created.error).toBeNull();
    expect(created.selectedId).toBe("top");
    expect(created.plan.walls).toHaveLength(4);
    expect(created.plan.roomMode).toBe("walls");
    expect(created.plan.rooms).toEqual(initial.plan.rooms);
    expect(created.past).toEqual([initial.plan]);
    const room = detectWallRooms(created.plan.walls).rooms[0];
    expect(room.area).toBeCloseTo(20, 10);
    const resized = editorReducer(created, {
      type: "wall-room:resize", room: { ...room, id: "display-id" }, width: 7, depth: 3,
    });
    expect(resized.error).toBeNull();
    // The view ID stays selected: the same four walls keep the derived room key.
    expect(resized.selectedId).toBe("display-id");
    expect(resized.past).toEqual([initial.plan, created.plan]);
    expect(resized.plan.rooms).toEqual(initial.plan.rooms);
    expect(detectWallRooms(resized.plan.walls).rooms[0].area).toBeCloseTo(21, 10);
    expect(detectWallRooms(resized.plan.walls).rooms[0].id).toBe(room.id);
    const undone = editorReducer(resized, { type: "undo" });
    expect(undone.plan).toBe(created.plan);
    expect(editorReducer(undone, { type: "redo" }).plan).toBe(resized.plan);
    const removed = editorReducer(undone, { type: "undo" });
    expect(removed.plan).toBe(initial.plan);
    expect(removed.plan.roomMode).toBe("manual");
    const stale = editorReducer(resized, {
      type: "wall-room:resize", room, width: 6, depth: 4,
    });
    expect(stale.error).toMatch(/изменилось/);
    expect(stale.plan).toBe(resized.plan);
    expect(stale.past).toBe(resized.past);
    const unchanged = editorReducer(created, {
      type: "wall-room:resize", room, width: 5, depth: 4,
    });
    expect(unchanged.plan).toBe(created.plan);
    expect(unchanged.past).toBe(created.past);
  });

  it("keeps prior state and redo after invalid rectangular creation", () => {
    const initial = initialEditorState(createEmptyPlan("p"));
    const created = editorReducer(initial, {
      type: "wall-room:add",
      input: { x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 2.7 },
      wallIds: ["top", "right", "bottom", "left"],
    });
    const undone = editorReducer(created, { type: "undo" });
    const invalid = editorReducer(undone, {
      type: "wall-room:add",
      input: { x: 0, y: 0, width: NaN, depth: 4, thickness: 0.2, wallHeight: 2.7 },
      wallIds: ["top", "right", "bottom", "left"],
    });
    expect(invalid.error).not.toBeNull();
    expect(invalid.plan).toBe(undone.plan);
    expect(invalid.past).toBe(undone.past);
    expect(invalid.future).toBe(undone.future);
  });

  it("records a connected corner move once and restores walls, mode and manual rooms together", () => {
    const initial = initialEditorState(connectedPlan());
    const changed = editorReducer(initial, {
      type: "wall:node-move",
      wallId: "top",
      endpoint: "end",
      expectedPoint: { x: 5, y: 0 },
      point: { x: 6, y: 0 },
    });
    expect(changed.error).toBeNull();
    expect(changed.plan.walls[0].end).toEqual({ x: 6, y: 0 });
    expect(changed.plan.walls[1].start).toEqual({ x: 6, y: 0 });
    expect(changed.selectedId).toBe("top");
    expect(changed.plan.roomMode).toBe("walls");
    expect(changed.plan.rooms).toEqual(initial.plan.rooms);
    expect(changed.past).toEqual([initial.plan]);
    const undone = editorReducer(changed, { type: "undo" });
    expect(undone.plan).toBe(initial.plan);
    const redone = editorReducer(undone, { type: "redo" });
    expect(redone.plan).toBe(changed.plan);
    expect(redone.past).toEqual([initial.plan]);
  });

  it("rejects stale gestures and invalid shared changes without adding history or clearing redo", () => {
    const initial = initialEditorState(connectedPlan());
    const changed = editorReducer(initial, {
      type: "wall:node-move", wallId: "top", endpoint: "end", point: { x: 6, y: 0 },
    });
    const undone = editorReducer(changed, { type: "undo" });
    const stale = editorReducer(undone, {
      type: "wall:node-move", wallId: "top", endpoint: "end",
      expectedPoint: { x: 6, y: 0 }, point: { x: 7, y: 0 },
    });
    expect(stale.error).toMatch(/изменилась/);
    expect(stale.plan).toBe(undone.plan);
    expect(stale.past).toBe(undone.past);
    expect(stale.future).toBe(undone.future);
    for (const point of [{ x: NaN, y: 0 }, { x: 5, y: 4 }]) {
      const invalid = editorReducer(undone, {
        type: "wall:node-move", wallId: "top", endpoint: "end", point,
      });
      expect(invalid.error).not.toBeNull();
      expect(invalid.plan).toBe(undone.plan);
      expect(invalid.past).toBe(undone.past);
      expect(invalid.future).toBe(undone.future);
    }
    const missing = editorReducer(undone, {
      type: "wall:node-move", wallId: "missing", endpoint: "end", point: { x: 1, y: 1 },
    });
    expect(missing.error).toMatch(/не найдена/);
    expect(missing.plan).toBe(undone.plan);
  });

  it("does not create history for no-ops and honors independent inspector edits", () => {
    const initial = initialEditorState(connectedPlan());
    const unchanged = editorReducer(initial, {
      type: "wall:node-move", wallId: "top", endpoint: "end", point: { x: 5, y: 0 },
    });
    expect(unchanged.plan).toBe(initial.plan);
    expect(unchanged.past).toBe(initial.past);
    const independent = editorReducer(initial, {
      type: "wall:update", wall: { ...initial.plan.walls[0], end: { x: 6, y: 0 } },
      connectEndpoints: false,
    });
    expect(independent.error).toBeNull();
    expect(independent.plan.walls[1]).toEqual(initial.plan.walls[1]);
    const connected = editorReducer(initial, {
      type: "wall:update", wall: { ...initial.plan.walls[0], end: { x: 6, y: 0 } },
    });
    expect(connected.plan.walls[1].start).toEqual({ x: 6, y: 0 });
  });

  it("keeps a neighbor opening in place and rolls back a node move that cuts into it", () => {
    const plan = connectedPlan();
    plan.openings = [{ id: "door", wallId: "right", kind: "door", offset: 2, width: 1, height: 2.1, sillHeight: 0 }];
    const initial = initialEditorState(plan);
    // The right wall loses 2 m at its start; the door stays at y = 2..3.
    const moved = editorReducer(initial, {
      type: "wall:node-move", wallId: "top", endpoint: "end", point: { x: 5, y: 2 },
    });
    expect(moved.error).toBeNull();
    expect(moved.plan.walls[1]).toMatchObject({ start: { x: 5, y: 2 }, end: { x: 5, y: 4 } });
    expect(moved.plan.openings).toEqual([{ ...plan.openings[0], offset: 0 }]);
    expect(moved.past).toEqual([initial.plan]);
    const rejected = editorReducer(initial, {
      type: "wall:node-move", wallId: "top", endpoint: "end", point: { x: 5, y: 2.5 },
    });
    expect(rejected.error).toMatch(/границы/);
    expect(rejected.plan).toBe(initial.plan);
    expect(rejected.past).toBe(initial.past);
  });

  it("keeps room calculation mode in undo/redo while retaining manual rooms", () => {
    const plan = createEmptyPlan("p");
    const room = createDefaultRoom(plan, "manual-room");
    const initial = initialEditorState({ ...plan, rooms: [room] });
    const changed = editorReducer(initial, {
      type: "roomMode:set",
      mode: "walls",
    });
    expect(changed.plan.roomMode).toBe("walls");
    expect(changed.plan.rooms).toEqual(initial.plan.rooms);
    expect(changed.selectedId).toBeNull();
    expect(changed.past).toEqual([initial.plan]);
    const unchanged = editorReducer(changed, {
      type: "roomMode:set",
      mode: "walls",
    });
    expect(unchanged.plan).toBe(changed.plan);
    expect(unchanged.past).toBe(changed.past);
    const undone = editorReducer(changed, { type: "undo" });
    expect(undone.plan).toBe(initial.plan);
    expect(undone.plan.roomMode).toBe("manual");
    expect(editorReducer(undone, { type: "redo" }).plan).toBe(changed.plan);
    expect(initialEditorState(changed.plan).selectedId).toBeNull();
  });
  it("restores a wall and all its openings together after cascading deletion", () => {
    const initial = initialEditorState(createEmptyPlan("p"));
    const wall = {
      id: "w",
      start: { x: 0, y: 0 },
      end: { x: 3, y: 4 },
      thickness: 0.2,
      height: 3,
    };
    const added = editorReducer(initial, { type: "wall:add", wall });
    expect(added.selectedId).toBe("w");
    const opened = editorReducer(added, {
      type: "opening:add",
      opening: {
        id: "o",
        wallId: "w",
        kind: "door",
        offset: 1,
        width: 0.9,
        height: 2.1,
        sillHeight: 0,
      },
    });
    expect(opened.selectedId).toBe("o");
    const invalid = editorReducer(opened, {
      type: "wall:update",
      wall: { ...wall, end: { x: 1, y: 0 } },
    });
    expect(invalid.plan).toBe(opened.plan);
    expect(invalid.past).toBe(opened.past);
    expect(invalid.error).toMatch(/границы/);
    const deleted = editorReducer(opened, { type: "delete", id: "w" });
    expect(deleted.plan.walls).toHaveLength(0);
    expect(deleted.plan.openings).toHaveLength(0);
    const undone = editorReducer(deleted, { type: "undo" });
    expect(undone.plan).toEqual(opened.plan);
    expect(editorReducer(undone, { type: "redo" }).plan).toEqual(deleted.plan);
    expect(initial.plan.walls).toHaveLength(0);
  });
  it("tracks underlay changes and removal in the same plan history", () => {
    const initial = initialEditorState(createEmptyPlan("p"));
    const underlay = {
      name: "Plan.png",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
      pixelWidth: 100,
      pixelHeight: 100,
      x: 0,
      y: 0,
      metersPerPixel: 0.01,
      opacity: 0.5,
      visible: true,
      calibrated: false,
    };
    const added = editorReducer(initial, { type: "underlay:set", underlay });
    const hidden = editorReducer(added, {
      type: "underlay:set",
      underlay: { ...underlay, visible: false },
    });
    expect(editorReducer(hidden, { type: "undo" }).plan.underlay?.visible).toBe(
      true,
    );
    const removed = editorReducer(hidden, {
      type: "underlay:set",
      underlay: null,
    });
    expect(removed.plan.underlay).toBeUndefined();
    expect(editorReducer(removed, { type: "undo" }).plan).toEqual(hidden.plan);
  });
  it("supports create/update/delete undo and redo", () => {
    const initial = initialEditorState(createEmptyPlan("p"));
    const room = createDefaultRoom(initial.plan, "r");
    const added = editorReducer(initial, { type: "add", room });
    const resized = editorReducer(added, {
      type: "update",
      room: { ...room, width: 5 },
    });
    const undone = editorReducer(resized, { type: "undo" });
    expect(undone.plan.rooms[0].width).toBe(4);
    expect(editorReducer(undone, { type: "redo" }).plan.rooms[0].width).toBe(5);
    const deleted = editorReducer(resized, { type: "delete", id: room.id });
    expect(deleted.plan.rooms).toHaveLength(0);
    expect(editorReducer(deleted, { type: "undo" }).plan.rooms).toHaveLength(1);
    expect(initial.plan.rooms).toHaveLength(0);
  });
  it("preserves valid state/history on invalid input and clears redo on edits", () => {
    const initial = initialEditorState(createEmptyPlan("p"));
    const room = createDefaultRoom(initial.plan, "r");
    const added = editorReducer(initial, { type: "add", room });
    const rejected = editorReducer(added, {
      type: "update",
      room: { ...room, width: NaN },
    });
    expect(rejected.plan).toBe(added.plan);
    expect(rejected.past).toBe(added.past);
    expect(rejected.error).not.toBeNull();
    const undone = editorReducer(added, { type: "undo" });
    const changed = editorReducer(undone, {
      type: "add",
      room: { ...room, id: "r2" },
    });
    expect(changed.future).toHaveLength(0);
  });
});

describe("wall room label history", () => {
  const values = { name: "Спальня", kind: "bedroom" as const, color: "#aabbcc" };

  it("creates, edits and removes attributes in single undoable actions without modifying geometry", () => {
    const plan = connectedPlan();
    const room = { ...detectWallRooms(plan.walls).rooms[0], id: "view:remapped" };
    const initial = initialEditorState(plan);
    const created = editorReducer(initial, { type: "wall-room:label-set", room, values, labelId: "label" });
    expect(created.error).toBeNull();
    expect(created.selectedId).toBe(room.id);
    expect(created.plan.walls).toEqual(plan.walls);
    expect(created.plan.rooms).toEqual(plan.rooms);
    expect(created.past).toEqual([plan]);
    const changed = editorReducer(created, { type: "wall-room:label-set", room, values: { ...values, name: "Кабинет" }, labelId: "ignored" });
    expect(changed.plan.wallRoomLabels).toHaveLength(1);
    expect(changed.plan.wallRoomLabels[0].id).toBe("label");
    const removed = editorReducer(changed, { type: "wall-room:label-remove", labelId: "label" });
    expect(removed.plan.wallRoomLabels).toEqual([]);
    const undone = editorReducer(removed, { type: "undo" });
    expect(undone.plan).toBe(changed.plan);
    expect(undone.plan.wallRoomLabels[0].name).toBe("Кабинет");
    expect(editorReducer(undone, { type: "redo" }).plan).toBe(removed.plan);
    const unchanged = editorReducer(created, { type: "wall-room:label-set", room, values, labelId: "new" });
    expect(unchanged.plan).toBe(created.plan);
    expect(unchanged.past).toBe(created.past);
    expect(unchanged.future).toBe(created.future);
  });

  it("rebases label anchors alongside resized walls and restores both in one undo", () => {
    const initialPlan = connectedPlan();
    const room = detectWallRooms(initialPlan.walls).rooms[0];
    const plan = setWallRoomLabel(initialPlan, room, values, "label");
    const initial = initialEditorState(plan);
    const resized = editorReducer(initial, { type: "wall-room:resize", room, width: 6, depth: 5 });
    expect(resized.error).toBeNull();
    expect(resized.past).toEqual([plan]);
    expect(resized.plan.wallRoomLabels[0].anchor).toEqual(resolveWallRoomLabels(resized.plan).rooms[0].labelPoint);
    expect(resized.plan.wallRoomLabels[0].anchor).not.toEqual(plan.wallRoomLabels[0].anchor);
    expect(resolveWallRoomLabels(resized.plan).rooms[0].name).toBe("Спальня");
    const undone = editorReducer(resized, { type: "undo" });
    expect(undone.plan).toBe(plan);
    expect(editorReducer(undone, { type: "redo" }).plan).toBe(resized.plan);
  });

  it("preserves orphan metadata on deletion and reassigns it with one undo step", () => {
    const base = connectedPlan();
    const plan = setWallRoomLabel(base, detectWallRooms(base.walls).rooms[0], values, "label");
    const deleted = editorReducer(initialEditorState(plan), { type: "delete", id: "top" });
    expect(deleted.error).toBeNull();
    expect(deleted.plan.wallRoomLabels).toEqual(plan.wallRoomLabels);
    expect(resolveWallRoomLabels(deleted.plan).unassigned).toHaveLength(1);
    const created = editorReducer(deleted, { type: "wall-room:add", input: { x: 10, y: 10, width: 3, depth: 3, thickness: 0.2, wallHeight: 3 }, wallIds: ["new-top", "new-right", "new-bottom", "new-left"] });
    expect(created.error).toBeNull();
    const room = detectWallRooms(created.plan.walls).rooms[0];
    const assigned = editorReducer(created, { type: "wall-room:label-assign", room, labelId: "label" });
    expect(assigned.error).toBeNull();
    expect(assigned.selectedId).toBe(room.id);
    expect(assigned.past.at(-1)).toBe(created.plan);
    expect(resolveWallRoomLabels(assigned.plan).unassigned).toEqual([]);
    expect(editorReducer(assigned, { type: "undo" }).plan).toBe(created.plan);
  });

  it("keeps both history stacks, selection and all metadata on invalid/stale label commands", () => {
    const base = connectedPlan();
    const room = detectWallRooms(base.walls).rooms[0];
    const plan = setWallRoomLabel(base, room, values, "label");
    const initial = { ...initialEditorState(plan), selectedId: "top", past: [base], future: [createEmptyPlan("redo")] };
    const stale = { ...room, outer: room.outer.map((point) => ({ x: point.x + 0.1, y: point.y })) };
    for (const action of [
      { type: "wall-room:label-set" as const, room, values: { ...values, name: "" }, labelId: "new" },
      { type: "wall-room:label-set" as const, room: stale, values, labelId: "new" },
      { type: "wall-room:label-assign" as const, room, labelId: "missing" },
      { type: "wall-room:label-remove" as const, labelId: "missing" },
    ]) {
      const rejected = editorReducer(initial, action);
      expect(rejected.error).not.toBeNull();
      expect(rejected.plan).toBe(initial.plan);
      expect(rejected.selectedId).toBe(initial.selectedId);
      expect(rejected.past).toBe(initial.past);
      expect(rejected.future).toBe(initial.future);
    }
  });

  it("does not analyse inactive wall rooms during manual edits or discard labels on mode changes", () => {
    const base = connectedPlan();
    const plan = setWallRoomLabel(base, detectWallRooms(base.walls).rooms[0], values, "label");
    const manual = editorReducer(initialEditorState(plan), { type: "roomMode:set", mode: "manual" });
    expect(manual.error).toBeNull();
    expect(manual.plan.wallRoomLabels).toEqual(plan.wallRoomLabels);
    const edited = editorReducer(manual, { type: "wall:update", wall: { ...manual.plan.walls[0], height: 3.2 } });
    expect(edited.error).toBeNull();
    expect(edited.plan.wallRoomLabels).toEqual(plan.wallRoomLabels);
    const restored = editorReducer(edited, { type: "roomMode:set", mode: "walls" });
    expect(resolveWallRoomLabels(restored.plan).rooms[0].name).toBe("Спальня");
  });

  it("rejects unresolved duplicate bindings without false success or changes to either history", () => {
    const base = connectedPlan();
    const room = detectWallRooms(base.walls).rooms[0];
    const labelled = setWallRoomLabel(base, room, values, "label");
    const plan = { ...labelled, wallRoomLabels: [...labelled.wallRoomLabels, { ...labelled.wallRoomLabels[0], id: "duplicate" }] };
    const initial = { ...initialEditorState(plan), selectedId: "top", past: [base], future: [createEmptyPlan("redo")] };
    for (const action of [
      { type: "wall-room:label-assign" as const, room, labelId: "label" },
      { type: "wall-room:label-set" as const, room, values, labelId: "third" },
    ]) {
      const rejected = editorReducer(initial, action);
      expect(rejected.error).toMatch(/Несколько сохранённых записей/);
      expect(rejected.plan).toBe(initial.plan);
      expect(rejected.past).toBe(initial.past);
      expect(rejected.future).toBe(initial.future);
      expect(rejected.selectedId).toBe(initial.selectedId);
      expect(rejected.plan.wallRoomLabels).toHaveLength(2);
    }
    const cleaned = editorReducer(initial, { type: "wall-room:label-remove", labelId: "duplicate" });
    expect(cleaned.error).toBeNull();
    expect(resolveWallRoomLabels(cleaned.plan).rooms[0].labelId).toBe("label");
    expect(cleaned.plan.wallRoomLabels).toHaveLength(1);
  });

  it("refreshes the anchor after inactive walls move before a later room partition", () => {
    const base = connectedPlan();
    const plan = setWallRoomLabel(base, detectWallRooms(base.walls).rooms[0], values, "label");
    const manual = editorReducer(initialEditorState(plan), { type: "roomMode:set", mode: "manual" });
    const translated = editorReducer(manual, { type: "replace", plan: {
      ...manual.plan,
      walls: manual.plan.walls.map((wall) => ({ ...wall, start: { x: wall.start.x + 30, y: wall.start.y }, end: { x: wall.end.x + 30, y: wall.end.y } })),
    } });
    expect(translated.plan.wallRoomLabels[0].anchor).toEqual(plan.wallRoomLabels[0].anchor);
    const active = editorReducer(translated, { type: "roomMode:set", mode: "walls" });
    expect(active.error).toBeNull();
    expect(active.plan.wallRoomLabels[0].anchor.x).toBeCloseTo(32.5);
    expect(active.plan.wallRoomLabels[0].anchor.y).toBeCloseTo(2);
    expect(active.past.at(-1)).toBe(translated.plan);
    const divided = editorReducer(active, { type: "wall:add", wall: {
      id: "partition", start: { x: 33.5, y: 0 }, end: { x: 33.5, y: 4 }, thickness: 0.2, height: 3,
    } });
    expect(divided.error).toBeNull();
    const result = resolveWallRoomLabels(divided.plan);
    expect(result.rooms).toHaveLength(2);
    expect(result.rooms[0].name).toBe("Спальня");
    expect(result.rooms[1].labelId).toBeUndefined();
    expect(result.unassigned).toEqual([]);
  });

  it("keeps a disappeared adjacent room name orphaned and restores its original binding on undo", () => {
    const base = connectedPlan();
    base.walls.push({ id: "partition", start: { x: 2.5, y: 0 }, end: { x: 2.5, y: 4 }, thickness: 0.2, height: 3 });
    const plan = setWallRoomLabel(base, detectWallRooms(base.walls).rooms[0], values, "left-label");
    const deleted = editorReducer(initialEditorState(plan), { type: "delete", id: "left" });
    expect(deleted.error).toBeNull();
    const result = resolveWallRoomLabels(deleted.plan);
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0].labelId).toBeUndefined();
    expect(result.unassigned.map((label) => label.id)).toEqual(["left-label"]);
    expect(deleted.plan.wallRoomLabels).toEqual(plan.wallRoomLabels);
    expect(deleted.past).toEqual([plan]);
    const undone = editorReducer(deleted, { type: "undo" });
    expect(undone.plan).toBe(plan);
    expect(resolveWallRoomLabels(undone.plan).rooms[0].labelId).toBe("left-label");
    expect(editorReducer(undone, { type: "redo" }).plan).toBe(deleted.plan);
  });
});

describe("selection across undo and redo", () => {
  it("keeps a selection whose object still exists and clears one that undo removed", () => {
    const initial = initialEditorState(connectedPlan());
    const moved = editorReducer(initial, { type: "wall:move", wallId: "top", delta: { x: 0, y: -0.5 } });
    expect(moved.selectedId).toBe("top");
    const undone = editorReducer(moved, { type: "undo" });
    expect(undone.selectedId).toBe("top");
    expect(editorReducer(undone, { type: "redo" }).selectedId).toBe("top");

    const added = editorReducer(initial, { type: "wall:add", wall: { id: "extra", start: { x: 10, y: 0 }, end: { x: 12, y: 0 }, thickness: 0.2, height: 3 } });
    expect(added.selectedId).toBe("extra");
    expect(editorReducer(added, { type: "undo" }).selectedId).toBeNull();

    // A wall room keeps its key while its boundary walls stay, so it stays selected.
    const room = detectWallRooms(initial.plan.walls).rooms[0];
    const roomSelected = { ...moved, selectedId: room.id };
    expect(editorReducer(roomSelected, { type: "undo" }).selectedId).toBe(room.id);
    const manual = editorReducer(initial, { type: "roomMode:set", mode: "manual" });
    expect(editorReducer({ ...manual, selectedId: room.id }, { type: "undo" }).selectedId).toBe(room.id);
    expect(editorReducer({ ...editorReducer(manual, { type: "undo" }), selectedId: room.id }, { type: "redo" }).selectedId).toBeNull();
  });
});

describe("plan requirements history", () => {
  it("adds and removes requirements in single undoable steps and rejects invalid ones without history", () => {
    const plan = connectedPlan();
    const initial = initialEditorState(plan);
    const added = editorReducer(initial, {
      type: "requirement:add",
      requirement: { id: "req", type: "room-min-area", kind: "bedroom", minArea: 10 },
    });
    expect(added.error).toBeNull();
    expect(added.plan.requirements).toEqual([{ id: "req", type: "room-min-area", kind: "bedroom", minArea: 10 }]);
    expect(added.plan.walls).toBe(added.plan.walls);
    expect(added.past).toEqual([plan]);
    const removed = editorReducer(added, { type: "requirement:remove", id: "req" });
    expect(removed.plan.requirements).toEqual([]);
    expect(editorReducer(removed, { type: "undo" }).plan).toBe(added.plan);
    for (const action of [
      { type: "requirement:add" as const, requirement: { id: "top", type: "room-not-walkthrough" as const, kind: "hall" as const } },
      { type: "requirement:add" as const, requirement: { id: "bad", type: "room-min-area" as const, kind: "hall" as const, minArea: -2 } },
      { type: "requirement:remove" as const, id: "missing" },
    ]) {
      const rejected = editorReducer(added, action);
      expect(rejected.error).not.toBeNull();
      expect(rejected.plan).toBe(added.plan);
      expect(rejected.past).toBe(added.past);
    }
  });
});

describe("whole-wall move", () => {
  const values = { name: "Спальня", kind: "bedroom" as const, color: "#aabbcc" };

  /** A partition rests on the top and bottom walls (unsplit T at both ends). */
  function dividedPlan() {
    const plan = connectedPlan();
    plan.walls.push({ id: "partition", start: { x: 2, y: 0 }, end: { x: 2, y: 4 }, thickness: 0.2, height: 3 });
    plan.openings = [{ id: "door", wallId: "partition", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0 }];
    return plan;
  }

  it("moves a partition in one undoable step, keeps it selected and its room name attached", () => {
    const base = dividedPlan();
    const left = detectWallRooms(base.walls).rooms.find((room) => room.boundaryWallIds.includes("left"))!;
    const plan = setWallRoomLabel(base, left, values, "left-label");
    const initial = { ...initialEditorState(plan), selectedId: "partition" };
    const moved = editorReducer(initial, {
      type: "wall:move", wallId: "partition", delta: { x: 1, y: 0 },
      expected: { start: { x: 2, y: 0 }, end: { x: 2, y: 4 } },
    });
    expect(moved.error).toBeNull();
    expect(moved.selectedId).toBe("partition");
    expect(moved.plan.walls.find((wall) => wall.id === "partition")).toMatchObject({ start: { x: 3, y: 0 }, end: { x: 3, y: 4 } });
    expect(moved.plan.openings).toEqual(plan.openings);
    expect(moved.past).toEqual([plan]);
    expect(moved.future).toEqual([]);
    const named = resolveWallRoomLabels(moved.plan).rooms.find((room) => room.labelId === "left-label")!;
    expect(named.name).toBe("Спальня");
    // Same boundary walls, so the same room key; the label anchor follows in the same step.
    expect(named.id).toBe(left.id);
    expect(named.area).toBeCloseTo(left.area + 3.8, 9);
    expect(moved.plan.wallRoomLabels[0].anchor).toEqual(named.labelPoint);
    const undone = editorReducer(moved, { type: "undo" });
    expect(undone.plan).toBe(plan);
    expect(editorReducer(undone, { type: "redo" }).plan).toBe(moved.plan);
  });

  it("rejects stale, detaching and invalid moves without history, keeping selection and redo", () => {
    const plan = dividedPlan();
    const initial = { ...initialEditorState(plan), selectedId: "partition", past: [connectedPlan()], future: [createEmptyPlan("redo")] };
    for (const action of [
      { type: "wall:move" as const, wallId: "partition", delta: { x: 1, y: 0 }, expected: { start: { x: 2, y: 0 }, end: { x: 2, y: 3 } } },
      { type: "wall:move" as const, wallId: "partition", delta: { x: 0, y: 1 } },
      { type: "wall:move" as const, wallId: "partition", delta: { x: Number.NaN, y: 0 } },
      { type: "wall:move" as const, wallId: "missing", delta: { x: 1, y: 0 } },
    ]) {
      const rejected = editorReducer(initial, action);
      expect(rejected.error).not.toBeNull();
      expect(rejected.plan).toBe(initial.plan);
      expect(rejected.selectedId).toBe("partition");
      expect(rejected.past).toBe(initial.past);
      expect(rejected.future).toBe(initial.future);
    }
    const unchanged = editorReducer(initial, { type: "wall:move", wallId: "partition", delta: { x: 0, y: 0 } });
    expect(unchanged.plan).toBe(initial.plan);
    expect(unchanged.past).toBe(initial.past);
    expect(unchanged.future).toBe(initial.future);
  });

  it("computes wall rooms once per action, although validation, labels, view and saving all read them", () => {
    const base = dividedPlan();
    const left = detectWallRooms(base.walls).rooms.find((room) => room.boundaryWallIds.includes("left"))!;
    const plan = setWallRoomLabel(base, left, values, "left-label");
    const initial = initialEditorState(plan);
    const before = wallRoomDetectionStats();
    // A shift no other test uses, so the new wall set is not cached yet.
    const moved = editorReducer(initial, { type: "wall:move", wallId: "partition", delta: { x: 0.73, y: 0 } });
    expect(moved.error).toBeNull();
    resolveWallRoomLabels(moved.plan); // the editor view
    floorPlanSchema.parse(moved.plan); // the record check before saving
    const undone = editorReducer(moved, { type: "undo" });
    resolveWallRoomLabels(undone.plan);
    const after = wallRoomDetectionStats();
    expect(after.computed - before.computed).toBe(1);
    expect(after.reused - before.reused).toBeGreaterThanOrEqual(3);
  });

  it("offsets a wall keeping the others' directions in one undoable step, and rejects without history", () => {
    const plan = dividedPlan();
    const initial = { ...initialEditorState(plan), selectedId: "partition" };
    // The partition runs downwards, so its normal points to -x: -1 moves it right.
    const moved = editorReducer(initial, {
      type: "wall:offset", wallId: "partition", distance: -1,
      expected: { start: { x: 2, y: 0 }, end: { x: 2, y: 4 } },
    });
    expect(moved.error).toBeNull();
    expect(moved.selectedId).toBe("partition");
    expect(moved.plan.walls.find((wall) => wall.id === "partition")).toMatchObject({ start: { x: 3, y: 0 }, end: { x: 3, y: 4 } });
    expect(moved.past).toEqual([plan]);
    expect(editorReducer(moved, { type: "undo" }).plan).toBe(plan);
    for (const action of [
      { type: "wall:offset" as const, wallId: "partition", distance: Number.NaN },
      { type: "wall:offset" as const, wallId: "partition", distance: 1, expected: { start: { x: 2, y: 0 }, end: { x: 2, y: 3 } } },
      { type: "wall:offset" as const, wallId: "top", distance: 5 },
    ]) {
      const rejected = editorReducer(initial, action);
      expect(rejected.error).not.toBeNull();
      expect(rejected.plan).toBe(initial.plan);
      expect(rejected.past).toBe(initial.past);
    }
  });
});
