import { describe, expect, it } from "vitest";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { editorReducer, initialEditorState, type EditorAction } from "@/features/editor/editor-state";
import { parsePlanFile, serializePlan } from "@/features/projects/project-repository";
import { buyerProblems } from "./buyer-guard";
import { lockedWallIds, wallLock } from "./locks";
import { suggestedBuyerWalls, suggestedWetZones, templateReadiness } from "./readiness";
import { AT, buyerCopy, labelOf, readyTemplate, templateFlat } from "./template.fixtures";

const issueIds = (plan: FloorPlan) => templateReadiness(plan).issues.filter((issue) => issue.severity === "blocker").map((issue) => issue.id);
const wallOf = (plan: FloorPlan, id: string) => plan.walls.find((wall) => wall.id === id)!;

describe("a template's readiness for a buyer", () => {
  it("is ready once walls are confirmed, types set and fixed elements marked", () => {
    const readiness = templateReadiness(readyTemplate());
    expect(readiness.ready).toBe(true);
    expect(readiness.counts).toMatchObject({ unknownWalls: 0, fixed: 3, buyerWalls: 3 });
  });

  it("is not ready without confirmed walls or fixed elements, and says what to do", () => {
    const readiness = templateReadiness(templateFlat());
    expect(readiness.ready).toBe(false);
    expect(issueIds(templateFlat())).toEqual(expect.arrayContaining(["not-confirmed", "no-fixed"]));
    for (const issue of readiness.issues) expect(issue.fix.length, issue.id).toBeGreaterThan(10);
  });

  it("is not ready while any wall is of unknown type, and names it", () => {
    const plan = readyTemplate();
    const unknown = { ...plan, walls: plan.walls.map((wall) => (wall.id === "living-bedroom" ? { ...wall, kind: "unknown" as const } : wall)) };
    const readiness = templateReadiness(unknown);
    expect(readiness.ready).toBe(false);
    const issue = readiness.issues.find((item) => item.id === "unknown-walls")!;
    expect(issue.title).toContain("5");
    expect(issue.targets).toEqual(["living-bedroom"]);
  });

  it("is not ready with a room that has lost its closed outline", () => {
    const plan = readyTemplate();
    const open = { ...plan, walls: plan.walls.filter((wall) => wall.id !== "hall-bath") };
    expect(issueIds(open)).toContain("rooms-open");
  });

  it("is not ready with rooms entered by hand", () => {
    expect(issueIds({ ...readyTemplate(), roomMode: "manual" })).toContain("rooms-manual");
  });

  it("wants walls confirmed again after they change", () => {
    const plan = readyTemplate();
    const moved = { ...plan, walls: plan.walls.map((wall) => (wall.id === "living-bedroom" ? { ...wall, start: { x: 7.5, y: 0 }, end: { x: 7.5, y: 5 } } : wall)) };
    expect(issueIds(moved)).toContain("changed-after-confirmation");
  });

  it("suggests wet zones and the partitions a buyer could be allowed", () => {
    const plan = templateFlat();
    expect(suggestedWetZones(plan).sort()).toEqual([labelOf(plan, "Кухня"), labelOf(plan, "Санузел")].sort());
    const ready = readyTemplate(plan);
    const suggested = suggestedBuyerWalls(ready, ready.template!);
    expect(suggested).toContain("living-bedroom");
    expect(suggested).not.toContain("hall-bath");
    expect(suggested).not.toContain("top");
  });

  it("travels with the project", () => {
    const plan = readyTemplate();
    expect(parsePlanFile(serializePlan(plan)).template).toEqual(plan.template);
  });
});

