import type { BuildingFacts, FloorPlan } from "./types";

/**
 * Sets the answers about the building. An answer that is not given is left out, and with
 * no answers at all the field goes away, so a plan nobody answered for stays as it was.
 */
export function withBuildingFacts(plan: FloorPlan, facts: BuildingFacts): FloorPlan {
  const answers = Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== undefined),
  ) as BuildingFacts;
  if (Object.keys(answers).length) return { ...plan, buildingFacts: answers };
  const copy = { ...plan };
  delete copy.buildingFacts;
  return copy;
}
