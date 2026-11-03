import { describe, expect, it } from "vitest";
import {
  polygonArea,
  rectangleArea,
  rectanglesOverlap,
  validateRoomDimensions,
  wallLength,
} from ".";

describe("rectangle geometry in meters", () => {
  it("calculates decimal and boundary areas", () => {
    expect(rectangleArea(4, 3)).toBe(12);
    expect(rectangleArea(2.5, 3.2)).toBe(8);
    expect(rectangleArea(0.5, 0.5)).toBe(0.25);
    expect(rectangleArea(100, 100)).toBe(10000);
  });
  it.each([0, -1, 0.49, 100.01, NaN, Infinity, -Infinity])(
    "rejects invalid size %s",
    (value) => {
      expect(() => rectangleArea(value, 3)).toThrow();
      expect(() => rectangleArea(3, value)).toThrow();
      expect(validateRoomDimensions(value, 3)).not.toBeNull();
    },
  );
  it("permits shared edges, rejects interior overlaps and containment", () => {
    const room = { x: 0, y: 0, width: 4, height: 3 };
    expect(rectanglesOverlap(room, { ...room, x: 4 })).toBe(false);
    expect(rectanglesOverlap(room, { ...room, x: 3.9 })).toBe(true);
    expect(rectanglesOverlap(room, { x: 1, y: 1, width: 1, height: 1 })).toBe(
      true,
    );
    expect(() => rectanglesOverlap(room, { ...room, x: Infinity })).toThrow();
  });
});

describe("polygon geometry", () => {
  const rectangle = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 3 },
    { x: 0, y: 3 },
  ];
  it("supports winding, concavity and translations", () => {
    expect(polygonArea(rectangle)).toBe(12);
    expect(polygonArea([...rectangle].reverse())).toBe(12);
    expect(
      polygonArea(rectangle.map((p) => ({ x: p.x - 900, y: p.y + 500 }))),
    ).toBe(12);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 3 },
        { x: 0, y: 3 },
      ]),
    ).toBe(5);
  });
  it.each(
    [
      [],
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
      [
        { x: 0, y: 0 },
        { x: 3, y: 3 },
        { x: 0, y: 3 },
        { x: 3, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
      ],
      [...rectangle, rectangle[0]],
      [
        { x: NaN, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    ].map((points) => ({ points })),
  )("rejects degenerate or self-intersecting contours %#", ({ points }) =>
    expect(() => polygonArea(points)).toThrow(),
  );
  it("does not mutate input", () => {
    const before = structuredClone(rectangle);
    polygonArea(rectangle);
    expect(rectangle).toEqual(before);
  });
});

describe("wall geometry", () => {
  it("computes Euclidean length", () =>
    expect(wallLength({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5));
  it("rejects invalid walls", () => {
    expect(() => wallLength({ x: 0, y: 0 }, { x: 0, y: 0 })).toThrow();
    expect(() => wallLength({ x: Infinity, y: 0 }, { x: 1, y: 1 })).toThrow();
    expect(() => wallLength({ x: 1001, y: 0 }, { x: 1, y: 1 })).toThrow();
  });
});
