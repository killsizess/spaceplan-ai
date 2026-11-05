import { describe, expect, it } from "vitest";
import { wallLength } from "@/domain/geometry";
import {
  addOpening,
  addWall,
  calibrateUnderlay,
  deleteObject,
  setUnderlay,
  updateOpening,
  updateWall,
} from "./construction";
import { createEmptyPlan } from "./operations";
import {
  floorPlanSchema,
  MAX_UNDERLAY_DATA_URL_LENGTH,
  openingSchema,
  underlaySchema,
} from "./schema";
import type { Opening, Underlay, Wall } from "./types";

const wall: Wall = {
  id: "wall",
  start: { x: 0, y: 0 },
  end: { x: 3, y: 4 },
  thickness: 0.2,
  height: 3,
};
const door: Opening = {
  id: "door",
  wallId: "wall",
  kind: "door",
  offset: 1,
  width: 0.9,
  height: 2.1,
  sillHeight: 0,
};
const underlay: Underlay = {
  name: "Plan.png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
  pixelWidth: 1000,
  pixelHeight: 500,
  x: 2,
  y: 3,
  metersPerPixel: 0.01,
  opacity: 0.6,
  visible: true,
  calibrated: false,
};

describe("wall and opening geometry", () => {
  it.each([
    { hinge: "start", side: "left" },
    { hinge: "start", side: "right" },
    { hinge: "end", side: "left" },
    { hinge: "end", side: "right" },
  ] as const)("changes door orientation without moving or resizing the opening: %j", (orientation) => {
    const plan = addOpening(addWall(createEmptyPlan("plan"), wall), door);
    const before = JSON.stringify(plan);
    const updated = updateOpening(plan, { ...door, door: orientation });
    expect(updated.schemaVersion).toBe(10);
    expect(updated.openings).toEqual([{ ...door, door: orientation }]);
    expect(updated.walls).toEqual(plan.walls);
    expect(updated.rooms).toEqual(plan.rooms);
    expect(JSON.stringify(plan)).toBe(before);
    expect(plan.openings[0]).not.toHaveProperty("door");
  });
  it.each([
    null, {}, { hinge: "start" }, { side: "left" },
    { hinge: "middle", side: "left" },
    { hinge: "start", side: "inside" },
    { hinge: "start", side: "left", angle: 90 },
  ])("rejects malformed door orientation rather than repairing it: %j", (orientation) => {
    expect(openingSchema.safeParse({ ...door, door: orientation }).success).toBe(false);
    expect(floorPlanSchema.safeParse({
      ...createEmptyPlan("plan"), walls: [wall], openings: [{ ...door, door: orientation }],
    }).success).toBe(false);
  });
  it("rejects door metadata on windows atomically and preserves omitted legacy orientation", () => {
    const plan = addOpening(addWall(createEmptyPlan("plan"), wall), door);
    const before = JSON.stringify(plan);
    expect(openingSchema.parse(door)).toEqual(door);
    expect(openingSchema.safeParse({ ...door, kind: "window", door: undefined }).success).toBe(false);
    expect(() => updateOpening(plan, {
      ...door, kind: "window", door: { hinge: "end", side: "right" },
    })).toThrow(/только для двери/);
    expect(JSON.stringify(plan)).toBe(before);
    expect(updateOpening(plan, { ...door, kind: "window" }).openings[0]).toEqual({ ...door, kind: "window" });
  });
  it("uses actual diagonal lengths and preserves previous states", () => {
    const empty = createEmptyPlan("plan");
    const withWall = addWall(empty, wall);
    const withDoor = addOpening(withWall, { ...door, offset: 4, width: 1 });
    expect(wallLength(withDoor.walls[0].start, withDoor.walls[0].end)).toBe(5);
    expect(withDoor.openings).toHaveLength(1);
    expect(empty.walls).toHaveLength(0);
    expect(withWall.openings).toHaveLength(0);
    expect(() =>
      addOpening(withWall, { ...door, offset: 4.1, width: 1 }),
    ).toThrow(/границы/);
  });
  it.each([
    { ...wall, end: wall.start },
    { ...wall, start: { x: NaN, y: 0 } },
    { ...wall, end: { x: 1001, y: 0 } },
    { ...wall, thickness: 0 },
    { ...wall, height: -2 },
    { ...wall, start: { x: -1000, y: -1000 }, end: { x: 1000, y: 1000 } },
  ])("rejects invalid wall geometry %#", (invalid) => {
    expect(() => addWall(createEmptyPlan("plan"), invalid)).toThrow();
  });
  it("rejects shared IDs, missing walls, invalid dimensions and vertical overflow", () => {
    const plan = addWall(createEmptyPlan("plan"), wall);
    expect(() => addOpening(plan, { ...door, id: "wall" })).toThrow(
      /уже существует/,
    );
    expect(() => addWall(plan, wall)).toThrow(/уже существует/);
    expect(() => addOpening(plan, { ...door, wallId: "missing" })).toThrow(
      /существующая стена/,
    );
    for (const change of [
      { offset: -1 },
      { width: 0 },
      { width: Infinity },
      { height: -1 },
      { sillHeight: -1 },
    ]) {
      expect(() => addOpening(plan, { ...door, ...change })).toThrow();
    }
    expect(() =>
      addOpening(plan, { ...door, kind: "window", sillHeight: 1, height: 2.1 }),
    ).toThrow(/границы/);
  });
  it("allows touching edges but rejects overlapping opening intervals on one wall", () => {
    const plan = addOpening(addWall(createEmptyPlan("plan"), wall), door);
    const window = {
      ...door,
      id: "window",
      kind: "window" as const,
      offset: 1.9,
      sillHeight: 1,
      height: 1.2,
    };
    const added = addOpening(plan, window);
    expect(added.openings).toHaveLength(2);
    expect(() => updateOpening(added, { ...window, offset: 1.8 })).toThrow(
      /перекрываться/,
    );
    expect(() => addOpening(plan, { ...window, offset: 1.8 })).toThrow(
      /перекрываться/,
    );
    const otherWall = addWall(plan, { ...wall, id: "other" });
    expect(
      addOpening(otherWall, { ...window, wallId: "other", offset: 1 }).openings,
    ).toHaveLength(2);
  });
  it("validates edits against existing openings and cascades wall removal", () => {
    const plan = addOpening(addWall(createEmptyPlan("plan"), wall), door);
    expect(() => updateWall(plan, { ...wall, end: { x: 1, y: 0 } })).toThrow(
      /границы/,
    );
    expect(() => updateWall(plan, { ...wall, height: 2 })).toThrow(/границы/);
    expect(updateWall(plan, { ...wall, thickness: 0.3 }).openings).toEqual(
      plan.openings,
    );
    expect(deleteObject(plan, door.id).walls).toEqual(plan.walls);
    const deleted = deleteObject(plan, wall.id);
    expect(deleted.walls).toHaveLength(0);
    expect(deleted.openings).toHaveLength(0);
    expect(plan.openings).toHaveLength(1);
    expect(deleteObject(plan, "unknown")).toBe(plan);
  });
});

