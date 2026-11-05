import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import { floorPlanSchema } from "@/domain/floor-plan/schema";
import type { BuildingFacts, FloorPlan, PlanRequirement } from "@/domain/floor-plan/types";
import { resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import { interpretPrompt } from "@/domain/rules/prompt-rules";
import { apartment, labelled, wall, window_ } from "@/domain/rules/rules.fixtures";
import { generateVariants, variantSummary, type GenerationGoal } from "./generate-variants";

const AT = "2026-11-05T10:00:00.000Z";

/**
 * 12 × 6 m: bearing ring, a partition at x = 7, a large living room with two windows on the
 * left and a bedroom with one on the right. All facts answered, so the rules have a say.
 */
function flat(facts: BuildingFacts = { region: "moscow", gasified: false, woodenFloors: false, heritage: false, emergency: false, below: "no-dwelling", above: "no-dwelling" }): FloorPlan {
  let plan: FloorPlan = {
    ...createEmptyPlan("flat"),
    name: "Квартира",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 12, 0, "bearing"),
      wall("right", 12, 0, 12, 6, "bearing"),
      wall("bottom", 12, 6, 0, 6, "bearing"),
      wall("left", 0, 6, 0, 0, "bearing"),
      wall("p1", 7, 0, 7, 6, "partition"),
    ],
    openings: [window_("w1", "top", 1), window_("w2", "top", 4.8), window_("w3", "top", 9)],
    buildingFacts: facts,
  };
  plan = labelled(plan, { x: 3, y: 3 }, "Гостиная", "living");
  return labelled(plan, { x: 9, y: 3 }, "Спальня", "bedroom");
}
const run = (plan: FloorPlan, goal: GenerationGoal = "any") => generateVariants(plan, { goal, at: AT });
const roomCount = (plan: FloorPlan) => resolveWallRoomLabels(plan).rooms.length;

describe("what the generator refuses to start on", () => {
  it("says why it cannot run", () => {
    expect(run({ ...flat(), roomMode: "manual" }).blockers[0]).toContain("По стенам");
    expect(run({ ...createEmptyPlan("x"), roomMode: "walls" }).blockers[0]).toContain("нет стен");
    const noPartitions = { ...flat(), walls: flat().walls.map((item) => (item.id === "p1" ? { ...item, kind: "bearing" as const } : item)) };
    expect(run(noPartitions).blockers[0]).toContain("перегородка");
    expect(run(noPartitions).variants).toEqual([]);
  });
});

