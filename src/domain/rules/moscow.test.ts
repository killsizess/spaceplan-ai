import { describe, expect, it } from "vitest";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { floorPlanSchema } from "@/domain/floor-plan/schema";
import { citation, rulesForPlan } from "./engine";
import { apartment, door, labelled, variantOf, wall, window_ } from "./rules.fixtures";
import type { RuleFinding, RuleReport } from "./types";

/** JS `\\b` does not see Cyrillic letters, so word edges are spelled out. */
const CLEARANCE = /(^|[^а-яё])(допустимо|разрешено|можно)([^а-яё]|$)/i;

const report = (plan: FloorPlan): RuleReport => {
  const result = rulesForPlan(plan);
  if (!result) throw new Error("No rule base for this plan");
  return result;
};
const find = (plan: FloorPlan, ruleId: string): RuleFinding[] =>
  report(plan).findings.filter((finding) => finding.ruleId === ruleId);
const points = (finding: RuleFinding) => finding.sources.map((source) => source.point);
const without = (plan: FloorPlan, id: string): FloorPlan => ({
  ...plan,
  walls: plan.walls.filter((item) => item.id !== id),
  openings: plan.openings.filter((item) => item.wallId !== id),
});

describe("which rule base applies", () => {
  it("runs only for the region the owner chose", () => {
    expect(rulesForPlan(apartment({}))).toBeNull();
    expect(rulesForPlan(apartment({ region: "other" }))).toBeNull();
    const { buildingFacts: _facts, ...none } = apartment();
    void _facts;
    expect(rulesForPlan(none)).toBeNull();
    expect(report(apartment()).region).toBe("Москва");
  });

  it("states the edition and the gaps of every document, and that no specialist confirmed it", () => {
    const result = report(apartment());
    expect(result.reviewed).toBe(false);
    expect(result.version).toBe("2026-11-05");
    expect(result.documents.map((item) => item.id)).toEqual(["moscow-508", "rf-pp-47", "sp-54", "zhk-rf"]);
    for (const document of result.documents) {
      expect(document.edition.length).toBeGreaterThan(5);
      expect(document.url).toMatch(/^https:\/\//);
      expect(document.gaps.length).toBeGreaterThan(5);
    }
    expect(result.documents[0].gaps).toContain("3005-ПП");
    expect(result.notChecked.length).toBeGreaterThan(5);
  });

  it("cannot call anything verified while no specialist confirmed the rules", () => {
    const result = report(apartment());
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((finding) => finding.level === "verified")).toBe(false);
    expect(find(apartment(), "moscow.pp47.25")[0].level).toBe("assumption");
  });

  it("never says that something is allowed", () => {
    const plans = [
      apartment(),
      variantOf(apartment(), (plan) => without(plan, "living-kitchen")),
      variantOf(apartment({ region: "moscow", gasified: false }), (plan) => without(plan, "living-kitchen")),
      variantOf(apartment(), (plan) => without(plan, "top")),
    ];
    for (const plan of plans) {
      const result = report(plan);
      for (const finding of result.findings) {
        expect(`${finding.title} ${finding.detail ?? ""}`).not.toMatch(CLEARANCE);
      }
    }
  });
});

