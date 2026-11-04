import { describe, expect, it } from "vitest";
import type { DxfGeometry } from "@/domain/floor-plan/dxf";
import type { Underlay } from "@/domain/floor-plan/types";
import { underlaySchema } from "@/domain/floor-plan/schema";
import { DXF_MARGIN_METRES, dxfCanvasSize, dxfLinesForUnderlay, dxfPixelsPerMetre, placeDxfUnderlay } from "./dxf-underlay";

const geometry: DxfGeometry = {
  width: 10,
  height: 6,
  segments: [{ start: { x: 0, y: 0 }, end: { x: 10, y: 6 } }],
  curves: [{ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
};
const image: Underlay = {
  name: "plan.dxf", dataUrl: "data:image/jpeg;base64,AAAA", pixelWidth: 1650, pixelHeight: 1050,
  x: 0, y: 0, metersPerPixel: 1, opacity: 0.65, visible: true, calibrated: false,
};

describe("DXF underlay", () => {
  it("keeps the image within the size limits at any drawing size", () => {
    expect(dxfPixelsPerMetre({ width: 10, height: 6 })).toBe(150);
    expect(dxfCanvasSize({ width: 10, height: 6 }, 150)).toEqual({ width: 1650, height: 1050 });
    const huge = { width: 900, height: 300 };
    const size = dxfCanvasSize(huge, dxfPixelsPerMetre(huge));
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2049);
  });

  it("is calibrated from the file's units and sits at the drawing", () => {
    const placed = placeDxfUnderlay(image, 150, 1650);
    expect(placed.calibrated).toBe(true);
    expect(placed.x).toBe(-DXF_MARGIN_METRES);
    expect(placed.metersPerPixel).toBeCloseTo(1 / 150, 12);
    expect(underlaySchema.safeParse(placed).success).toBe(true);
  });

  it("keeps the true scale even when the stored image was made smaller", () => {
    const smaller = { ...image, pixelWidth: 825, pixelHeight: 525 };
    const placed = placeDxfUnderlay(smaller, 150, 1650);
    expect(placed.pixelWidth * placed.metersPerPixel).toBeCloseTo(11, 9);
  });

  it("gives lines that come back to the same plan metres through the suggestion path", () => {
    const placed = placeDxfUnderlay(image, 150, 1650);
    const lines = dxfLinesForUnderlay(geometry, placed, true);
    expect(lines.truncated).toBe(true);
    const toPlan = (point: { x: number; y: number }) => ({
      x: placed.x + point.x * placed.pixelWidth * placed.metersPerPixel,
      y: placed.y + point.y * placed.pixelHeight * placed.metersPerPixel,
    });
    const end = toPlan(lines.segments[0].end);
    expect(end.x).toBeCloseTo(10, 9);
    expect(end.y).toBeCloseTo(6, 9);
    expect(toPlan(lines.curves[0].points[1]).x).toBeCloseTo(2, 9);
  });
});
