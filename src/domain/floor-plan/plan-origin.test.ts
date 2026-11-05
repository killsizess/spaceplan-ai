import { describe, expect, it } from "vitest";
import { createSpatialExamplePlan } from "./examples";
import { createEmptyPlan } from "./operations";
import { diffPlans } from "./plan-diff";
import { createPlanOrigin, originNote, originStatus, planFromOrigin, snapshotOfPlan } from "./plan-origin";
import { floorPlanSchema, planOriginSchema } from "./schema";
import type { FloorPlan } from "./types";

const at = "2026-11-04T10:00:00.000Z";
const source = (): FloorPlan => ({ ...createSpatialExamplePlan(), name: "Исходный", roomMode: "manual" });

describe("variant origin", () => {
  it("snapshots geometry only, as an independent copy", () => {
    const plan = source();
    const snapshot = snapshotOfPlan({
      ...plan,
      underlay: {
        name: "p.png", dataUrl: "data:image/png;base64,AAAA", pixelWidth: 1, pixelHeight: 1,
        x: 0, y: 0, metersPerPixel: 1, opacity: 1, visible: true, calibrated: false,
      },
    });
    expect(Object.keys(snapshot).sort()).toEqual(["openings", "requirements", "roomMode", "rooms", "wallRoomLabels", "walls"]);
    expect(snapshot.walls).toEqual(plan.walls);
    expect(snapshot.walls).not.toBe(plan.walls);
    snapshot.walls[0].thickness = 9;
    expect(plan.walls[0].thickness).not.toBe(9);
  });

  it("records the source ID, name and time, and is valid in the plan schema", () => {
    const plan = source();
    const origin = createPlanOrigin(plan, at);
    expect(origin).toMatchObject({ planId: plan.id, planName: "Исходный", createdAt: at });
    expect(planOriginSchema.safeParse(origin).success).toBe(true);
    const variant = { ...plan, id: "variant", origin };
    expect(floorPlanSchema.safeParse(variant).success).toBe(true);
    expect(planOriginSchema.safeParse({ ...origin, createdAt: "yesterday" }).success).toBe(false);
    expect(planOriginSchema.safeParse({ ...origin, extra: 1 }).success).toBe(false);
  });

  it("rebuilds the source plan so that it compares as identical with an unchanged source", () => {
    const plan = source();
    const rebuilt = planFromOrigin(createPlanOrigin(plan, at));
    expect(rebuilt.id).toBe(plan.id);
    expect(rebuilt.schemaVersion).toBe(8);
    expect(floorPlanSchema.safeParse(rebuilt).success).toBe(true);
    expect(diffPlans(rebuilt, plan).identical).toBe(true);
  });

  it("reports unchanged, changed and missing sources", () => {
    const plan = source();
    const origin = createPlanOrigin(plan, at);
    expect(originStatus(origin, [plan])).toBe("unchanged");
    expect(originStatus(origin, [{ ...plan, name: "Другое имя" }])).toBe("unchanged");
    const edited = { ...plan, walls: plan.walls.map((wall, index) => index === 0 ? { ...wall, thickness: wall.thickness + 0.1 } : wall) };
    expect(originStatus(origin, [edited])).toBe("changed");
    expect(originStatus(origin, [createEmptyPlan("other")])).toBe("missing");
    expect(originStatus(origin, [])).toBe("missing");
  });

  it("explains each case in plain words, never as an error", () => {
    const origin = createPlanOrigin(source(), at);
    expect(originNote(origin, "unchanged")).toMatch(/не менялся/);
    expect(originNote(origin, "changed")).toMatch(/изменён после создания варианта/);
    expect(originNote(origin, "missing")).toMatch(/больше нет в библиотеке.*слепком/);
    expect(originNote(origin, "missing")).toContain("2026-11-04");
    expect(originNote(origin, "missing")).not.toMatch(/ошибк/i);
  });
});