describe("what it proposes", () => {
  it("splits, merges and shifts partitions, and every proposal is a valid plan with a procedure", () => {
    const { variants, blockers, tried } = run(flat());
    expect(blockers).toEqual([]);
    expect(tried).toBeGreaterThan(3);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.length).toBeLessThanOrEqual(6);
    const kinds = new Set(run(flat()).variants.flatMap((item) => item.moves.map((move) => move.kind)));
    expect(kinds).toContain("split-room");
    for (const variant of variants) {
      expect(floorPlanSchema.safeParse(variant.plan).success).toBe(true);
      expect(variant.plan.origin).toBeUndefined();
      expect(variant.rules?.checkedChanges).toBe(true);
      expect(variant.overall).not.toBe("forbidden");
      expect(variant.title.length).toBeGreaterThan(5);
      expect(variantSummary(variant)).toMatch(/^Помещений: \d → \d\. Площадь: /);
    }
  });

  it("gives the same result every time", () => {
    const summary = (plan: FloorPlan) => run(plan).variants.map((item) => [item.key, item.title, item.overall]);
    expect(summary(flat())).toEqual(summary(flat()));
  });

  it("never touches bearing walls or walls of unknown type", () => {
    const source = flat();
    source.walls.push(wall("mystery", 2, 0, 2, 6));
    const ids = ["top", "right", "bottom", "left", "mystery"];
    const result = run(source);
    expect(result.untypedWalls).toBe(1);
    for (const variant of result.variants) {
      for (const id of ids) {
        expect(variant.plan.walls.find((item) => item.id === id)).toEqual(source.walls.find((item) => item.id === id));
      }
    }
  });

  it("leaves the walls of bathrooms alone", () => {
    const result = run(apartment({ region: "moscow", gasified: false, woodenFloors: false, heritage: false, emergency: false, below: "no-dwelling", above: "no-dwelling" }));
    for (const variant of result.variants) {
      for (const id of ["living-bath", "kitchen-bath"]) {
        expect(variant.plan.walls.some((item) => item.id === id)).toBe(true);
      }
    }
  });

  it("gives a new room a door, a window and a name", () => {
    const split = run(flat(), "more-rooms").variants.find((item) => item.moves[0].kind === "split-room" && item.moves.length === 1)!;
    expect(split.roomsAfter).toBe(split.roomsBefore + 1);
    const added = split.plan.walls.filter((item) => item.id.startsWith("generated-wall"));
    expect(added).toHaveLength(1);
    expect(added[0].kind).toBe("partition");
    expect(split.plan.openings.filter((item) => item.wallId === added[0].id && item.kind === "door")).toHaveLength(1);
    const rooms = resolveWallRoomLabels(split.plan).rooms;
    expect(rooms.filter((room) => room.kind === "bedroom").length).toBeGreaterThanOrEqual(2);
    expect(rooms.every((room) => room.area >= 8)).toBe(true);
    expect(split.title).toContain("Разделить «Гостиная»");
  });

  it("does not offer a room without daylight", () => {
    // One window in the living room: whichever way it is split, one part stays dark.
    const dark = { ...flat(), openings: [window_("w1", "top", 1), window_("w3", "top", 9)] };
    const result = run(dark, "more-rooms");
    expect(result.variants.filter((item) => item.moves.some((move) => move.kind === "split-room"))).toEqual([]);
  });

  it("merges for a larger room, under the larger room's name", () => {
    const merged = run(flat(), "larger-rooms").variants.find((item) => item.moves.some((move) => move.kind === "remove-partition"))!;
    expect(merged.title).toContain("Убрать стену 5 между «Гостиная» и «Спальня»");
    expect(roomCount(merged.plan)).toBe(1);
    expect(resolveWallRoomLabels(merged.plan).rooms[0].name).toBe("Гостиная");
    expect(merged.areaAfter).toBeGreaterThan(merged.areaBefore);
  });

  it("filters by the goal", () => {
    for (const variant of run(flat(), "more-rooms").variants) expect(variant.roomsAfter).toBeGreaterThan(variant.roomsBefore);
    const before = Math.max(...resolveWallRoomLabels(flat()).rooms.map((room) => room.area));
    for (const variant of run(flat(), "larger-rooms").variants) {
      expect(Math.max(...resolveWallRoomLabels(variant.plan).rooms.map((room) => room.area))).toBeGreaterThan(before);
    }
  });

  it("puts lighter procedures first", () => {
    const rank = { simplified: 0, unknown: 1, project: 2, specialist: 3, forbidden: 4 } as const;
    const ranks = run(flat()).variants.map((item) => rank[item.overall!]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("does not change the source plan", () => {
    const source = flat();
    const copy = structuredClone(source);
    run(source);
    expect(source).toEqual(copy);
  });
});

describe("what it rejects", () => {
  it("drops what the rules forbid", () => {
    const facts: BuildingFacts = { region: "moscow", gasified: true, woodenFloors: false, heritage: false, emergency: false, below: "no-dwelling", above: "no-dwelling" };
    const source = labelled(flat(facts), { x: 9, y: 3 }, "Кухня", "kitchen");
    const result = run(source);
    expect(result.rejected.forbidden).toBeGreaterThan(0);
    expect(result.variants.every((item) => item.moves.every((move) => move.kind !== "remove-partition"))).toBe(true);
  });

  it("offers nothing in a building declared unsafe", () => {
    const result = run(flat({ region: "moscow", emergency: true }));
    expect(result.variants).toEqual([]);
    expect(result.rejected.forbidden).toBeGreaterThan(0);
  });

  it("drops what breaks the norms of the base", () => {
    const small = run(flat());
    // Shifting the wall one metre towards the bedroom leaves it above 8 m², so this stays offered.
    expect(small.variants.length).toBeGreaterThan(0);
    const narrow = flat();
    narrow.walls = narrow.walls.map((item) => (item.id === "p1" ? { ...item, start: { x: 10.2, y: 0 }, end: { x: 10.2, y: 6 } } : item));
    narrow.openings = [window_("w1", "top", 1), window_("w2", "top", 4.8), window_("w3", "top", 10.4, 1)];
    const relabelled = labelled(labelled({ ...narrow, wallRoomLabels: [] }, { x: 3, y: 3 }, "Гостиная", "living"), { x: 11, y: 3 }, "Спальня", "bedroom");
    const result = run(relabelled);
    expect(result.rejected["new-problem"]).toBeGreaterThan(0);
    for (const variant of result.variants) {
      expect(resolveWallRoomLabels(variant.plan).rooms.filter((room) => room.kind === "bedroom").every((room) => room.area >= 8)).toBe(true);
    }
  });

  it("drops what breaks the plan's own requirements", () => {
    const requirement: PlanRequirement = { id: "req", type: "room-min-area", kind: "living", minArea: 39 };
    const result = run({ ...flat(), requirements: [requirement] });
    expect(result.rejected.requirement).toBeGreaterThan(0);
    for (const variant of result.variants) expect(variant.violatedRequirements).toBe(0);
  });
});

describe("in any country", () => {
  it("follows the developer's rules", () => {
    const source: FloorPlan = { ...flat({ region: "other" }), ruleProfile: interpretPrompt("Нельзя объединять гостиную со спальней. Спальня не меньше 12 м²") };
    const result = run(source);
    expect(result.rejected.forbidden).toBeGreaterThan(0);
    expect(result.variants.length).toBeGreaterThan(0);
    for (const variant of result.variants) {
      expect(variant.moves.some((move) => move.kind === "remove-partition")).toBe(false);
      expect(resolveWallRoomLabels(variant.plan).rooms.filter((room) => room.kind === "bedroom").every((room) => room.area >= 12)).toBe(true);
    }
  });

  it("works with no rules at all and says nothing about procedure", () => {
    const result = run(flat({}));
    expect(result.variants.length).toBeGreaterThan(0);
    expect(result.variants.every((item) => item.rules === null && item.overall === null)).toBe(true);
  });
});
