import { describe, expect, it } from "vitest";
import { MAX_PDF_CURVES, readPdfLines, type PdfOps } from "./pdf-vector-lines";

const OPS: PdfOps = {
  save: 10, restore: 11, transform: 12, constructPath: 91,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23,
  fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27,
};
const END_PATH = 28;
const M = 0, L = 1, C = 2, Q = 3, Z = 4;
const path = (paint: number, ...data: number[]) => [paint, [Float32Array.from(data)], null];
const VIEWPORT = [1, 0, 0, -1, 0, 400];
const K = 0.5522847498;

/** A quarter circle of radius r around (cx, cy), from angle 0 to 90°, as one cubic piece. */
const quarter = (cx: number, cy: number, r: number) =>
  [M, cx + r, cy, C, cx + r, cy + K * r, cx + K * r, cy + r, cx, cy + r];

describe("PDF curves", () => {
  it("samples a door-like quarter circle into a polyline in page fractions", () => {
    const { curves, segments } = readPdfLines(
      [OPS.constructPath], [path(OPS.stroke, ...quarter(100, 100, 90))], OPS, VIEWPORT, 600, 400,
    );
    expect(segments).toEqual([]);
    expect(curves).toHaveLength(1);
    const points = curves[0].points;
    expect(points).toHaveLength(5);
    // Page fractions of the PDF points (100 + 90, 100) and (100, 100 + 90), y flipped.
    expect(points[0].x).toBeCloseTo(190 / 600, 9);
    expect(points[0].y).toBeCloseTo((400 - 100) / 400, 9);
    expect(points.at(-1)!.x).toBeCloseTo(100 / 600, 9);
    expect(points.at(-1)!.y).toBeCloseTo((400 - 190) / 400, 9);
    // Every sample is on the circle (a cubic approximates it within 0.03 %).
    for (const point of points) {
      const radius = Math.hypot(point.x * 600 - 100, 400 - point.y * 400 - 100);
      expect(Math.abs(radius - 90) / 90).toBeLessThan(0.001);
    }
  });

  it("joins consecutive curve pieces into one chain and starts a new one after a line or a move", () => {
    const half = [M, 190, 100, C, 190, 149.7, 149.7, 190, 100, 190, C, 50.3, 190, 10, 149.7, 10, 100];
    const { curves, segments } = readPdfLines(
      [OPS.constructPath],
      [path(OPS.stroke, ...half, L, 10, 50, C, 10, 30, 30, 10, 50, 10, M, 300, 300, ...quarter(300, 300, 20).slice(3))],
      OPS, [1, 0, 0, 1, 0, 0], 600, 600,
    );
    expect(segments).toHaveLength(1);
    expect(curves.map((curve) => curve.points.length)).toEqual([9, 5, 5]);
  });

  it("works from quadratic pieces, ignores clipping paths and keeps each chain apart from lines", () => {
    const { curves } = readPdfLines(
      [OPS.constructPath, OPS.constructPath],
      [path(END_PATH, ...quarter(100, 100, 50)), path(OPS.stroke, M, 0, 0, Q, 50, 0, 50, 50, Q, 50, 100, 0, 100)],
      OPS, [1, 0, 0, 1, 0, 0], 100, 100,
    );
    expect(curves).toHaveLength(1);
    expect(curves[0].points).toHaveLength(9);
    expect(curves[0].points.at(-1)).toEqual({ x: 0, y: 1 });
  });

  it("ignores a lone short fillet-free path and non-finite data, and honours the limit", () => {
    expect(readPdfLines([OPS.constructPath], [path(OPS.stroke, M, 0, 0, L, 5, 5, Z)], OPS, [1, 0, 0, 1, 0, 0], 100, 100).curves).toEqual([]);
    expect(readPdfLines([OPS.constructPath], [path(OPS.stroke, M, 0, 0, C, NaN, 1, 2, 3, 4, 5)], OPS, [1, 0, 0, 1, 0, 0], 100, 100).curves).toEqual([]);
    const many = Array.from({ length: MAX_PDF_CURVES + 10 }, () => path(OPS.stroke, ...quarter(50, 50, 10)));
    const result = readPdfLines(many.map(() => OPS.constructPath), many, OPS, [1, 0, 0, 1, 0, 0], 100, 100);
    expect(result.curves).toHaveLength(MAX_PDF_CURVES);
  });
});
