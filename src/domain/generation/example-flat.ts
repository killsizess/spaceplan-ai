import { createEmptyPlan } from "@/domain/floor-plan/operations";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { door, labelled, wall, window_ } from "@/domain/rules/rules.fixtures";

/**
 * A 12 × 7.5 m flat with room to change: wall types marked and building questions answered,
 * so the generator can be tried, and shown, without drawing or answering anything first.
 */
export function createVariantsExamplePlan(): FloorPlan {
  let plan: FloorPlan = {
    ...createEmptyPlan("variants-example"),
    name: "Пример для подбора вариантов",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 12, 0, "bearing"),
      wall("right", 12, 0, 12, 7.5, "bearing"),
      wall("bottom", 12, 7.5, 0, 7.5, "bearing"),
      wall("left", 0, 7.5, 0, 0, "bearing"),
      wall("living-bedroom", 7, 0, 7, 5, "partition"),
      wall("living-kitchen", 0, 5, 4.5, 5, "partition"),
      wall("living-hall", 4.5, 5, 7, 5, "partition"),
      wall("bedroom-hall", 7, 5, 9, 5, "partition"),
      wall("bedroom-bath", 9, 5, 12, 5, "partition"),
      wall("kitchen-hall", 4.5, 5, 4.5, 7.5, "partition"),
      wall("hall-bath", 9, 5, 9, 7.5, "partition"),
    ],
    openings: [
      window_("living-window-1", "top", 1),
      window_("living-window-2", "top", 4.8),
      window_("bedroom-window", "top", 9),
      window_("kitchen-window", "bottom", 9.15),
      door("living-door", "living-hall", 0.8),
      door("bedroom-door", "bedroom-hall", 0.5),
      door("kitchen-door", "kitchen-hall", 0.8),
      door("bath-door", "hall-bath", 0.8, 0.8),
    ],
    buildingFacts: {
      region: "moscow",
      gasified: false,
      woodenFloors: false,
      heritage: false,
      emergency: false,
      below: "no-dwelling",
      above: "no-dwelling",
    },
  };
  plan = labelled(plan, { x: 3.5, y: 2.5 }, "Гостиная", "living");
  plan = labelled(plan, { x: 9.5, y: 2.5 }, "Спальня", "bedroom");
  plan = labelled(plan, { x: 2.25, y: 6.25 }, "Кухня", "kitchen");
  plan = labelled(plan, { x: 6.75, y: 6.25 }, "Прихожая", "hall");
  plan = labelled(plan, { x: 10.5, y: 6.25 }, "Санузел", "bathroom");
  return plan;
}
