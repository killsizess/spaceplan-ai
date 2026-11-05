import { describe, expect, it } from "vitest";
import { withBuildingFacts } from "./building-facts";
import { createEmptyPlan } from "./operations";
import { floorPlanSchema } from "./schema";

describe("answers about the building", () => {
  it("keeps only the answers given, and goes away with none", () => {
    const plan = createEmptyPlan("facts");
    const answered = withBuildingFacts(plan, { region: "moscow", gasified: undefined, below: "same-layout" });
    expect(answered.buildingFacts).toEqual({ region: "moscow", below: "same-layout" });
    expect(floorPlanSchema.safeParse(answered).success).toBe(true);
    const cleared = withBuildingFacts(answered, { gasified: undefined });
    expect("buildingFacts" in cleared).toBe(false);
    expect(cleared).toEqual(plan);
  });

  it("accepts every answer, and only those", () => {
    const plan = createEmptyPlan("facts");
    expect(floorPlanSchema.safeParse({ ...plan, buildingFacts: {
      region: "other", gasified: false, woodenFloors: true, heritage: false, emergency: false, below: "no-dwelling", above: "other-layout",
    } }).success).toBe(true);
    expect(floorPlanSchema.safeParse({ ...plan, buildingFacts: { region: "spb" } }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...plan, buildingFacts: { below: "same" } }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...plan, buildingFacts: { gasified: "да" } }).success).toBe(false);
    expect(floorPlanSchema.safeParse({ ...plan, buildingFacts: { guess: true } }).success).toBe(false);
  });
});
