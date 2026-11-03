import { describe, expect, it } from "vitest";
import type { Wall } from "@/domain/floor-plan/types";
import { detectWallRooms, type WallRoom } from "@/domain/floor-plan/wall-rooms";
import { getRoomDimensionLayout } from "./room-dimensions";

function room(x = 0, y = 0, width = 5, depth = 4): WallRoom {
  return {
    id: "room",
    name: "Помещение 1",
    color: "#dfe8df",
    outer: [
      { x, y }, { x: x + width, y },
      { x: x + width, y: y + depth }, { x, y: y + depth },
    ],
    holes: [],
    area: width * depth,
    perimeter: 2 * (width + depth),
    labelPoint: { x: x + width / 2, y: y + depth / 2 },
    bounds: { minX: x, minY: y, maxX: x + width, maxY: y + depth },
    boundaryWallIds: [],
  };
}

function wallsAroundInterior(thickness: number): Wall[] {
  const offset = thickness / 2;
  const points = [
    { x: -offset, y: -offset },
    { x: 5 + offset, y: -offset },
    { x: 5 + offset, y: 4 + offset },
    { x: -offset, y: 4 + offset },
  ];
  return points.map((start, index) => ({
    id: `wall-${index}`,
    start,
    end: points[(index + 1) % points.length],
    thickness,
    height: 2.7,
  }));
}

