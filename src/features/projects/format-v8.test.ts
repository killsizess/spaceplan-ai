import { describe, expect, it } from "vitest";
import { createExamplePlan } from "@/domain/floor-plan/operations";
import { parsePlanFile, serializePlan } from "./project-repository";

describe("format 8", () => {
  it("opens a v7 file as v8, with nothing changed and no answers invented", () => {
    const { buildingFacts: _none, ...current } = createExamplePlan();
    void _none;
    const old = { ...current, schemaVersion: 7 };
    const opened = parsePlanFile(JSON.stringify(old));
    expect(opened).toEqual({ ...old, schemaVersion: 8 });
    expect("buildingFacts" in opened).toBe(false);
  });

  it("keeps the answers about the building through a save and an open", () => {
    const plan = { ...createExamplePlan(), buildingFacts: { region: "moscow" as const, gasified: true, below: "same-layout" as const } };
    const again = parsePlanFile(serializePlan(plan));
    expect(again.buildingFacts).toEqual(plan.buildingFacts);
    expect(again.schemaVersion).toBe(8);
  });

  it("refuses a v7 file carrying a v8 field rather than blessing it", () => {
    const plan = { ...createExamplePlan(), schemaVersion: 7, buildingFacts: { region: "moscow" } };
    expect(() => parsePlanFile(JSON.stringify(plan))).toThrow();
  });

  it("refuses an unknown version", () => {
    expect(() => parsePlanFile(JSON.stringify({ ...createExamplePlan(), schemaVersion: 9 }))).toThrow(/версии от 1 до 8/);
  });
});
