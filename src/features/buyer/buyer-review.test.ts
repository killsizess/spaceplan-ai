import { describe, expect, it } from "vitest";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { buyerCopy, readyTemplate, templateFlat } from "@/domain/template/template.fixtures";
import { editorReducer, initialEditorState, type EditorAction } from "../editor/editor-state";
import { buildBuyerReview, buyerHighlights } from "./buyer-review";

const meta = { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" };
const change = (plan: FloorPlan, ...actions: EditorAction[]) => {
  let state = initialEditorState(plan);
  for (const action of actions) {
    state = editorReducer(state, action);
    expect(state.error, action.type).toBeNull();
  }
  return state.plan;
};
const review = (plan: FloorPlan) => buildBuyerReview(plan, meta)!;

describe("the check after each change of a buyer", () => {
  it("is not there for a plan that is not a buyer's copy", () => {
    expect(buildBuyerReview(readyTemplate(), meta)).toBeNull();
  });

  it("gives every change a verdict, how sure it is, and the rule with its status", () => {
    const plan = change(buyerCopy(),
      { type: "delete", id: "living-bedroom" },
      { type: "wall:add", wall: { id: "new", start: { x: 3.5, y: 0 }, end: { x: 3.5, y: 5 }, thickness: 0.1, height: 2.7, kind: "partition" } });
    const { changes } = review(plan);
    expect(changes.map((item) => item.id).sort()).toEqual(["wall:living-bedroom", "wall:new"]);
    for (const item of changes) {
      expect(item.verdict, item.text).toBeTruthy();
      expect(item.levelLabel, item.text).toBeTruthy();
      expect(item.rule, item.text).toBeTruthy();
      expect(item.ruleStatus, item.text).toBeTruthy();
    }
    const removed = changes.find((item) => item.id === "wall:living-bedroom")!;
    expect(removed).toMatchObject({ procedure: "simplified", verdict: "Упрощённый порядок", level: "assumption" });
    expect(removed.rule).toContain("508-ПП");
    expect(removed.ruleStatus).toContain("черновик");
  });

  it("never says a change is allowed, and says «Не определено» where no rule speaks", () => {
    const plan = change({ ...buyerCopy(), buildingFacts: undefined } as FloorPlan, { type: "delete", id: "living-bedroom" });
    const [item] = review(plan).changes;
    expect(item).toMatchObject({ procedure: null, verdict: "Не определено", level: "undetermined" });
    expect(item.rule).toContain("Ни одно правило");
    expect(JSON.stringify(review(plan)).toLowerCase()).not.toMatch(/допустимо|разрешено/);
  });

  it("asks only what something depends on, and an answer changes the check", () => {
    const facts = { region: "moscow" as const };
    const plan = change({ ...buyerCopy(readyTemplate({ ...templateFlat(), buildingFacts: facts })), buildingFacts: facts }, { type: "delete", id: "living-bedroom" });
    const before = review(plan);
    const gas = before.questions.find((question) => question.id === "fact:woodenFloors")!;
    expect(gas).toMatchObject({ to: "buyer", answer: { key: "woodenFloors" } });
    expect(gas.why.join(" ")).toContain("Убрать стену 5");
    expect(before.changes[0].verdict).toBe("Упрощённый порядок");

    // Timber floors: partitions then need a project, and the check says so at once.
    const answered = change(plan, { type: "facts:set", facts: { ...facts, gasified: false, woodenFloors: true, heritage: false, emergency: false } });
    const after = review(answered);
    expect(after.questions.some((question) => question.id === "fact:woodenFloors")).toBe(false);
    expect(after.changes[0].verdict).toBe("Нужен проект");
    expect(after.unconfirmed.join(" ")).toContain("ответ покупателя");
  });

  it("asks the developer to confirm walls a conclusion rests on", () => {
    const template = readyTemplate();
    const unconfirmed = { ...template, template: { ...template.template!, confirmed: undefined } };
    const plan = change(buyerCopy(unconfirmed), { type: "delete", id: "living-bedroom" });
    const question = review(plan).questions.find((item) => item.id === "confirm-walls")!;
    expect(question.to).toBe("developer");
    expect(question.why.join(" ")).toContain("Убрать стену 5");
    expect(review(plan).unconfirmed.join(" ")).toContain("не подтвердил");
  });

  it("explains requirements that cannot hold together, and what to change", () => {
    const plan = change(buyerCopy(),
      { type: "requirement:add", requirement: { id: "min", type: "room-min-area", kind: "bedroom", minArea: 30 } },
      { type: "requirement:add", requirement: { id: "max", type: "room-max-area", kind: "bedroom", maxArea: 20 } });
    const [conflict] = review(plan).conflicts;
    expect(conflict.text).toContain("минимальная площадь больше максимальной");
    expect(conflict.fix).toContain("Измените одно из требований");
  });

  it("explains a requirement a fixed room keeps from holding", () => {
    const plan = change(buyerCopy(), { type: "requirement:add", requirement: { id: "big", type: "room-min-area", kind: "kitchen", minArea: 20 } });
    const conflict = review(plan).conflicts.find((item) => item.text.includes("зафиксировал"))!;
    expect(conflict.text).toContain("Кухня");
    expect(conflict.fix).toContain("менять нельзя");
  });

  it("marks changed walls by verdict and keeps removed walls to draw", () => {
    const plan = change(buyerCopy(), { type: "delete", id: "living-bedroom" });
    const highlights = buyerHighlights(plan, review(plan));
    expect(highlights.removed.map((item) => item.wall.id)).toEqual(["living-bedroom"]);
    expect(highlights.removed[0].tone).toBe("ok");
  });

  it("reports the lowest confidence over all changes", () => {
    const plan = change(buyerCopy(), { type: "delete", id: "living-bedroom" });
    expect(review(plan).lowestLevel).toBe("assumption");
    expect(review(buyerCopy()).lowestLevel).toBeNull();
  });
});
