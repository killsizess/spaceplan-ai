import type { FloorPlan } from "@/domain/floor-plan/types";
import { wallKindOf } from "@/domain/floor-plan/wall-kind";
import { pluralRu } from "@/lib/format";

/**
 * The product's main scenario as a route through the plan: drawing, walls, wall types,
 * requirements, variants, report. Everything is read from the plan, so the route is
 * always true and nothing about it is stored.
 */
export type ScenarioStepId = "drawing" | "walls" | "kinds" | "requirements" | "variants" | "report";
/** `attention`: this step has something to look at. `current`: the first one not done yet. */
export type ScenarioStepState = "done" | "attention" | "current" | "todo";

export interface ScenarioStep {
  id: ScenarioStepId;
  label: string;
  state: ScenarioStepState;
  /** What stands on this step now, in a few words. */
  value: string;
}

export function scenarioSteps(input: {
  plan: FloorPlan;
  /** Wall ends that are not joined to anything. */
  freeEnds: number;
  violatedRequirements: number;
  /** Projects in the library made from this plan. */
  variants: number;
}): ScenarioStep[] {
  const { plan, freeEnds, violatedRequirements, variants } = input;
  const walls = plan.walls.length;
  const unknown = plan.walls.filter((wall) => wallKindOf(wall) === "unknown").length;
  const hasDrawing = Boolean(plan.underlay) || walls > 0 || plan.rooms.length > 0;
  const isVariant = Boolean(plan.origin);
  const steps: Omit<ScenarioStep, "state">[] & { done?: never } = [
    { id: "drawing", label: "Чертёж", value: plan.underlay ? "загружен" : hasDrawing ? "нарисован" : "DXF, PDF или вручную" },
    { id: "walls", label: "Стены", value: walls ? pluralRu(walls, "стена", "стены", "стен") : "нет" },
    { id: "kinds", label: "Типы стен", value: !walls ? "нет стен" : unknown ? `без типа ${unknown}` : "указаны" },
    { id: "requirements", label: "Требования", value: !plan.requirements.length ? "не заданы" : violatedRequirements ? `нарушено ${violatedRequirements}` : `${plan.requirements.length}, выполнены` },
    { id: "variants", label: "Варианты", value: isVariant ? "это вариант" : variants ? `${variants}` : "нет" },
    { id: "report", label: "Отчёт", value: "итог и PDF" },
  ];
  const done: Record<ScenarioStepId, boolean> = {
    drawing: hasDrawing,
    walls: walls > 0 && freeEnds === 0,
    kinds: walls > 0 && unknown === 0,
    requirements: plan.requirements.length > 0 && violatedRequirements === 0,
    variants: isVariant || variants > 0,
    report: false,
  };
  const attention: Record<ScenarioStepId, boolean> = {
    drawing: Boolean(plan.underlay && !plan.underlay.calibrated),
    walls: walls > 0 && freeEnds > 0,
    kinds: walls > 0 && unknown > 0,
    requirements: violatedRequirements > 0,
    variants: false,
    report: false,
  };
  let currentTaken = false;
  return steps.map((step) => {
    if (attention[step.id]) {
      const state: ScenarioStepState = "attention";
      currentTaken = true;
      return { ...step, state };
    }
    if (done[step.id]) return { ...step, state: "done" as const };
    if (!currentTaken) {
      currentTaken = true;
      return { ...step, state: "current" as const };
    }
    return { ...step, state: "todo" as const };
  });
}
