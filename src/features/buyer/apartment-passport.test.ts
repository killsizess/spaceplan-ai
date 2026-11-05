import { describe, expect, it } from "vitest";
import { DISCLAIMER } from "@/domain/legal/disclaimer";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { buyerCopy, readyTemplate } from "@/domain/template/template.fixtures";
import { editorReducer, initialEditorState, type EditorAction } from "../editor/editor-state";
import type { MeasureText } from "../report/report-layout";
import { buildPassport } from "./apartment-passport";
import { layoutPassport } from "./passport-layout";

const meta = { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "9.9.9" };
const measure: MeasureText = (text, size) => text.length * size * 0.5;
const change = (plan: FloorPlan, ...actions: EditorAction[]) => {
  let state = initialEditorState(plan);
  for (const action of actions) {
    state = editorReducer(state, action);
    expect(state.error, action.type).toBeNull();
  }
  return state.plan;
};
const textOf = (plan: FloorPlan) =>
  layoutPassport(buildPassport(plan, meta)!, measure).flatMap((page) => page.ops).flatMap((op) => (op.kind === "text" ? [op.text] : [])).join(" ").replace(/\s+/g, " ");

describe("the apartment passport", () => {
  const facts = { region: "moscow" as const };
  const changed = () => change({ ...buyerCopy(readyTemplate({ ...readyTemplate(), buildingFacts: facts })), buildingFacts: facts },
    { type: "delete", id: "living-bedroom" },
    { type: "wall:add", wall: { id: "new", start: { x: 3.5, y: 0 }, end: { x: 3.5, y: 5 }, thickness: 0.1, height: 2.7, kind: "partition" } });

  it("exists only for a buyer's copy", () => {
    expect(buildPassport(readyTemplate(), meta)).toBeNull();
  });

  it("lists every change with its verdict, confidence, rule and the rule's status", () => {
    const plan = changed();
    const passport = buildPassport(plan, meta)!;
    expect(passport.changes).toHaveLength(2);
    const text = textOf(plan);
    for (const item of passport.changes) {
      expect(text).toContain(item.text);
      expect(text).toContain(`Вердикт: ${item.verdict}`);
      expect(text).toContain(`Уверенность: ${item.levelLabel}`);
      expect(text).toContain(`Статус правила: ${item.ruleStatus}`);
    }
  });

  it("lists every question and everything not confirmed", () => {
    const plan = changed();
    const passport = buildPassport(plan, meta)!;
    expect(passport.questions.length).toBeGreaterThan(0);
    expect(passport.unconfirmed.length).toBeGreaterThan(0);
    const text = textOf(plan);
    for (const question of passport.questions) expect(text).toContain(question.text);
    for (const item of passport.unconfirmed) expect(text).toContain(item.split(":")[0]);
  });

  it("carries the disclaimer from the shared file, once, and no prices", () => {
    const text = textOf(changed());
    expect(text).toContain(DISCLAIMER.slice(0, 60));
    expect(text.split(DISCLAIMER.slice(0, 40)).length - 1).toBe(1);
    expect(text).not.toMatch(/₽|руб|смет|стоимост|цен[аы]/i);
  });

  it("shows the apartment before and after", () => {
    const passport = buildPassport(changed(), meta)!;
    expect(passport.before.rooms.length).toBe(5);
    expect(passport.after.rooms.length).toBe(5);
    expect(passport.after.area).not.toBeNull();
  });

  it("says so when nothing was changed", () => {
    expect(textOf(buyerCopy())).toContain("Изменений нет");
  });
});
