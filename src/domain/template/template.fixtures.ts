import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import type { ApartmentTemplate, FloorPlan } from "@/domain/floor-plan/types";
import { createVariantsExamplePlan } from "@/domain/generation/example-flat";
import { door } from "@/domain/rules/rules.fixtures";
import { untranslated } from "@/lib/i18n";
import { labelledRooms } from "./locks";
import { confirmationOf } from "./readiness";

export const AT = "2026-11-05T10:00:00.000Z";

/** The example flat with an entrance door in the outer wall of the hall. */
export function templateFlat(): FloorPlan {
  const plan = createVariantsExamplePlan();
  return { ...plan, name: untranslated("Шаблон"), openings: [...plan.openings, door("entrance", "bottom", 4.8)] };
}

export const labelOf = (plan: FloorPlan, name: string) => labelledRooms(plan).find((room) => room.name === name)!.labelId!;

/**
 * A ready template: walls confirmed, bathroom and kitchen fixed as wet zones, the entrance
 * door fixed, the living room, bedroom and hall open to the buyer with their partitions.
 */
export function readyTemplate(plan: FloorPlan = templateFlat()): FloorPlan {
  const template: ApartmentTemplate = {
    confirmed: confirmationOf(plan, AT),
    fixed: [
      { kind: "wet-zone", roomLabelId: labelOf(plan, untranslated("Санузел")) },
      { kind: "wet-zone", roomLabelId: labelOf(plan, untranslated("Кухня")) },
      { kind: "entrance-door", openingId: "entrance" },
    ],
    buyerWalls: ["living-bedroom", "living-hall", "bedroom-hall"],
    buyerRooms: [untranslated("Гостиная"), untranslated("Спальня"), untranslated("Прихожая")].map((name) => labelOf(plan, name)),
  };
  return { ...plan, template };
}

/** What a buyer gets from that template. */
export function buyerCopy(template: FloorPlan = readyTemplate()): FloorPlan {
  return {
    ...template,
    id: "buyer",
    name: untranslated("Квартира покупателя"),
    origin: createPlanOrigin(template, AT),
    purchase: { templateId: template.id, templateName: template.name, startedAt: AT },
  };
}