describe("the plan as it stands", () => {
  it("passes minimum areas with a citation, and names a room that falls short", () => {
    const fine = find(apartment(), "moscow.sp54.5.11");
    expect(fine).toHaveLength(1);
    expect(fine[0].state).toBe("ok");
    expect(citation(report(apartment()), fine[0])).toBe("СП 54, п. 5.11");

    // Two living rooms, so the kitchen is held to the general minimum.
    const small = labelled(variantless({ x: 8.2 }), { x: 9.1, y: 4.5 }, "Спальня", "bedroom");
    const finding = find(small, "moscow.sp54.5.11").find((item) => item.title.startsWith("Кухня"))!;
    expect(finding.state).toBe("problem");
    expect(finding.title).toBe("Кухня: 4,48 м² при минимуме 8 м²");
    expect(finding.detail).toContain("определяет специалист");
  });

  it("holds a one-room apartment's kitchen to 5 m² and its only room to 14 m²", () => {
    const flat = variantless({ x: 8.2 });
    expect(find(flat, "moscow.sp54.5.11").find((item) => item.state === "problem")?.title).toBe("Кухня: 4,48 м² при минимуме 5 м²");
    const roomy = variantless({ x: 7.5 });
    expect(find(roomy, "moscow.sp54.5.11").every((item) => item.state === "ok")).toBe(true);
    const tiny = variantless({ x: 2.5 });
    expect(find(tiny, "moscow.sp54.5.11").map((item) => item.title)).toContain("Гостиная: 13,34 м² при минимуме 14 м²");
  });

  it("holds a bedroom to 8 m² and a living room to 16 m² once there are two rooms", () => {
    const two = labelled(variantless({ x: 8.2 }), { x: 9.1, y: 4.5 }, "Спальня", "bedroom");
    expect(find(two, "moscow.sp54.5.11").map((item) => item.title)).toContain("Спальня: 4,48 м² при минимуме 8 м²");
    const smallLiving = labelled(variantless({ x: 2.5 }), { x: 6, y: 4.5 }, "Спальня", "bedroom");
    expect(find(smallLiving, "moscow.sp54.5.11").map((item) => item.title)).toContain("Гостиная: 13,34 м² при минимуме 16 м²");
  });

  it("wants a window to the outside in living rooms and kitchens", () => {
    expect(find(apartment(), "moscow.pp47.25")[0].state).toBe("ok");
    const dark: FloorPlan = { ...apartment(), openings: [window_("living-window", "top", 2)] };
    const [finding] = find(dark, "moscow.pp47.25");
    expect(finding.state).toBe("problem");
    expect(finding.title).toBe("Кухня: нет окна наружу");
    expect(points(finding)).toEqual(["п. 25"]);
    // A window into the next room is not daylight.
    const inner: FloorPlan = { ...apartment(), openings: [window_("living-window", "top", 2), window_("inner", "living-kitchen", 0.5)] };
    expect(find(inner, "moscow.pp47.25")[0].title).toBe("Кухня: нет окна наружу");
    // The bathroom does not need one.
    expect(find(apartment(), "moscow.pp47.25").every((item) => !item.title.includes("Санузел"))).toBe(true);
  });

  it("checks heights by the lowest wall of the room", () => {
    expect(find(apartment(), "moscow.pp47.22")).toEqual([]);
    const low: FloorPlan = {
      ...apartment(),
      walls: apartment().walls.map((item) => (item.id === "top" ? { ...item, height: 2.4 } : item)),
    };
    const titles = find(low, "moscow.pp47.22").map((item) => item.title);
    expect(titles).toContain("Гостиная: высота 2,4 м при минимуме 2,5 м");
    expect(titles).toContain("Кухня: высота 2,4 м при минимуме 2,5 м");
    expect(titles.some((title) => title.includes("Санузел"))).toBe(false);
  });

  it("says when rooms are only rectangles or have no purpose yet", () => {
    const manual: FloorPlan = {
      ...apartment(),
      roomMode: "manual",
      walls: [],
      openings: [],
      wallRoomLabels: [],
      rooms: [{ id: "r1", name: "Кухня", kind: "kitchen", color: "#f1e3c6", x: 0, y: 0, width: 2, height: 2 }],
    };
    expect(find(manual, "moscow.rooms.manual")).toHaveLength(1);
    expect(find(manual, "moscow.sp54.5.11")[0].title).toBe("Кухня: 4 м² при минимуме 8 м²");
    const noPurpose = labelled(apartment(), { x: 3, y: 3 }, "Что-то", "other");
    expect(find(noPurpose, "moscow.rooms.kind")[0].title).toContain("Что-то");
  });

  it("forbids work in a building declared unsafe, and asks for a project in a heritage site", () => {
    const unsafe = find(apartment({ region: "moscow", emergency: true }), "moscow.building.emergency")[0];
    expect(unsafe.procedure).toBe("forbidden");
    expect(points(unsafe)).toEqual(["прил. 1, п. 9.15"]);
    const heritage = find(apartment({ region: "moscow", heritage: true }), "moscow.building.heritage")[0];
    expect(heritage.procedure).toBe("project");
    expect(points(heritage)).toContain("прил. 1, п. 12");
  });

  it("lists only the questions that would change the findings", () => {
    expect(report(apartment()).missingFacts).toEqual(["emergency", "heritage", "woodenFloors", "gasified", "below", "above"]);
    const answered = apartment({ region: "moscow", emergency: false, heritage: false, woodenFloors: false, gasified: true, below: "no-dwelling", above: "same-layout" });
    expect(report(answered).missingFacts).toEqual([]);
  });

  it("does not compare a plan that is not a variant", () => {
    const result = report(apartment());
    expect(result.checkedChanges).toBe(false);
    expect(result.overall).toBeNull();
  });
});

