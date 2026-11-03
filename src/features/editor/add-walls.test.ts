import { describe, expect, it } from "vitest";
import { addWalls, MAX_PLAN_WALLS } from "@/domain/floor-plan/construction";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import type { Wall } from "@/domain/floor-plan/types";
import { editorReducer, initialEditorState } from "./editor-state";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7 });
const square = [wall("a", 0, 0, 4, 0), wall("b", 4, 0, 4, 3), wall("c", 4, 3, 0, 3), wall("d", 0, 3, 0, 0)];

describe("adding accepted wall suggestions", () => {
  it("adds all walls as one undo step and rooms appear from them", () => {
    const initial = initialEditorState({ ...createEmptyPlan("pdf"), roomMode: "walls" });
    const added = editorReducer(initial, { type: "wall:add-many", walls: square });
    expect(added.error).toBeNull();
    expect(added.plan.walls.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(added.past).toHaveLength(1);
    expect(added.selectedId).toBeNull();
    expect(editorReducer(added, { type: "undo" }).plan.walls).toEqual([]);
  });

  it("adds none when any wall is invalid, duplicated or over the limit", () => {
    const plan = createEmptyPlan("pdf");
    expect(() => addWalls(plan, [...square, { ...square[0], id: "e", thickness: -1 }])).toThrow();
    expect(() => addWalls(plan, [square[0], square[0]])).toThrow(/уже существует/);
    expect(() => addWalls(addWalls(plan, square), [square[1]])).toThrow(/уже существует/);
    const many = Array.from({ length: MAX_PLAN_WALLS + 1 }, (_, index) => wall(`w${index}`, index, 0, index, 1));
    expect(() => addWalls(plan, many)).toThrow(/не больше 1000 стен/);
    expect(addWalls(plan, [])).toBe(plan);
    const state = initialEditorState(plan);
    const rejected = editorReducer(state, { type: "wall:add-many", walls: [square[0], square[0]] });
    expect(rejected.plan).toBe(plan);
    expect(rejected.past).toEqual([]);
    expect(rejected.error).toMatch(/уже существует/);
  });
});