describe("what a buyer may change", () => {
  const plan = readyTemplate();

  it("locks bearing walls, walls of unknown type, walls of fixed rooms and walls not allowed", () => {
    const reason = (id: string) => wallLock(plan.template!, plan, wallOf(plan, id));
    expect(reason("top")).toMatchObject({ locked: true, reason: expect.stringContaining("Несущая стена") });
    expect(reason("hall-bath")).toMatchObject({ locked: true, reason: expect.stringContaining("Санузел") });
    expect(reason("living-kitchen")).toMatchObject({ locked: true, reason: expect.stringContaining("Кухня") });
    expect(reason("living-bedroom")).toEqual({ locked: false, reason: "" });
    const unknown = { ...plan, walls: plan.walls.map((wall) => (wall.id === "living-bedroom" ? { ...wall, kind: "unknown" as const } : wall)) };
    expect(wallLock(plan.template!, unknown, wallOf(unknown, "living-bedroom"))).toMatchObject({ locked: true, reason: expect.stringContaining("не указал") });
    const notAllowed = { ...plan, template: { ...plan.template!, buyerWalls: [] } };
    expect(wallLock(notAllowed.template, notAllowed, wallOf(plan, "living-bedroom"))).toMatchObject({ locked: true, reason: expect.stringContaining("не разрешил") });
  });

  it("locks a piece of a locked wall split by a joint as the wall itself", () => {
    const piece = { ...wallOf(plan, "top"), id: "piece", end: { x: 6, y: 0 } };
    expect(wallLock(plan.template!, plan, piece).locked).toBe(true);
    expect(lockedWallIds({ ...plan, walls: [...plan.walls, piece] }, plan, plan.template!).has("piece")).toBe(true);
  });
});

describe("a buyer's changes", () => {
  const start = () => initialEditorState(buyerCopy());
  const act = (action: EditorAction, state = start()) => editorReducer(state, action);
  const refused = (action: EditorAction, words: string) => {
    const before = start();
    const after = act(action, before);
    expect(after.plan, words).toBe(before.plan);
    expect(after.error, words).toContain(words);
  };

  it("refuses to touch a bearing wall and explains why", () => {
    refused({ type: "delete", id: "top" }, "Несущая стена");
    refused({ type: "wall:move", wallId: "right", delta: { x: 0.5, y: 0 } }, "Несущая стена");
  });

  it("refuses to change a wall type, a fixed room or the entrance door", () => {
    refused({ type: "wall:set-kind", wallId: "living-bedroom", kind: "bearing" }, "Тип стены задаёт застройщик");
    refused({ type: "wall:move", wallId: "hall-bath", delta: { x: 0.5, y: 0 } }, "Санузел");
    refused({ type: "delete", id: "entrance" }, "Входную дверь");
  });

  it("refuses what only the developer sets", () => {
    refused({ type: "template:set", template: null }, "только застройщик");
    refused({ type: "profile:set", profile: { prompt: "x", rules: [], notUnderstood: [] } }, "Правила застройщика");
  });

  it("lets the buyer move or remove an allowed partition", () => {
    const moved = act({ type: "wall:move", wallId: "living-bedroom", delta: { x: 0.5, y: 0 } });
    expect(moved.error).toBeNull();
    expect(wallOf(moved.plan, "living-bedroom").start.x).toBeCloseTo(7.5, 9);
    const removed = act({ type: "delete", id: "living-bedroom" });
    expect(removed.error).toBeNull();
    expect(removed.plan.walls.some((wall) => wall.id === "living-bedroom")).toBe(false);
  });

  it("lets the buyer add a partition inside an allowed room, and only there", () => {
    const partition = { id: "new", start: { x: 3.5, y: 0 }, end: { x: 3.5, y: 5 }, thickness: 0.1, height: 2.7, kind: "partition" as const };
    expect(act({ type: "wall:add", wall: partition }).error).toBeNull();
    refused({ type: "wall:add", wall: { ...partition, kind: "bearing" } }, "только перегородкой");
    refused({ type: "wall:add", wall: { ...partition, start: { x: 2, y: 5 }, end: { x: 2, y: 7.5 } } }, "только внутри помещений");
  });

  it("lets the buyer answer questions about the building and set their own requirements", () => {
    expect(act({ type: "facts:set", facts: { ...buyerCopy().buildingFacts!, gasified: true } }).error).toBeNull();
    expect(act({ type: "requirement:add", requirement: { id: "r", type: "room-min-area", kind: "kitchen", minArea: 8 } }).error).toBeNull();
  });

  it("renames only rooms the developer allowed", () => {
    const plan = buyerCopy();
    const bathroom = plan.wallRoomLabels.find((label) => label.name === "Санузел")!;
    const living = plan.wallRoomLabels.find((label) => label.name === "Гостиная")!;
    const rename = (labelId: string, name: string): EditorAction => ({ type: "replace", plan: { ...plan, wallRoomLabels: plan.wallRoomLabels.map((label) => (label.id === labelId ? { ...label, name } : label)) } });
    expect(act(rename(living.id, "Зал")).error).toBeNull();
    expect(act(rename(bathroom.id, "Ванная")).error).toContain("Санузел");
  });

  it("does not lock the buyer out because of a problem the template already had", () => {
    const plan = buyerCopy();
    const odd = { ...plan, walls: plan.walls.map((wall) => (wall.id === "bedroom-bath" ? { ...wall, height: 2.5 } : wall)) };
    expect(buyerProblems(odd).length).toBeGreaterThan(0);
    const state = editorReducer(initialEditorState(odd), { type: "wall:move", wallId: "living-bedroom", delta: { x: 0.5, y: 0 } });
    expect(state.error).toBeNull();
  });
});

