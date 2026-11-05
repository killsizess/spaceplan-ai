import { tr } from "@/lib/i18n";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { wallKindOf } from "@/domain/floor-plan/wall-kind";
import type { RuleReport } from "@/domain/rules/types";
import { pluralRu } from "@/lib/format";

/**
 * The product's main scenario as a route through the plan: drawing, walls, wall types,
 * requirements, norms, variants, report. Everything is read from the plan, so the route is
 * always true and nothing about it is stored.
 */
export type ScenarioStepId = "drawing" | "walls" | "kinds" | "requirements" | "norms" | "variants" | "report";
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
  /** The rule report for the plan, or null when no rule base applies. */
  rules?: RuleReport | null;
}): ScenarioStep[] {
  const { plan, freeEnds, violatedRequirements, variants, rules = null } = input;
  const region = plan.buildingFacts?.region;
  const ruleProblems = rules ? rules.findings.filter((finding) => finding.state === "problem").length : 0;
  const ruleQuestions = rules ? rules.missingFacts.length : 0;
  const normsValue = !region
    ? tr`регион не указан`
    : !rules
      ? tr`правила не заданы`
      : ruleProblems
        ? tr`замечаний ${ruleProblems}`
        : ruleQuestions
          ? tr`вопросов ${ruleQuestions}`
          : tr`без замечаний`;
  const walls = plan.walls.length;
  const unknown = plan.walls.filter((wall) => wallKindOf(wall) === "unknown").length;
  const hasDrawing = Boolean(plan.underlay) || walls > 0 || plan.rooms.length > 0;
  const isVariant = Boolean(plan.origin);
  const steps: Omit<ScenarioStep, "state">[] & { done?: never } = [
    { id: "drawing", label: tr`Чертёж`, value: plan.underlay ? tr`загружен` : hasDrawing ? tr`нарисован` : tr`DXF, PDF или вручную` },
    { id: "walls", label: tr`Стены`, value: walls ? pluralRu(walls, tr`стена`, tr`стены`, tr`стен`) : tr`нет` },
    { id: "kinds", label: tr`Типы стен`, value: !walls ? tr`нет стен` : unknown ? tr`без типа ${unknown}` : tr`указаны` },
    { id: "requirements", label: tr`Требования`, value: !plan.requirements.length ? tr`не заданы` : violatedRequirements ? tr`нарушено ${violatedRequirements}` : tr`${plan.requirements.length}, выполнены` },
    { id: "norms", label: tr`Нормы`, value: normsValue },
    { id: "variants", label: tr`Варианты`, value: isVariant ? tr`это вариант` : variants ? `${variants}` : tr`нет` },
    { id: "report", label: tr`Отчёт`, value: tr`итог и PDF` },
  ];
  const done: Record<ScenarioStepId, boolean> = {
    drawing: hasDrawing,
    walls: walls > 0 && freeEnds === 0,
    kinds: walls > 0 && unknown === 0,
    requirements: plan.requirements.length > 0 && violatedRequirements === 0,
    norms: Boolean(rules) && !ruleProblems && !ruleQuestions,
    variants: isVariant || variants > 0,
    report: false,
  };
  const attention: Record<ScenarioStepId, boolean> = {
    drawing: Boolean(plan.underlay && !plan.underlay.calibrated),
    walls: walls > 0 && freeEnds > 0,
    kinds: walls > 0 && unknown > 0,
    requirements: violatedRequirements > 0,
    norms: ruleProblems > 0,
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
