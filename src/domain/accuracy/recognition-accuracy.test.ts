import { describe, expect, it } from "vitest";
import { measureAreas, measureOpenings, measureWalls, openingCenter, type WallLike } from "./recognition-accuracy";

const wall = (x1: number, y1: number, x2: number, y2: number, thickness = 0.2): WallLike => ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness });
const room = [wall(0, 0, 10, 0), wall(10, 0, 10, 6), wall(10, 6, 0, 6), wall(0, 6, 0, 0)];

describe("walls", () => {
  it("gives full marks when recognition proposed exactly the confirmed walls", () => {
    const result = measureWalls(room, room);
    expect(result.lengthRecall).toBe(1);
    expect(result.lengthPrecision).toBe(1);
    expect(result.wallsFound).toBe(4);
    expect(result.wallsExtra).toBe(0);
    expect(result.thicknessError).toBe(0);
  });

  it("measures by length, so a wall found in two pieces counts as found", () => {
    const pieces = [wall(0, 0, 4, 0), wall(4, 0, 10, 0), ...room.slice(1)];
    const result = measureWalls(pieces, room);
    expect(result.lengthRecall).toBeCloseTo(1, 9);
    expect(result.wallsFound).toBe(4);
    expect(result.foundCount).toBe(5);
  });

  it("counts a missed wall against recall and a wrong one against precision", () => {
    const found = [...room.slice(0, 3), wall(2, 2, 6, 2)];
    const result = measureWalls(found, room);
    expect(result.lengthRecall).toBeCloseTo(26 / 32, 9);
    expect(result.lengthPrecision).toBeCloseTo(26 / 30, 9);
    expect(result.wallsFound).toBe(3);
    expect(result.wallsExtra).toBe(1);
  });

  it("tolerates a few centimetres off the axis, not more", () => {
    expect(measureWalls([wall(0, 0.05, 10, 0.05)], [room[0]]).lengthRecall).toBe(1);
    expect(measureWalls([wall(0, 0.3, 10, 0.3)], [room[0]]).lengthRecall).toBe(0);
  });

  it("does not take a crossing wall for a parallel one", () => {
    expect(measureWalls([wall(5, -1, 5, 1)], [room[0]]).lengthRecall).toBe(0);
  });

  it("reports thickness differences", () => {
    expect(measureWalls([wall(0, 0, 10, 0, 0.25)], [room[0]]).thicknessError).toBeCloseTo(0.05, 9);
  });

  it("says nothing rather than zero when there is nothing to measure", () => {
    const result = measureWalls([], []);
    expect(result.lengthRecall).toBeNull();
    expect(result.lengthPrecision).toBeNull();
  });
});

describe("openings", () => {
  const door = (x: number, y: number, width = 0.9) => ({ kind: "door" as const, center: { x, y }, width });
  const window = (x: number, y: number) => ({ kind: "window" as const, center: { x, y }, width: 1.2 });

  it("matches doors and windows apart, one to one, by where they are", () => {
    const truth = [door(2, 0), door(5, 6), window(8, 0)];
    const found = [door(2.1, 0, 0.8), window(8, 0.05), window(3, 6)];
    const doors = measureOpenings(found, truth, "door");
    expect(doors).toMatchObject({ truthCount: 2, foundCount: 1, matched: 1, recall: 0.5, precision: 1 });
    expect(doors.widthError).toBeCloseTo(0.1, 9);
    const windows = measureOpenings(found, truth, "window");
    expect(windows).toMatchObject({ truthCount: 1, foundCount: 2, matched: 1, recall: 1, precision: 0.5 });
  });

  it("notices an opening found in the right place as the wrong kind", () => {
    expect(measureOpenings([window(2, 0)], [door(2, 0)], "door")).toMatchObject({ matched: 0, wrongKind: 1 });
  });

  it("does not use one proposal for two real openings", () => {
    expect(measureOpenings([door(2, 0)], [door(1.9, 0), door(2.1, 0)], "door").matched).toBe(1);
  });

  it("places an opening at its middle on the wall", () => {
    expect(openingCenter(wall(0, 0, 10, 0), 2, 1)).toEqual({ x: 2.5, y: 0 });
  });
});

describe("areas", () => {
  it("compares computed areas with documented ones by room name", () => {
    const result = measureAreas(
      [{ name: "Кухня", area: 9.9 }, { name: "Гостиная", area: 20.4 }],
      [{ name: "кухня ", area: 10 }, { name: "Гостиная", area: 20 }, { name: "Санузел", area: 4 }],
    );
    expect(result.rooms[0].share).toBeCloseTo(-0.01, 9);
    expect(result.rooms[1].share).toBeCloseTo(0.02, 9);
    expect(result.meanAbsoluteShare).toBeCloseTo(0.015, 9);
    expect(result.worstShare).toBeCloseTo(0.02, 9);
    expect(result.missing).toEqual(["Санузел"]);
  });
});