describe("undoing one change of many", () => {
  const changed = () => {
    let state = initialEditorState(buyerCopy());
    state = editorReducer(state, { type: "delete", id: "living-bedroom" });
    state = editorReducer(state, { type: "wall:add", wall: { id: "new", start: { x: 3.5, y: 0 }, end: { x: 3.5, y: 5 }, thickness: 0.1, height: 2.7, kind: "partition" } });
    expect(state.error).toBeNull();
    return state;
  };

  it("brings back a removed wall, its doors and its room, and keeps the other change", () => {
    const state = editorReducer(changed(), { type: "buyer:revert", changeId: "wall:living-bedroom" });
    expect(state.error).toBeNull();
    expect(state.plan.walls.some((wall) => wall.id === "living-bedroom")).toBe(true);
    expect(state.plan.walls.some((wall) => wall.id === "new")).toBe(true);
    expect(state.plan.wallRoomLabels.map((label) => label.name)).toEqual(expect.arrayContaining(["Гостиная", "Спальня"]));
  });

  it("removes an added wall and restores a moved one", () => {
    const withoutNew = editorReducer(changed(), { type: "buyer:revert", changeId: "wall:new" });
    expect(withoutNew.error).toBeNull();
    expect(withoutNew.plan.walls.some((wall) => wall.id === "new")).toBe(false);
    let state = initialEditorState(buyerCopy());
    state = editorReducer(state, { type: "wall:move", wallId: "living-bedroom", delta: { x: 0.5, y: 0 } });
    state = editorReducer(state, { type: "buyer:revert", changeId: "wall:living-bedroom" });
    expect(state.error).toBeNull();
    expect(wallOf(state.plan, "living-bedroom").start.x).toBeCloseTo(7, 9);
  });

  it("explains when a change cannot be undone on its own", () => {
    let state = initialEditorState(buyerCopy());
    state = editorReducer(state, { type: "delete", id: "living-hall" });
    expect(state.error).toBeNull();
    const before = state.plan;
    state = editorReducer(state, { type: "buyer:revert", changeId: "opening:living-door" });
    expect(state.plan).toBe(before);
    expect(state.error).toContain("Сначала верните стену");
  });

  it("is a step of its own that can be undone", () => {
    const state = editorReducer(changed(), { type: "buyer:revert", changeId: "wall:new" });
    const back = editorReducer(state, { type: "undo" });
    expect(back.plan.walls.some((wall) => wall.id === "new")).toBe(true);
  });

  it("is the same plan as the template when every change is undone", () => {
    let state = changed();
    state = editorReducer(state, { type: "buyer:revert", changeId: "wall:new" });
    state = editorReducer(state, { type: "buyer:revert", changeId: "wall:living-bedroom" });
    expect(state.error).toBeNull();
    const template = readyTemplate();
    const ids = (plan: FloorPlan) => plan.walls.map((wall) => wall.id).sort();
    expect(ids(state.plan)).toEqual(ids(template));
    expect(state.plan.wallRoomLabels.map((label) => label.name).sort()).toEqual(template.wallRoomLabels.map((label) => label.name).sort());
    void AT;
  });
});
