import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "@/domain/floor-plan/types";
import { bearingWallChanges } from "@/domain/floor-plan/wall-kind";
import { bearingChangeMessage } from "./bearing-guard";
import { editorReducer, initialEditorState } from "./editor-state";

function wall(id: string, x1: number, y1: number, x2: number, y2: number, kind?: Wall["kind"]): Wall {
  return { id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 3, ...(kind ? { kind } : {}) };
}

/** A closed 5 × 4 room: walls 1 and 3 (top, bottom) are bearing, 2 and 4 are partitions or unknown. */
function room(): FloorPlan {
  return {
    ...createEmptyPlan("guard"),
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 5, 0, "bearing"),
      wall("right", 5, 0, 5, 4, "partition"),
      wall("bottom", 5, 4, 0, 4, "bearing"),
      wall("left", 0, 4, 0, 0),
    ],
  };
}

const stateOf = (plan: FloorPlan) => initialEditorState(plan);

describe("bearing wall guard", () => {
  it("warns before a bearing wall is deleted, naming its number", () => {
    const message = bearingChangeMessage(stateOf(room()), { type: "delete", id: "bottom" });
    expect(message).toMatch(/несущую стену/);
    expect(message).toMatch(/Стена 3: будет удалена/);
    expect(message).not.toMatch(/Стена 1/);
  });

  it("warns before a bearing wall is moved by offset, and for each bearing wall touched", () => {
    const state = stateOf(room());
    const offset = bearingChangeMessage(state, { type: "wall:offset", wallId: "top", distance: -0.5 });
    expect(offset).toMatch(/Стена 1: будет перенесена/);
    const nodeMove = bearingChangeMessage(state, {
      type: "wall:node-move", wallId: "right", endpoint: "end", point: { x: 5, y: 3 },
    });
    expect(nodeMove).toMatch(/Стена 3/);
  });

  it("warns when a bearing mark is removed, but not when one is added or left as it is", () => {
    const state = stateOf(room());
    expect(bearingChangeMessage(state, { type: "wall:set-kind", wallId: "top", kind: "unknown" }))
      .toMatch(/Стена 1: перестанет считаться несущей/);
    expect(bearingChangeMessage(state, { type: "wall:set-kind", wallId: "top", kind: "partition" }))
      .toMatch(/Стена 1: перестанет считаться несущей/);
    expect(bearingChangeMessage(state, { type: "wall:set-kind", wallId: "left", kind: "bearing" })).toBeNull();
    expect(bearingChangeMessage(state, { type: "wall:set-kind", wallId: "top", kind: "bearing" })).toBeNull();
  });

  it("stays silent for walls that are not bearing and for plans without bearing walls", () => {
    const state = stateOf(room());
    expect(bearingChangeMessage(state, { type: "delete", id: "left" })).toBeNull();
    const plain = stateOf({ ...room(), walls: room().walls.map(({ kind: _k, ...rest }) => { void _k; return rest; }) });
    expect(bearingChangeMessage(plain, { type: "delete", id: "top" })).toBeNull();
  });

  it("stays silent for actions that are not edits of a wall, and for edits that would fail", () => {
    const state = stateOf(room());
    expect(bearingChangeMessage(state, { type: "select", id: "top" })).toBeNull();
    expect(bearingChangeMessage(state, { type: "undo" })).toBeNull();
    expect(bearingChangeMessage(state, { type: "delete", id: "missing" })).toBeNull();
    // An invalid move is refused by the reducer itself, so there is nothing to confirm.
    expect(bearingChangeMessage(state, { type: "wall:offset", wallId: "top", distance: 5000 })).toBeNull();
  });

  it("is a preview only: the state it was given is not changed", () => {
    const state = stateOf(room());
    bearingChangeMessage(state, { type: "delete", id: "top" });
    expect(state.plan.walls).toHaveLength(4);
    expect(state.past).toHaveLength(0);
  });

  it("compares plans, so the confirmed action leaves exactly the reported changes", () => {
    const state = stateOf(room());
    const action = { type: "delete" as const, id: "top" };
    const after = editorReducer(state, action);
    expect(bearingWallChanges(state.plan, after.plan)).toEqual([{ wallId: "top", number: 1, change: "deleted" }]);
    // Undo restores the plan without asking: it is returning to what the user already had.
    const undone = editorReducer(after, { type: "undo" });
    expect(bearingWallChanges(after.plan, undone.plan)).toEqual([]);
    expect(bearingChangeMessage(after, { type: "undo" })).toBeNull();
  });

  it("treats a reversed wall as unmoved and a thickness change as a change", () => {
    const before = room();
    const reversed = { ...before, walls: before.walls.map((item) => item.id === "top" ? { ...item, start: item.end, end: item.start } : item) };
    expect(bearingWallChanges(before, reversed)).toEqual([]);
    const thicker = { ...before, walls: before.walls.map((item) => item.id === "top" ? { ...item, thickness: 0.3 } : item) };
    expect(bearingWallChanges(before, thicker)).toEqual([{ wallId: "top", number: 1, change: "thickness" }]);
  });
});