describe("inner room dimension overlays", () => {
  it("measures the actual 5 × 4 m interior and leaves a gap below each label", () => {
    const layout = getRoomDimensionLayout(room(), 60);
    expect(layout?.kind).toBe("lines");
    if (layout?.kind !== "lines") throw new Error("Expected dimension lines");
    expect(layout.width).toBe(5);
    expect(layout.depth).toBe(4);
    expect(layout.horizontalLabel.text).toBe("5 м");
    expect(layout.verticalLabel.text).toBe("4 м");
    expect(layout.caption.text).toBe("Внутри");
    expect(layout.segments[0][0]).toBe(0);
    expect(layout.segments[1][2]).toBe(5);
    expect(layout.segments[2][1]).toBe(0);
    expect(layout.segments[3][3]).toBe(4);
    expect(layout.segments[0][2]).toBeLessThan(layout.horizontalLabel.x);
    expect(layout.segments[1][0]).toBeGreaterThan(
      layout.horizontalLabel.x + layout.horizontalLabel.width,
    );
  });

  it("uses inner faces rather than wall axes for different wall thicknesses", () => {
    for (const thickness of [0.1, 0.2, 0.6]) {
      const detection = detectWallRooms(wallsAroundInterior(thickness));
      expect(detection.rooms).toHaveLength(1);
      const layout = getRoomDimensionLayout(detection.rooms[0], 60);
      expect(layout?.width).toBeCloseTo(5);
      expect(layout?.depth).toBeCloseTo(4);
      expect(layout?.kind).toBe("lines");
      if (layout?.kind === "lines") {
        expect(layout.horizontalLabel.text).toBe("5 м");
        expect(layout.verticalLabel.text).toBe("4 м");
      }
    }
  });

  it("positions the overlay correctly in negative plan coordinates", () => {
    const layout = getRoomDimensionLayout(room(-8, -9), 60);
    expect(layout?.kind).toBe("lines");
    if (layout?.kind !== "lines") throw new Error("Expected dimension lines");
    expect(layout.segments[0][0]).toBe(-8);
    expect(layout.segments[1][2]).toBe(-3);
    expect(layout.segments[2][1]).toBe(-9);
    expect(layout.segments[3][3]).toBe(-5);
    expect(layout.segments[0][1]).toBeCloseTo(-9 + 22 / 60);
  });

  it("keeps text, offsets, ticks and stroke widths fixed in screen pixels", () => {
    for (const scale of [40, 60, 150]) {
      const layout = getRoomDimensionLayout(room(), scale);
      if (layout?.kind !== "lines") throw new Error("Expected dimension lines");
      expect(layout.horizontalLabel.fontSize * scale).toBeCloseTo(10);
      expect(layout.caption.fontSize * scale).toBeCloseTo(9);
      expect(layout.segments[0][1] * scale).toBeCloseTo(22);
      expect((5 - layout.segments[2][0]) * scale).toBeCloseTo(22);
      expect(layout.strokeWidth * scale).toBeCloseTo(0.7);
      expect((layout.segments[8][2] - layout.segments[8][0]) * scale).toBeCloseTo(6);
    }
  });

  it("uses a compact lower label at medium zoom and hides at unreadable zoom", () => {
    expect(getRoomDimensionLayout(room(), 32)?.kind).toBe("lines");
    const layout = getRoomDimensionLayout(room(), 28);
    expect(layout?.kind).toBe("compact");
    if (layout?.kind !== "compact") throw new Error("Expected compact label");
    expect(layout.label.text).toBe("5 × 4 м внутри");
    expect(layout.label.fontSize * 28).toBeCloseTo(10);
    expect((4 - layout.label.y) * 28).toBeCloseTo(22);
    expect(getRoomDimensionLayout(room(), 20)).toBeNull();
    expect(getRoomDimensionLayout(room(0, 0, 0.5, 0.5), 60)).toBeNull();
    expect(getRoomDimensionLayout(room(0, 0, 5.123, 4.125), 23)).toBeNull();
  });

  it("accepts reversed contours, repeated closing point and redundant edge vertices", () => {
    const source = room();
    const contour = [
      ...source.outer.slice(0, 1), { x: 2, y: 0 }, ...source.outer.slice(1),
    ];
    expect(getRoomDimensionLayout({ ...source, outer: contour }, 60)?.width).toBe(5);
    const reversed = source.outer.slice().reverse();
    expect(getRoomDimensionLayout({ ...source, outer: [...reversed, reversed[0]] }, 60)?.depth).toBe(4);
  });

  it("does not mistake a rotated rectangle or crossing contour for its axis-aligned bounds", () => {
    const source = room();
    const rotated = {
      ...source,
      outer: [{ x: 2, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 2 }],
      bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
      area: 16,
    };
    expect(getRoomDimensionLayout(rotated, 60)).toBeNull();
    expect(getRoomDimensionLayout({
      ...source,
      outer: [source.outer[0], source.outer[2], source.outer[1], source.outer[3]],
    }, 60)).toBeNull();
  });

  it("hides dimensions for concave contours and interior holes", () => {
    const source = room();
    expect(getRoomDimensionLayout({
      ...source,
      outer: [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 2 },
        { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 0, y: 4 },
      ],
      area: 16,
    }, 60)).toBeNull();
    expect(getRoomDimensionLayout({ ...source, holes: [room(1, 1, 1, 1).outer] }, 60)).toBeNull();
  });

  it("rejects inconsistent metadata, non-finite geometry and degenerate contours", () => {
    const source = room();
    expect(getRoomDimensionLayout({ ...source, area: 21 }, 60)).toBeNull();
    expect(getRoomDimensionLayout({ ...source, bounds: { ...source.bounds, maxX: 6 } }, 60)).toBeNull();
    expect(getRoomDimensionLayout({ ...source, outer: [{ x: NaN, y: 0 }, ...source.outer.slice(1)] }, 60)).toBeNull();
    expect(getRoomDimensionLayout({ ...source, bounds: { ...source.bounds, minX: -Infinity } }, 60)).toBeNull();
    expect(getRoomDimensionLayout(room(0, 0, 0, 4), 60)).toBeNull();
  });

  it("rejects invalid and overflowing zoom values", () => {
    for (const scale of [NaN, Infinity, -Infinity, 0, -10, Number.MAX_VALUE]) {
      expect(getRoomDimensionLayout(room(), scale)).toBeNull();
    }
  });

  it("rounds only label text and preserves the measured dimensions and source contour", () => {
    const source = room(0, 0, 5.126, 4.345);
    const original = structuredClone(source);
    const layout = getRoomDimensionLayout(source, 60);
    if (layout?.kind !== "lines") throw new Error("Expected dimension lines");
    expect(layout.width).toBe(5.126);
    expect(layout.depth).toBe(4.345);
    expect(layout.horizontalLabel.text).toBe("5,13 м");
    expect(layout.verticalLabel.text).toBe("4,35 м");
    expect(source).toEqual(original);
  });
});