function variantless({ x }: { x: number }): FloorPlan {
  // Kitchen and bathroom shrunk by moving their shared partitions to the right.
  const walls = [
    wall("top", 0, 0, 10, 0, "bearing"),
    wall("right", 10, 0, 10, 6, "bearing"),
    wall("bottom", 10, 6, 0, 6, "bearing"),
    wall("left", 0, 6, 0, 0, "bearing"),
    wall("living-kitchen", x, 0, x, 3, "partition"),
    wall("living-bath", x, 3, x, 6, "partition"),
    wall("kitchen-bath", x, 3, 10, 3, "partition"),
  ];
  let plan: FloorPlan = { ...apartment(), walls, wallRoomLabels: [], openings: [window_("living-window", "top", 0.5, 1), window_("kitchen-window", "top", x + 0.2, 1)] };
  plan = labelled(plan, { x: x / 2, y: 3 }, "Гостиная", "living");
  plan = labelled(plan, { x: x + 0.9, y: 1.5 }, "Кухня", "kitchen");
  return labelled(plan, { x: x + 0.9, y: 4.5 }, "Санузел", "bathroom");
}

describe("a variant against its source", () => {
  const source = () => apartment();

  it("finds nothing to say about an unchanged variant", () => {
    const same = report(variantOf(source(), (plan) => plan));
    expect(same.checkedChanges).toBe(true);
    expect(same.overall).toBeNull();
    expect(same.findings.filter((finding) => finding.procedure)).toEqual([]);
  });

  it("sends a touched bearing wall to a specialist, however it was touched", () => {
    const removed = find(variantOf(source(), (plan) => without(plan, "top")), "moscow.508.9.3")[0];
    expect(removed.procedure).toBe("specialist");
    expect(removed.level).toBe("specialist");
    expect(removed.title).toContain("стена 1 исходного плана удалена");
    expect(points(removed)).toEqual(["прил. 1, п. 9.3", "прил. 1, п. 9.6"]);
    const moved = variantOf(source(), (plan) => ({
      ...plan,
      walls: plan.walls.map((item) => (item.id === "left" ? { ...item, start: { x: 0.5, y: 6 }, end: { x: 0.5, y: 0 } } : item)),
    }));
    expect(find(moved, "moscow.508.9.3")[0].title).toContain("перенесена");
    const thick = variantOf(source(), (plan) => ({
      ...plan,
      walls: plan.walls.map((item) => (item.id === "left" ? { ...item, thickness: 0.4 } : item)),
    }));
    expect(find(thick, "moscow.508.9.3")[0].title).toContain("изменена толщина");
    const unmarked = variantOf(source(), (plan) => ({
      ...plan,
      walls: plan.walls.map((item) => (item.id === "left" ? { ...item, kind: "partition" as const } : item)),
    }));
    expect(find(unmarked, "moscow.508.9.3")[0].title).toContain("больше не отмечена несущей");
  });

  it("does not take a split wall for a removed one", () => {
    const split = variantOf(source(), (plan) => ({
      ...plan,
      walls: [
        ...plan.walls.filter((item) => item.id !== "kitchen-bath"),
        wall("a", 6, 3, 8, 3, "partition"),
        wall("b", 8, 3, 10, 3, "partition"),
      ],
    }));
    expect(find(split, "moscow.508.19.6.1")).toEqual([]);
    const splitBearing = variantOf(source(), (plan) => ({
      ...plan,
      walls: [...plan.walls.filter((item) => item.id !== "left"), wall("c", 0, 6, 0, 3, "bearing"), wall("d", 0, 3, 0, 0, "bearing")],
    }));
    expect(find(splitBearing, "moscow.508.9.3")).toEqual([]);
    expect(find(splitBearing, "moscow.508.2.2.2")).toEqual([]);
  });

  it("asks for a project for a new bearing wall", () => {
    const added = variantOf(source(), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "bearing")] }));
    const [finding] = find(added, "moscow.508.2.2.2");
    expect(finding.procedure).toBe("project");
    expect(finding.title).toContain("стена 8");
  });

  it("gives no conclusion on walls of unknown type", () => {
    const unknown: FloorPlan = { ...source(), walls: source().walls.map((item) => (item.id === "living-kitchen" ? { ...item, kind: undefined } : item)) };
    const removed = find(variantOf(unknown, (plan) => without(plan, "living-kitchen")), "moscow.walls.unknown")[0];
    expect(removed.level).toBe("undetermined");
    expect(removed.procedure).toBe("unknown");
    expect(removed.title).toBe("Изменены стены без указанного типа: стена 5 исходного плана");
    const added = find(variantOf(source(), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6)] })), "moscow.walls.unknown")[0];
    expect(added.title).toContain("новые: стена 8");
  });

  it("names the simplified procedure for partitions, unless the floors are wooden", () => {
    const [simple] = find(variantOf(source(), (plan) => without(plan, "kitchen-bath")), "moscow.508.19.6.1");
    expect(simple.procedure).toBe("simplified");
    expect(simple.title).toBe("Перегородки: упрощённый порядок (стена 7 исходного плана)");
    expect(simple.detail).toContain("деревянные");
    expect(points(simple)).toContain("прил. 1, п. 19.6.1");
    const concrete = apartment({ region: "moscow", woodenFloors: false });
    expect(find(variantOf(concrete, (plan) => without(plan, "kitchen-bath")), "moscow.508.19.6.1")[0].detail).not.toContain("деревянные");
    const wooden = apartment({ region: "moscow", woodenFloors: true });
    const change = variantOf(wooden, (plan) => without(plan, "kitchen-bath"));
    expect(find(change, "moscow.508.19.6.1")).toEqual([]);
    expect(find(change, "moscow.508.2.2.10")[0].procedure).toBe("project");
  });

  it("tells openings apart by the wall they are in", () => {
    const inPartition = find(variantOf(source(), (plan) => ({ ...plan, openings: [...plan.openings, door("d", "living-kitchen", 1)] })), "moscow.508.19.6.2")[0];
    expect(inPartition.procedure).toBe("simplified");
    expect(inPartition.title).toBe("Проёмы в перегородках: упрощённый порядок (стена 5)");
    const withInner = apartment();
    withInner.walls.push(wall("spine", 3, 0, 3, 6, "bearing"));
    const inBearing = find(variantOf(withInner, (plan) => ({ ...plan, openings: [...plan.openings, door("d", "spine", 2)] })), "moscow.508.2.2.4")[0];
    expect(inBearing.procedure).toBe("project");
    expect(points(inBearing)).toEqual(["прил. 1, п. 2.2.4", "прил. 1, п. 9.10"]);
    const carried = structuredClone(withInner);
    carried.openings.push(door("d", "spine", 2));
    const closed = find(variantOf(carried, (plan) => ({ ...plan, openings: plan.openings.filter((item) => item.id !== "d") })), "moscow.508.2.2.6")[0];
    expect(closed.procedure).toBe("unknown");
    expect(closed.title).toBe("Заделан проём в несущей стене (стена 8 исходного плана)");
    expect(closed.detail).toContain("19.6.7");
    const unknownHost: FloorPlan = { ...source(), walls: source().walls.map((item) => (item.id === "living-kitchen" ? { ...item, kind: undefined } : item)) };
    expect(find(variantOf(unknownHost, (plan) => ({ ...plan, openings: [...plan.openings, door("d", "living-kitchen", 1)] })), "moscow.openings.unknown")).toHaveLength(1);
  });

  it("treats an opening on the apartment's boundary separately, and does not count one that just stayed", () => {
    const added = variantOf(source(), (plan) => ({ ...plan, openings: [...plan.openings, window_("new", "left", 1)] }));
    const [finding] = find(added, "moscow.508.3.1");
    expect(finding.procedure).toBe("project");
    expect(finding.openingIds).toEqual(["new"]);
    expect(find(added, "moscow.508.2.2.4")).toEqual([]);
    const moved = variantOf(source(), (plan) => ({
      ...plan,
      openings: plan.openings.map((item) => (item.id === "living-window" ? { ...item, offset: 3 } : item)),
    }));
    expect(find(moved, "moscow.508.3.1")[0].openingIds).toEqual(["living-window"]);
    expect(find(variantOf(source(), (plan) => plan), "moscow.508.3.1")).toEqual([]);
  });

  it("sees a changed outer contour", () => {
    const moved = variantOf(source(), (plan) => ({
      ...plan,
      walls: plan.walls.map((item) => (item.id === "left" ? { ...item, start: { x: -0.5, y: 6 }, end: { x: -0.5, y: 0 } } : item)),
    }));
    const [finding] = find(moved, "moscow.508.2.2.5");
    expect(finding.procedure).toBe("project");
    expect(finding.wallIds).toEqual(["left"]);
    expect(find(variantOf(source(), (plan) => without(plan, "kitchen-bath")), "moscow.508.2.2.5")).toEqual([]);
  });

  describe("kitchen and living room merged", () => {
    const merge = (plan: FloorPlan) => without(plan, "living-kitchen");

    it("is forbidden with gas", () => {
      const [finding] = find(variantOf(apartment({ region: "moscow", gasified: true }), merge), "moscow.508.9.16");
      expect(finding.procedure).toBe("forbidden");
      expect(finding.state).toBe("problem");
      expect(finding.level).toBe("specialist");
      expect(points(finding)).toEqual(["прил. 1, п. 9.16"]);
    });

    it("has no conclusion when gas is not known", () => {
      const [finding] = find(variantOf(apartment(), merge), "moscow.508.9.16");
      expect(finding.procedure).toBe("unknown");
      expect(finding.level).toBe("undetermined");
    });

    it("does not apply the ban without gas, and still says nothing is cleared", () => {
      const [finding] = find(variantOf(apartment({ region: "moscow", gasified: false }), merge), "moscow.508.9.16");
      expect(finding.procedure).toBeUndefined();
      expect(finding.state).toBe("note");
      expect(finding.detail).toContain("2.2.11");
    });

    it("does not fire for walls that do not join a kitchen to a living room", () => {
      expect(find(variantOf(apartment({ region: "moscow", gasified: true }), (plan) => without(plan, "kitchen-bath")), "moscow.508.9.16")).toEqual([]);
    });
  });

  describe("wet rooms and what they stand over", () => {
    /** The bathroom goes to a new corner of the living room; the old one becomes a bedroom. */
    const moveBathroom = (plan: FloorPlan) => {
      let next: FloorPlan = { ...plan, walls: [...plan.walls, wall("w1", 0, 3, 3, 3, "partition"), wall("w2", 3, 3, 3, 6, "partition")] };
      next = labelled(next, { x: 1.5, y: 4.5 }, "Новый санузел", "bathroom");
      return labelled(next, { x: 8, y: 4.5 }, "Спальня", "bedroom");
    };

    it("needs a project for a moved bathroom", () => {
      const [finding] = find(variantOf(apartment(), moveBathroom), "moscow.508.2.2.1");
      expect(finding.procedure).toBe("project");
      expect(finding.title).toContain("Новый санузел");
    });

    it("needs a project for a bathroom whose boundary moved", () => {
      const change = variantOf(apartment(), (plan) => ({
        ...plan,
        walls: plan.walls.map((item) => (item.id === "kitchen-bath" ? { ...item, start: { x: 6, y: 2.5 }, end: { x: 10, y: 2.5 } } : item))
          .map((item) => (item.id === "living-kitchen" ? { ...item, end: { x: 6, y: 2.5 } } : item))
          .map((item) => (item.id === "living-bath" ? { ...item, start: { x: 6, y: 2.5 } } : item)),
      }));
      expect(find(change, "moscow.508.2.2.1")[0].procedure).toBe("project");
    });

    it("needs a project for a new kitchen and flags a changed one", () => {
      const moved = variantOf(apartment(), (plan) => {
        let next: FloorPlan = { ...plan, walls: [...plan.walls, wall("w1", 0, 3, 3, 3, "partition"), wall("w2", 3, 3, 3, 6, "partition")] };
        next = labelled(next, { x: 1.5, y: 4.5 }, "Новая кухня", "kitchen");
        return labelled(next, { x: 8, y: 1.5 }, "Кладовая", "other");
      });
      expect(find(moved, "moscow.508.2.2.11")[0].title).toContain("Новая кухня");
      const resized = variantOf(apartment(), (plan) => ({
        ...plan,
        walls: plan.walls.map((item) => (item.id === "kitchen-bath" ? { ...item, start: { x: 6, y: 2.5 }, end: { x: 10, y: 2.5 } } : item))
          .map((item) => (item.id === "living-kitchen" ? { ...item, end: { x: 6, y: 2.5 } } : item))
          .map((item) => (item.id === "living-bath" ? { ...item, start: { x: 6, y: 2.5 } } : item)),
      }));
      expect(find(resized, "moscow.kitchen.changed")[0].procedure).toBe("unknown");
    });

    it("forbids a bathroom over the neighbours' living room when the layout below is the same", () => {
      const change = variantOf(apartment({ region: "moscow", below: "same-layout", above: "no-dwelling" }), moveBathroom);
      const stack = find(change, "moscow.stack");
      expect(stack).toHaveLength(1);
      expect(stack[0].procedure).toBe("forbidden");
      expect(stack[0].title).toBe("Новый санузел окажется над чужим помещением «Гостиная»");
      expect(stack[0].level).toBe("assumption");
      expect(stack[0].sources).toContainEqual({ document: "rf-pp-47", point: "п. 24" });
      expect(stack[0].sources).toContainEqual({ document: "sp-54", point: "п. 7.20" });
      expect(find(change, "moscow.stack.unknown")).toEqual([]);
    });

    it("forbids a new bedroom under the neighbours' bathroom when the layout above is the same", () => {
      const change = variantOf(apartment({ region: "moscow", below: "no-dwelling", above: "same-layout" }), moveBathroom);
      const stack = find(change, "moscow.stack");
      expect(stack.map((item) => item.title)).toEqual(["Спальня окажется под чужим помещением «Санузел»"]);
    });

    it("cites the gas ban for a kitchen over a living room when there is gas", () => {
      const change = variantOf(apartment({ region: "moscow", below: "same-layout", above: "no-dwelling", gasified: true }), (plan) => {
        let next: FloorPlan = { ...plan, walls: [...plan.walls, wall("w1", 0, 3, 3, 3, "partition"), wall("w2", 3, 3, 3, 6, "partition")] };
        next = labelled(next, { x: 1.5, y: 4.5 }, "Новая кухня", "kitchen");
        return labelled(next, { x: 8, y: 1.5 }, "Спальня", "bedroom");
      });
      const stack = find(change, "moscow.stack").find((item) => item.title.startsWith("Новая кухня"))!;
      expect(stack.sources).toContainEqual({ document: "moscow-508", point: "прил. 1, п. 9.27" });
      expect(stack.sources).toContainEqual({ document: "sp-54", point: "п. 7.21" });
    });

    it("has nothing to say when nobody lives below or above", () => {
      const change = variantOf(apartment({ region: "moscow", below: "no-dwelling", above: "no-dwelling" }), moveBathroom);
      expect(find(change, "moscow.stack")).toEqual([]);
      expect(find(change, "moscow.stack.unknown")).toEqual([]);
    });

    it("does not conclude anything when the neighbours are not known or are different", () => {
      expect(find(variantOf(apartment(), moveBathroom), "moscow.stack.unknown")[0].level).toBe("undetermined");
      const other = variantOf(apartment({ region: "moscow", below: "other-layout", above: "no-dwelling" }), moveBathroom);
      expect(find(other, "moscow.stack")).toEqual([]);
      expect(find(other, "moscow.stack.unknown")).toHaveLength(1);
      expect(find(variantOf(apartment(), (plan) => plan), "moscow.stack.unknown")).toEqual([]);
    });
  });

  it("reports the heaviest procedure among the changes", () => {
    expect(report(variantOf(apartment(), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "bearing")] }))).overall).toBe("project");
    expect(report(variantOf(apartment({ region: "moscow", woodenFloors: false, below: "no-dwelling", above: "no-dwelling" }), (plan) => ({
      ...plan,
      openings: [...plan.openings, door("d", "living-kitchen", 1)],
    }))).overall).toBe("simplified");
    expect(report(variantOf(apartment({ region: "moscow", gasified: true }), (plan) => without(plan, "living-kitchen"))).overall).toBe("forbidden");
    expect(report(variantOf(apartment(), (plan) => without(plan, "top"))).overall).toBe("specialist");
  });

  it("works from the source snapshot even when the source project is gone", () => {
    const plan = variantOf(apartment(), (next) => without(next, "top"));
    expect(floorPlanSchema.safeParse({ ...plan, origin: plan.origin }).success).toBe(true);
    expect(find(plan, "moscow.508.9.3")).toHaveLength(1);
  });

  it("says rooms could not be compared when they cannot be computed", () => {
    const plan = variantOf(apartment(), (next) => next);
    const broken: FloorPlan = { ...plan, walls: [...plan.walls, ...tooManyRooms()] };
    const result = report(broken);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining(["moscow.rooms.unresolved", "moscow.rooms.compare"]));
    expect(result.overall).toBe("unknown");
  });
});

/** A grid with more cells than the room detector accepts. */
function tooManyRooms() {
  const walls = [];
  for (let line = 0; line <= 11; line++) {
    walls.push(wall(`h${line}`, 20, 20 + line * 2, 42, 20 + line * 2, "partition"));
    walls.push(wall(`v${line}`, 20 + line * 2, 20, 20 + line * 2, 42, "partition"));
  }
  return walls;
}
