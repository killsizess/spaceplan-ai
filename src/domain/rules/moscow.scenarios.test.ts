import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlanFile } from "@/features/projects/project-repository";
import type { BuildingFacts, FloorPlan } from "@/domain/floor-plan/types";
import { citation, rulesForPlan } from "./engine";
import { apartment, door, labelled, variantOf, wall, window_ } from "./rules.fixtures";
import type { Procedure } from "./types";

/**
 * The test plans a specialist signs off in the document «Правила Москвы на сверку
 * специалисту». Each row there is one case here, so the document and the code cannot
 * drift apart without a failing test. `moscow.rooms.kind` is left out: a room that lost
 * its label after a wall changed is a note about the drawing, not about the rule.
 */
const known: BuildingFacts = { region: "moscow", below: "no-dwelling", above: "no-dwelling", woodenFloors: false, heritage: false, emergency: false };
const without = (plan: FloorPlan, id: string): FloorPlan => ({
  ...plan,
  walls: plan.walls.filter((item) => item.id !== id),
  openings: plan.openings.filter((item) => item.wallId !== id),
});
const moveBathroom = (plan: FloorPlan) => {
  let next: FloorPlan = { ...plan, walls: [...plan.walls, wall("w1", 0, 3, 3, 3, "partition"), wall("w2", 3, 3, 3, 6, "partition")] };
  next = labelled(next, { x: 1.5, y: 4.5 }, "Новый санузел", "bathroom");
  return labelled(next, { x: 8, y: 4.5 }, "Спальня", "bedroom");
};
const withSpine = () => {
  const plan = apartment(known);
  plan.walls.push(wall("spine", 3, 0, 3, 6, "bearing"));
  return plan;
};
const withSpineDoor = () => {
  const plan = withSpine();
  plan.openings.push(door("d", "spine", 2));
  return plan;
};
const untypedPartition = () => {
  const plan = apartment(known);
  plan.walls = plan.walls.map((item) => (item.id === "living-kitchen" ? { ...item, kind: undefined } : item));
  return plan;
};

