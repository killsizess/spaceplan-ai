import { describe, expect, it } from "vitest";
import { createEmptyPlan, createExamplePlan } from "@/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "@/domain/floor-plan/types";
import { scenarioSteps, type ScenarioStepId, type ScenarioStepState } from "./scenario-steps";

const wall = (id: string, kind?: Wall["kind"]): Wall => ({ id, start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, thickness: 0.2, height: 2.7, ...(kind ? { kind } : {}) });
const states = (plan: FloorPlan, extra: { freeEnds?: number; violatedRequirements?: number; variants?: number } = {}) => {
  const steps = scenarioSteps({ plan, freeEnds: 0, violatedRequirements: 0, variants: 0, ...extra });
  return Object.fromEntries(steps.map((step) => [step.id, step.state])) as Record<ScenarioStepId, ScenarioStepState>;
};
const value = (plan: FloorPlan, id: ScenarioStepId, extra = {}) =>
  scenarioSteps({ plan, freeEnds: 0, violatedRequirements: 0, variants: 0, ...extra }).find((step) => step.id === id)!.value;

describe("scenario route", () => {
  it("has the six steps of the main scenario, in order", () => {
    const steps = scenarioSteps({ plan: createEmptyPlan("x"), freeEnds: 0, violatedRequirements: 0, variants: 0 });
    expect(steps.map((step) => step.label)).toEqual(["Чертёж", "Стены", "Типы стен", "Требования", "Варианты", "Отчёт"]);
  });

  it("starts an empty plan at the drawing, with the rest ahead", () => {
    expect(states(createEmptyPlan("x"))).toEqual({
      drawing: "current", walls: "todo", kinds: "todo", requirements: "todo", variants: "todo", report: "todo",
    });
  });

  it("moves on as the plan fills up, and points at walls without a type", () => {
    const plan = { ...createEmptyPlan("x"), walls: [wall("a"), wall("b", "bearing")] };
    expect(states(plan)).toMatchObject({ drawing: "done", walls: "done", kinds: "attention", requirements: "todo" });
    expect(value(plan, "kinds")).toBe("без типа 1");
    expect(value(plan, "walls")).toBe("2 стены");
  });

  it("flags free wall ends, violated requirements and an uncalibrated underlay", () => {
    const plan = { ...createEmptyPlan("x"), walls: [wall("a", "bearing")], requirements: [{ id: "r", type: "room-min-area" as const, kind: "other" as const, minArea: 1 }] };
    expect(states(plan, { freeEnds: 2 }).walls).toBe("attention");
    expect(states(plan, { violatedRequirements: 1 }).requirements).toBe("attention");
    expect(value(plan, "requirements", { violatedRequirements: 1 })).toBe("нарушено 1");
    const underlay = { name: "p", dataUrl: "data:image/png;base64,AAAA", pixelWidth: 1, pixelHeight: 1, x: 0, y: 0, metersPerPixel: 1, opacity: 1, visible: true, calibrated: false };
    expect(states({ ...plan, underlay }).drawing).toBe("attention");
    expect(states({ ...plan, underlay: { ...underlay, calibrated: true } }).drawing).toBe("done");
  });

  it("counts a plan with variants, and a variant itself, as having that step done", () => {
    const plan = { ...createEmptyPlan("x"), walls: [wall("a", "bearing")] };
    expect(states(plan, { variants: 2 }).variants).toBe("done");
    expect(value(plan, "variants", { variants: 2 })).toBe("2");
    const origin = { planId: "p", planName: "П", createdAt: "2026-11-05T00:00:00.000Z", snapshot: { roomMode: "manual" as const, rooms: [], walls: [], openings: [], wallRoomLabels: [], requirements: [] } };
    expect(value({ ...plan, origin }, "variants")).toBe("это вариант");
  });

  it("never marks the report done: it is read anew each time", () => {
    const plan = createExamplePlan();
    expect(states(plan, { variants: 1 }).report).not.toBe("done");
  });
});
