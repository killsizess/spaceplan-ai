import { describe, expect, it } from "vitest";
import { createExamplePlan } from "@/domain/floor-plan/operations";
import { parsePlanFile, serializePlan } from "./project-repository";

const example = () => {
  const { buildingFacts: _none, ...plan } = createExamplePlan();
  void _none;
  return plan;
};

describe("formats 7 to 9", () => {
  it("open as current, with nothing changed and no answers invented", () => {
    for (const schemaVersion of [7, 8, 9]) {
      const old = { ...example(), schemaVersion };
      const opened = parsePlanFile(JSON.stringify(old));
      expect(opened).toEqual({ ...old, schemaVersion: 10 });
      expect("buildingFacts" in opened).toBe(false);
    }
  });

  it("keeps a v8 file's answers", () => {
    const old = { ...example(), schemaVersion: 8, buildingFacts: { region: "moscow", gasified: true } };
    expect(parsePlanFile(JSON.stringify(old)).buildingFacts).toEqual(old.buildingFacts);
  });

  it("refuses a v7 file carrying a v8 field rather than blessing it", () => {
    expect(() => parsePlanFile(JSON.stringify({ ...example(), schemaVersion: 7, buildingFacts: { region: "moscow" } }))).toThrow();
  });
});

describe("format 10", () => {
  const profile = { prompt: "Кухня не меньше 9 м²", rules: [{ id: "r1", phrase: "Кухня не меньше 9 м²", type: "room-min-area", target: "kitchen", value: 9 }], notUnderstood: [] };

  it("keeps the developer's rules through a save and an open", () => {
    const plan = { ...createExamplePlan(), ruleProfile: profile as never };
    expect(parsePlanFile(serializePlan(plan)).ruleProfile).toEqual(profile);
  });

  it("refuses a v9 file carrying the rules, and rules that do not fit the format", () => {
    expect(() => parsePlanFile(JSON.stringify({ ...example(), schemaVersion: 9, ruleProfile: profile }))).toThrow();
    expect(() => parsePlanFile(JSON.stringify({ ...example(), ruleProfile: { ...profile, rules: [{ id: "r1", phrase: "x", type: "guess" }] } }))).toThrow();
    expect(() => parsePlanFile(JSON.stringify({ ...example(), ruleProfile: { prompt: "x" } }))).toThrow();
  });
});

describe("format 9", () => {
  const room = { id: "b", name: "Лоджия", kind: "balcony", color: "#f6d6d0", x: 20, y: 20, width: 2, height: 1 };

  it("keeps answers, balconies and shafts through a save and an open", () => {
    const plan = {
      ...createExamplePlan(),
      buildingFacts: { region: "moscow" as const, gasified: true, below: "same-layout" as const, floorLevel: "upper" as const },
      rooms: [...createExamplePlan().rooms, { ...room, kind: "balcony" as const }, { ...room, id: "s", name: "Шахта", kind: "shaft" as const, x: 30 }],
    };
    const again = parsePlanFile(serializePlan(plan));
    expect(again.buildingFacts).toEqual(plan.buildingFacts);
    expect(again.rooms.map((item) => item.kind)).toEqual(plan.rooms.map((item) => item.kind));
    expect(again.schemaVersion).toBe(10);
  });

  it("refuses a v8 file carrying anything format 9 added", () => {
    const old = { ...example(), schemaVersion: 8 };
    expect(() => parsePlanFile(JSON.stringify({ ...old, rooms: [...old.rooms, room] }))).toThrow();
    expect(() => parsePlanFile(JSON.stringify({ ...old, buildingFacts: { floorLevel: "first" } }))).toThrow();
    expect(() => parsePlanFile(JSON.stringify({ ...old, walls: [{ id: "w", start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, thickness: 0.2, height: 2.7 }], openings: [{ id: "d", wallId: "w", kind: "door", offset: 0, width: 0.9, height: 2.1, sillHeight: 0, doorless: true }] }))).toThrow();
  });

  it("allows a door-way with no door only where a door could be", () => {
    const wall = { id: "w", start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, thickness: 0.2, height: 2.7 };
    const plan = { ...example(), rooms: [], roomMode: "walls", walls: [wall] };
    expect(parsePlanFile(JSON.stringify({ ...plan, openings: [{ id: "d", wallId: "w", kind: "door", offset: 0, width: 0.9, height: 2.1, sillHeight: 0, doorless: true }] })).openings[0].doorless).toBe(true);
    expect(() => parsePlanFile(JSON.stringify({ ...plan, openings: [{ id: "d", wallId: "w", kind: "window", offset: 0, width: 0.9, height: 1, sillHeight: 1, doorless: true }] }))).toThrow(/только на месте двери/);
  });

  it("refuses an unknown version", () => {
    expect(() => parsePlanFile(JSON.stringify({ ...createExamplePlan(), schemaVersion: 11 }))).toThrow(/версии от 1 до 10/);
  });
});