const CASES: readonly [number, string, FloorPlan, Procedure | null, readonly string[]][] = [
  [1, "вариант без изменений", variantOf(apartment(known), (plan) => plan), null, []],
  [2, "снос наружной несущей стены", variantOf(apartment(known), (plan) => without(plan, "top")), "specialist",
    ["moscow.508.9.3", "moscow.508.2.2.5", "moscow.508.3.1", "moscow.kitchen.changed"]],
  [3, "новая несущая стена", variantOf(apartment(known), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "bearing")] })), "project",
    ["moscow.508.2.2.2"]],
  [4, "снос стены между кухней и гостиной, газ есть", variantOf(apartment({ ...known, gasified: true }), (plan) => without(plan, "living-kitchen")), "forbidden",
    ["moscow.kitchen.changed", "moscow.508.9.16"]],
  [5, "снос стены между кухней и гостиной, газа нет", variantOf(apartment({ ...known, gasified: false }), (plan) => without(plan, "living-kitchen")), "unknown",
    ["moscow.508.19.6.1", "moscow.kitchen.changed", "moscow.508.9.16"]],
  [6, "снос стены между кухней и гостиной, о газе нет ответа", variantOf(apartment(known), (plan) => without(plan, "living-kitchen")), "unknown",
    ["moscow.kitchen.changed", "moscow.508.9.16"]],
  [7, "дверь в перегородке", variantOf(apartment(known), (plan) => ({ ...plan, openings: [...plan.openings, door("d", "living-kitchen", 1)] })), "simplified",
    ["moscow.508.19.6.2"]],
  [8, "дверь во внутренней несущей стене", variantOf(withSpine(), (plan) => ({ ...plan, openings: [...plan.openings, door("d", "spine", 2)] })), "project",
    ["moscow.508.2.2.4"]],
  [9, "заделка проёма во внутренней несущей стене", variantOf(withSpineDoor(), (plan) => ({ ...plan, openings: plan.openings.filter((item) => item.id !== "d") })), "unknown",
    ["moscow.508.2.2.6"]],
  [10, "новое окно в наружной стене", variantOf(apartment(known), (plan) => ({ ...plan, openings: [...plan.openings, window_("new", "left", 1)] })), "project",
    ["moscow.508.3.1"]],
  [11, "санузел перенесён, снизу такая же планировка", variantOf(apartment({ ...known, below: "same-layout" }), moveBathroom), "forbidden",
    ["moscow.pp47.25", "moscow.508.19.6.1", "moscow.508.2.2.1", "moscow.stack"]],
  [12, "санузел перенесён, снизу и сверху квартир нет", variantOf(apartment(known), moveBathroom), "project",
    ["moscow.pp47.25", "moscow.508.19.6.1", "moscow.508.2.2.1"]],
  [13, "санузел перенесён, о соседях снизу нет ответа", variantOf(apartment({ region: "moscow", woodenFloors: false, heritage: false, emergency: false, above: "no-dwelling" }), moveBathroom), "project",
    ["moscow.pp47.25", "moscow.508.19.6.1", "moscow.508.2.2.1", "moscow.stack.unknown"]],
  [14, "новая перегородка, перекрытия не деревянные", variantOf(apartment(known), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "partition")] })), "simplified",
    ["moscow.508.19.6.1"]],
  [15, "новая перегородка, перекрытия деревянные", variantOf(apartment({ ...known, woodenFloors: true }), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "partition")] })), "project",
    ["moscow.508.2.2.10"]],
  [16, "снос стены без указанного типа", variantOf(untypedPartition(), (plan) => without(plan, "living-kitchen")), "unknown",
    ["moscow.walls.unknown", "moscow.kitchen.changed", "moscow.508.9.16"]],
  [17, "в кухне нет окна", { ...apartment(known), openings: [window_("living-window", "top", 2)] }, null, ["moscow.pp47.25"]],
  [18, "низкий потолок", { ...apartment(known), walls: apartment(known).walls.map((item) => (item.id === "top" ? { ...item, height: 2.4 } : item)) }, null, ["moscow.pp47.22", "moscow.pp47.22"]],
  [19, "дом признан аварийным", apartment({ ...known, emergency: true }), null, ["moscow.building.emergency"]],
  [20, "объект культурного наследия", apartment({ ...known, heritage: true }), null, ["moscow.building.heritage"]],
];

describe("test plans for the specialist", () => {
  for (const [number, name, plan, overall, rules] of CASES) {
    it(`${number}. ${name}`, () => {
      const report = rulesForPlan(plan)!;
      expect(report.overall).toBe(overall);
      const found = report.findings
        .filter((finding) => finding.state !== "ok" && finding.ruleId !== "moscow.rooms.kind")
        .map((finding) => finding.ruleId);
      expect(found).toEqual(rules);
    });
  }
});

describe("citations", () => {
  it("list points of one document together and keep articles apart", () => {
    const report = rulesForPlan(CASES[1][2])!;
    const cite = (id: string) => citation(report, report.findings.find((item) => item.ruleId === id)!);
    expect(cite("moscow.508.9.3")).toBe("508-ПП, прил. 1, пп. 9.3, 9.6");
    expect(cite("moscow.508.2.2.5")).toBe("508-ПП, прил. 1, п. 2.2.5; ЖК РФ, ст. 25, ч. 2; ст. 26, ч. 2, п. 3");
    const stack = rulesForPlan(CASES[12][2])!;
    expect(citation(stack, stack.findings.find((item) => item.ruleId === "moscow.stack.unknown")!)).toBe("ПП РФ № 47, п. 24; СП 54, пп. 7.20, 7.21");
  });
});

describe("the test apartment the specialist downloads", () => {
  it("opens as a project and is the apartment these cases start from", () => {
    const file = readFileSync(join(process.cwd(), "public/rules/test-apartment.json"), "utf8");
    const plan = parsePlanFile(file);
    const expected = apartment({ region: "moscow" });
    expect(plan.walls).toEqual(expected.walls);
    expect(plan.openings).toEqual(expected.openings);
    expect(plan.wallRoomLabels).toEqual(expected.wallRoomLabels);
    expect(plan.buildingFacts).toEqual({ region: "moscow" });
    expect(rulesForPlan(plan)!.region).toBe("Москва");
  });
});
