import { tr } from "@/lib/i18n";
import { diffPlans } from "./plan-diff";
import type { FloorPlan, PlanOrigin, PlanSnapshot } from "./types";

/** The geometry of a plan, copied: no underlay image and no origin of its own. */
export function snapshotOfPlan(plan: FloorPlan): PlanSnapshot {
  return structuredClone({
    roomMode: plan.roomMode,
    rooms: plan.rooms,
    walls: plan.walls,
    openings: plan.openings,
    wallRoomLabels: plan.wallRoomLabels,
    requirements: plan.requirements,
  });
}

/** What a variant remembers about the plan it was made from. */
export function createPlanOrigin(source: FloorPlan, createdAt: string): PlanOrigin {
  return {
    planId: source.id,
    planName: source.name,
    createdAt,
    snapshot: snapshotOfPlan(source),
  };
}

/** The source plan as it was when the variant was made, usable wherever a plan is compared. */
export function planFromOrigin(origin: PlanOrigin): FloorPlan {
  return {
    schemaVersion: 10,
    unit: "m",
    id: origin.planId,
    name: origin.planName,
    ...structuredClone(origin.snapshot),
  };
}

/**
 * What became of the source project since the variant was made:
 * `unchanged` — still in the library with the same geometry;
 * `changed` — still there, but edited afterwards;
 * `missing` — no longer in the library (deleted or in the trash).
 */
export type OriginStatus = "unchanged" | "changed" | "missing";

export function originStatus(origin: PlanOrigin, library: readonly FloorPlan[]): OriginStatus {
  const found = library.find((plan) => plan.id === origin.planId);
  if (!found) return "missing";
  return diffPlans(planFromOrigin(origin), found).identical ? "unchanged" : "changed";
}

/** The sentence the compare dialog shows about the source project; never an error. */
export function originNote(origin: PlanOrigin, status: OriginStatus): string {
  const date = origin.createdAt.slice(0, 10);
  if (status === "missing") {
    return tr`Исходного проекта «${origin.planName}» больше нет в библиотеке: он удалён или лежит в корзине. Сравнение идёт с сохранённым слепком его плана на ${date}, когда был создан вариант.`;
  }
  if (status === "changed") {
    return tr`Исходный проект «${origin.planName}» изменён после создания варианта. Сравнение идёт с его планом на ${date}, а не с нынешним.`;
  }
  return tr`Вариант создан из проекта «${origin.planName}» ${date}; с тех пор тот проект не менялся.`;
}
