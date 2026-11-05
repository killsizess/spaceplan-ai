import { tr } from "@/lib/i18n";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { apartment } from "./rules.fixtures";

/** The apartment of the sign-off document, opened as a project of its own. */
export function createRulesExamplePlan(): FloorPlan {
  return { ...apartment({ region: "moscow" }), name: tr`Тестовая квартира для сверки` };
}
