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

/** The apartment with a loggia along part of the bottom wall, behind a partition of its own. */
const withLoggia = (facts: BuildingFacts = known) => {
  let plan: FloorPlan = {
    ...apartment(facts),
    walls: [
      ...apartment(facts).walls.filter((item) => item.id !== "bottom"),
      wall("bottom-a", 10, 6, 4, 6, "bearing"),
      wall("bottom-b", 4, 6, 0, 6, "partition"),
      wall("l1", 0, 6, 0, 7.5, "partition"),
      wall("l2", 0, 7.5, 4, 7.5, "partition"),
      wall("l3", 4, 7.5, 4, 6, "partition"),
    ],
  };
  plan = labelled(plan, { x: 2, y: 6.8 }, "Лоджия", "balcony");
  return plan;
};
/** The apartment with a ventilation shaft in the corner of the kitchen. */
const withShaft = (facts: BuildingFacts = known) => {
  let plan: FloorPlan = {
    ...apartment(facts),
    walls: [...apartment(facts).walls, wall("s1", 9, 0, 9, 1, "partition"), wall("s2", 9, 1, 10, 1, "partition")],
  };
  plan = labelled(plan, { x: 9.5, y: 0.5 }, "Вентшахта", "shaft");
  return labelled(plan, { x: 7, y: 2 }, "Кухня", "kitchen");
};
const doorlessPassage = (facts: BuildingFacts) => ({
  ...apartment(facts),
  openings: [...apartment(facts).openings, { ...door("d", "living-kitchen", 1), doorless: true as const }],
});
const newLoggia = (plan: FloorPlan) => labelled(
  { ...plan, walls: [...plan.walls, wall("n1", 10, 6, 10, 7, "partition"), wall("n2", 10, 7, 7, 7, "partition"), wall("n3", 7, 7, 7, 6, "partition")] },
  { x: 8.5, y: 6.5 }, "Новая лоджия", "balcony",
);

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
  [21, "снос стены между гостиной и лоджией", variantOf(withLoggia(), (plan) => without(plan, "bottom-b")), "forbidden", ["moscow.508.9.18"]],
  [22, "лоджия названа жилой комнатой", variantOf(withLoggia(), (plan) => labelled(plan, { x: 2, y: 6.8 }, "Кабинет", "bedroom")), "forbidden", ["moscow.sp54.5.11", "moscow.pp47.25", "moscow.508.9.18"]],
  [23, "новая лоджия, второй и выше этаж", variantOf({ ...withLoggia({ ...known, floorLevel: "upper" }) }, newLoggia), "forbidden", ["moscow.508.2.2.5", "moscow.508.9.13"]],
  [24, "новая лоджия, первый этаж", variantOf({ ...withLoggia({ ...known, floorLevel: "first" }) }, newLoggia), "project", ["moscow.508.2.2.5", "moscow.508.3.5"]],
  [25, "новая лоджия, этаж неизвестен", variantOf(withLoggia(), newLoggia), "project", ["moscow.508.2.2.5", "moscow.508.9.13"]],
  [26, "дверь из гостиной на лоджию", variantOf(withLoggia(), (plan) => ({ ...plan, openings: [...plan.openings, door("d", "bottom-b", 1)] })), "project", ["moscow.508.2.2.14"]],
  [27, "вентшахта убрана", variantOf(withShaft(), (plan) => without(without(plan, "s1"), "s2")), "forbidden", ["moscow.kitchen.changed", "moscow.508.9.5"]],
  [28, "вентшахта сохранена, новая дверь в кухню", variantOf(withShaft(), (plan) => ({ ...plan, openings: [...plan.openings, door("d", "living-kitchen", 1)] })), "simplified", ["moscow.508.19.6.2"]],
  [29, "проём без двери к газовой кухне", doorlessPassage({ ...known, gasified: true }), null, ["moscow.508.9.25"]],
  [30, "проём без двери к кухне, о газе нет ответа", doorlessPassage(known), null, ["moscow.508.9.25"]],
  [31, "проём без двери к кухне, газа нет", doorlessPassage({ ...known, gasified: false }), null, []],
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

describe("balconies, shafts and door-ways in the plan as it stands", () => {
  it("counts a window onto a loggia as daylight", () => {
    const plan = withLoggia();
    plan.openings = [window_("onto-loggia", "bottom-b", 1), window_("kitchen-window", "top", 7)];
    const daylight = rulesForPlan(plan)!.findings.filter((item) => item.ruleId === "moscow.pp47.25");
    expect(daylight.map((item) => item.state)).toEqual(["ok"]);
  });

  it("does not hold a balcony or a shaft to room norms, or ask for a window in them", () => {
    const titles = rulesForPlan(withLoggia())!.findings.map((item) => item.title).join(" ");
    expect(titles).not.toContain("Лоджия:");
    expect(rulesForPlan(withShaft())!.findings.map((item) => item.title).join(" ")).not.toContain("Вентшахта:");
  });

  it("asks for the floor only when there is a balcony", () => {
    expect(rulesForPlan(apartment({ region: "moscow" }))!.missingFacts).not.toContain("floorLevel");
    expect(rulesForPlan(withLoggia({ region: "moscow" }))!.missingFacts).toContain("floorLevel");
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