describe("raster underlay and calibration", () => {
  it("sets and removes an optional underlay without mutating the previous plan", () => {
    const empty = createEmptyPlan("plan");
    const added = setUnderlay(empty, underlay);
    expect(floorPlanSchema.safeParse(added).success).toBe(true);
    expect(empty.underlay).toBeUndefined();
    expect(setUnderlay(added, null)).not.toHaveProperty("underlay");
    expect(setUnderlay(empty, null)).toBe(empty);
  });
  it("calibrates a diagonal pixel measurement and preserves its first world anchor", () => {
    const start = { x: 100, y: 100 },
      end = { x: 400, y: 500 };
    const calibrated = calibrateUnderlay(underlay, start, end, 10);
    expect(calibrated.metersPerPixel).toBe(0.02);
    expect(calibrated.x + start.x * calibrated.metersPerPixel).toBe(3);
    expect(calibrated.y + start.y * calibrated.metersPerPixel).toBe(4);
    expect(wallLength(start, end) * calibrated.metersPerPixel).toBe(10);
    expect(calibrated.calibrated).toBe(true);
    expect(underlay.calibrated).toBe(false);
  });
  it("supports native pixels beyond model coordinate limits", () => {
    const large = { ...underlay, pixelWidth: 4096, pixelHeight: 2048 };
    expect(
      calibrateUnderlay(large, { x: 2000, y: 1000 }, { x: 3000, y: 1000 }, 5)
        .metersPerPixel,
    ).toBe(0.005);
  });
  it("rejects nonfinite lengths, degenerate or outside anchors, and out of bounds scale", () => {
    const start = { x: 100, y: 100 },
      end = { x: 200, y: 100 };
    for (const length of [0, -1, NaN, Infinity, 2001]) {
      expect(() => calibrateUnderlay(underlay, start, end, length)).toThrow();
    }
    expect(() => calibrateUnderlay(underlay, start, start, 4)).toThrow();
    expect(() =>
      calibrateUnderlay(underlay, start, { x: 100.5, y: 100 }, 4),
    ).toThrow();
    expect(() =>
      calibrateUnderlay(underlay, start, { x: 1001, y: 100 }, 4),
    ).toThrow();
    expect(() =>
      calibrateUnderlay(underlay, { x: NaN, y: 100 }, end, 4),
    ).toThrow();
    expect(() => calibrateUnderlay(underlay, start, end, 2000)).toThrow(
      /пределы/,
    );
  });
  it.each([
    { dataUrl: "https://example.com/plan.png" },
    { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
    { dataUrl: "data:image/png;base64," },
    { dataUrl: "data:image/png;base64,AAA" },
    { pixelWidth: 0 },
    { pixelWidth: 4097 },
    { pixelHeight: 1.5 },
    { x: 999 },
    { y: -1001 },
    { metersPerPixel: 0 },
    { metersPerPixel: Infinity },
    { opacity: 1.1 },
  ])("rejects unsafe or out of range underlay fields %#", (change) => {
    expect(underlaySchema.safeParse({ ...underlay, ...change }).success).toBe(
      false,
    );
  });
  it("rejects raster payloads beyond the storage budget", () => {
    expect(
      underlaySchema.safeParse({
        ...underlay,
        dataUrl:
          "data:image/png;base64," + "A".repeat(MAX_UNDERLAY_DATA_URL_LENGTH),
      }).success,
    ).toBe(false);
  });
});
