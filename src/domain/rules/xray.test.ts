import { describe, expect, it } from "vitest";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { apartment, wall } from "./rules.fixtures";
import { buildXray, type WallPotential } from "./xray";

const wallOf = (plan: FloorPlan, id: string): WallPotential => {
  const found = buildXray(plan).walls.find((item) => item.wallId === id);
  if (!found) throw new Error(id);
  return found;
};
const sourcePoints = (answer: { sources: readonly { point: string }[] }) => answer.sources.map((item) => item.point);
const facts = (extra: NonNullable<FloorPlan["buildingFacts"]>) => apartment({ region: "moscow", ...extra });

describe("X-Ray of the plan as it stands", () => {
  it("sends bearing walls to a specialist and asks for a project for an opening in one", () => {
    const plan = apartment();
    plan.walls.push(wall("spine", 3, 0, 3, 6, "bearing"));
    const spine = wallOf(plan, "spine");
    expect(spine.removal.procedure).toBe("specialist");
    expect(sourcePoints(spine.removal)).toEqual(["прил. 1, п. 9.3", "прил. 1, п. 9.6"]);
    expect(spine.opening.procedure).toBe("project");
    expect(sourcePoints(spine.opening)).toContain("прил. 1, п. 2.2.4");
    expect(spine.number).toBe(8);
  });

  it("says nothing about walls of unknown type", () => {
    const plan = apartment();
    plan.walls.push(wall("mystery", 3, 0, 3, 6));
    const mystery = wallOf(plan, "mystery");
    expect(mystery.kind).toBe("unknown");
    expect(mystery.removal.procedure).toBe("unknown");
    expect(mystery.opening.procedure).toBe("unknown");
  });

  it("names the simplified procedure for an ordinary partition, with the exception spelled out", () => {
    const plan = apartment();
    plan.walls.push(wall("inner", 3, 0, 3, 6, "partition"));
    const inner = wallOf(plan, "inner");
    expect(inner.removal.procedure).toBe("simplified");
    expect(inner.removal.reason).toContain("деревянные");
    expect(sourcePoints(inner.removal)).toContain("прил. 1, п. 19.6.1");
    expect(inner.opening.procedure).toBe("simplified");
    expect(sourcePoints(inner.opening)).toContain("прил. 1, п. 19.6.2");
    const concrete = facts({ woodenFloors: false });
    concrete.walls.push(wall("inner", 3, 0, 3, 6, "partition"));
    expect(wallOf(concrete, "inner").removal.reason).toBe("Перегородка.");
    const wooden = facts({ woodenFloors: true });
    wooden.walls.push(wall("inner", 3, 0, 3, 6, "partition"));
    expect(wallOf(wooden, "inner").removal.procedure).toBe("project");
  });

  it("answers for the wall between a kitchen and a living room by the gas question", () => {
    expect(wallOf(apartment(), "living-kitchen").removal.procedure).toBe("unknown");
    expect(wallOf(facts({ gasified: true }), "living-kitchen").removal.procedure).toBe("forbidden");
    const noGas = wallOf(facts({ gasified: false }), "living-kitchen").removal;
    expect(noGas.procedure).toBe("simplified");
    expect(noGas.reason).toContain("2.2.11");
    expect(wallOf(facts({ gasified: true }), "living-kitchen").rooms.sort()).toEqual(["Гостиная", "Кухня"]);
  });

  it("asks for a project for a wall of the bathroom", () => {
    const bath = wallOf(apartment(), "living-bath").removal;
    expect(bath.procedure).toBe("project");
    expect(sourcePoints(bath)).toEqual(["прил. 1, п. 2.2.1"]);
  });

  it("treats the outer ring by its type first, then as the apartment's boundary", () => {
    const plan = apartment();
    expect(wallOf(plan, "top").removal.procedure).toBe("specialist");
    expect(sourcePoints(wallOf(plan, "top").opening)).toEqual(["прил. 1, п. 3.1"]);
    plan.walls = plan.walls.map((item) => (item.id === "top" ? { ...item, kind: "partition" as const } : item));
    const boundary = wallOf(plan, "top").removal;
    expect(boundary.procedure).toBe("specialist");
    expect(sourcePoints(boundary)).toEqual(["прил. 1, п. 2.2.5"]);
  });

  it("lets a building declared unsafe override everything, and a heritage site override the simple cases", () => {
    const unsafe = facts({ emergency: true });
    for (const potential of buildXray(unsafe).walls) {
      expect(potential.removal.procedure).toBe("forbidden");
      expect(potential.opening.procedure).toBe("forbidden");
    }
    const heritage = facts({ heritage: true, gasified: false });
    heritage.walls.push(wall("inner", 3, 0, 3, 6, "partition"));
    const inner = wallOf(heritage, "inner");
    expect(inner.removal.procedure).toBe("project");
    expect(inner.opening.procedure).toBe("project");
    expect(sourcePoints(inner.removal)).toContain("прил. 1, п. 12");
  });

  it("names what moving a wet room takes", () => {
    const { rooms } = buildXray(apartment());
    expect(rooms.map((room) => [room.name, room.move.procedure])).toEqual([["Кухня", "project"], ["Санузел", "project"]]);
    expect(sourcePoints(rooms[1].move)).toContain("прил. 1, п. 2.2.1");
    expect(sourcePoints(rooms[1].move)).toContain("п. 7.20");
  });

  it("counts every wall once", () => {
    const xray = buildXray(apartment());
    expect(Object.values(xray.counts).reduce((sum, count) => sum + count, 0)).toBe(xray.walls.length);
    expect(xray.counts.specialist).toBe(4);
    expect(xray.counts.project).toBe(2);
    expect(xray.counts.unknown).toBe(1);
  });

  it("never says that something is allowed", () => {
    for (const plan of [apartment(), facts({ gasified: false, woodenFloors: false })]) {
      const xray = buildXray(plan);
      for (const answer of [...xray.walls.flatMap((item) => [item.removal, item.opening]), ...xray.rooms.map((item) => item.move)]) {
        expect(answer.reason).not.toMatch(/(^|[^а-яё])(допустимо|разрешено|можно)([^а-яё]|$)/i);
      }
    }
  });
});
