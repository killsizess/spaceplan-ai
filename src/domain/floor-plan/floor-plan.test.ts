import { describe, expect, it } from "vitest";
import {
  addRoom,
  createDefaultRoom,
  createEmptyPlan,
  createExamplePlan,
  deleteRoom,
  getTotalArea,
  updateRoom, isExamplePlan,
} from "./operations";
import { floorPlanSchema } from "./schema";
import { setRoomMode } from "./construction";

describe("floor-plan operations and boundaries", () => {
  it("validates sample and computes exactly 80 m²", () => {
    expect(floorPlanSchema.safeParse(createExamplePlan()).success).toBe(true);
    expect(getTotalArea(createExamplePlan())).toBe(80);
    expect(getTotalArea(createEmptyPlan("new"))).toBe(0);
  });
  it("adds, resizes and deletes without mutating previous plan", () => {
    const empty = createEmptyPlan("new");
    const room = createDefaultRoom(empty, "r1");
    const added = addRoom(empty, room);
    const updated = updateRoom(added, { ...room, width: 5 });
    expect(empty.rooms).toHaveLength(0);
    expect(getTotalArea(added)).toBe(12);
    expect(getTotalArea(updated)).toBe(15);
    expect(deleteRoom(updated, room.id).rooms).toHaveLength(0);
  });
  it("rejects overlap, duplicate IDs and invalid updates", () => {
    const plan = createExamplePlan();
    expect(() => updateRoom(plan, { ...plan.rooms[0], width: 6 })).toThrow(
      /пересекается/,
    );
    expect(() => updateRoom(plan, { ...plan.rooms[0], width: 0 })).toThrow();
    expect(() => updateRoom(plan, { ...plan.rooms[0], x: 999 })).toThrow();
    expect(() => addRoom(plan, plan.rooms[0])).toThrow();
  });
  it("rejects wrong format, units, unknown properties and broken references", () => {
    const plan = createEmptyPlan("new");
    expect(floorPlanSchema.safeParse({ ...plan, unit: "mm" }).success).toBe(
      false,
    );
    expect(
      floorPlanSchema.safeParse({ ...plan, schemaVersion: 11 }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({ ...plan, schemaVersion: 5 }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({ ...plan, schemaVersion: 4 }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({ ...plan, unexpected: true }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({
        ...plan,
        openings: [
          {
            id: "o",
            wallId: "missing",
            kind: "door",
            offset: 0,
            width: 1,
            height: 2,
            sillHeight: 0,
          },
        ],
      }).success,
    ).toBe(false);
    const sample = createExamplePlan();
    expect(
      floorPlanSchema.safeParse({
        ...sample,
        rooms: [...sample.rooms, sample.rooms[0]],
      }).success,
    ).toBe(false);
  });
  it("requires an explicit current room mode and rejects unsupported values", () => {
    const plan = createEmptyPlan("new");
    expect(plan.schemaVersion).toBe(10);
    expect(plan.wallRoomLabels).toEqual([]);
    expect(plan.roomMode).toBe("manual");
    expect(
      floorPlanSchema.safeParse({ ...plan, roomMode: undefined }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({ ...plan, roomMode: "automatic" }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({ ...plan, roomMode: "walls" }).success,
    ).toBe(true);
  });
  it("rejects a wall mode switch whose detected geometry exceeds the room limit", () => {
    const walls = Array.from({ length: 102 }, (_, index) => ({
      id: `vertical-${index}`,
      start: { x: index, y: 0 },
      end: { x: index, y: 1 },
      thickness: 0.2,
      height: 2.7,
    }));
    walls.push(
      {
        id: "top",
        start: { x: 0, y: 0 },
        end: { x: 101, y: 0 },
        thickness: 0.2,
        height: 2.7,
      },
      {
        id: "bottom",
        start: { x: 0, y: 1 },
        end: { x: 101, y: 1 },
        thickness: 0.2,
        height: 2.7,
      },
    );
    const plan = { ...createEmptyPlan("many"), walls };
    expect(floorPlanSchema.safeParse(plan).success).toBe(true);
    const detected = floorPlanSchema.safeParse({ ...plan, roomMode: "walls" });
    expect(detected.success).toBe(false);
    if (!detected.success)
      expect(detected.error.issues[0].message).toContain("100 помещений");
    expect(() => setRoomMode(plan, "walls")).toThrow("100 помещений");
    expect(plan.roomMode).toBe("manual");
  });
  it("derives net wall room area without counting or removing the stored manual rooms", () => {
    const manual = {
      ...createExamplePlan(),
      walls: [
        {
          id: "top",
          start: { x: 0, y: 0 },
          end: { x: 5, y: 0 },
          thickness: 0.2,
          height: 2.7,
        },
        {
          id: "right",
          start: { x: 5, y: 0 },
          end: { x: 5, y: 4 },
          thickness: 0.2,
          height: 2.7,
        },
        {
          id: "bottom",
          start: { x: 5, y: 4 },
          end: { x: 0, y: 4 },
          thickness: 0.2,
          height: 2.7,
        },
        {
          id: "left",
          start: { x: 0, y: 4 },
          end: { x: 0, y: 0 },
          thickness: 0.2,
          height: 2.7,
        },
      ],
    };
    const before = JSON.stringify(manual);
    const derived = setRoomMode(manual, "walls");
    expect(getTotalArea(manual)).toBe(80);
    expect(getTotalArea(derived)).toBeCloseTo(4.8 * 3.8);
    expect(derived.rooms).toEqual(manual.rooms);
    expect(JSON.stringify(manual)).toBe(before);
    expect(setRoomMode(derived, "walls")).toBe(derived);
    expect(getTotalArea(setRoomMode(derived, "manual"))).toBe(80);
    expect(getTotalArea({ ...derived, walls: derived.walls.slice(0, 3) })).toBe(
      0,
    );
  });
  it("reports almost-zero walls as validation errors without throwing", () => {
    const plan = {
      ...createEmptyPlan("new"),
      walls: [
        {
          id: "w",
          start: { x: 0, y: 0 },
          end: { x: 1e-12, y: 0 },
          thickness: 0.1,
          height: 3,
        },
      ],
      openings: [
        {
          id: "o",
          wallId: "w",
          kind: "door",
          offset: 0,
          width: 1,
          height: 2,
          sillHeight: 0,
        },
      ],
    };
    expect(floorPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe("the built-in example", () => {
  it("is recognised until it has walls or another name", () => {
    expect(isExamplePlan(createExamplePlan())).toBe(true);
    expect(isExamplePlan({ ...createExamplePlan(), name: "Моя квартира" })).toBe(false);
    expect(isExamplePlan(createEmptyPlan("new"))).toBe(false);
  });
});
