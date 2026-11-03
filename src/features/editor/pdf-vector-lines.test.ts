import { describe, expect, it } from "vitest";
import { MAX_PDF_SEGMENTS, readPdfLines, type PdfOps } from "./pdf-vector-lines";

// Values of pdfjs OPS in pdf.js 6.4.
const OPS: PdfOps = {
  save: 10, restore: 11, transform: 12, constructPath: 91,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23,
  fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27,
};
const END_PATH = 28;
const M = 0, L = 1, C = 2, Z = 4;
const path = (paint: number, ...data: number[]) => [paint, [Float32Array.from(data)], null];
// A 600 × 400 page rendered at 1 px per unit: PDF y grows upwards, canvas y downwards.
const VIEWPORT = [1, 0, 0, -1, 0, 400];

describe("PDF vector lines", () => {
  it("reads stroked and filled path edges in page fractions, closing subpaths", () => {
    const { segments, truncated } = readPdfLines(
      [OPS.constructPath, OPS.constructPath],
      [path(OPS.stroke, M, 60, 40, L, 300, 40), path(OPS.fill, M, 0, 0, L, 600, 0, L, 600, 400, Z)],
      OPS, VIEWPORT, 600, 400,
    );
    expect(truncated).toBe(false);
    expect(segments).toEqual([
      { start: { x: 0.1, y: 0.9 }, end: { x: 0.5, y: 0.9 } },
      { start: { x: 0, y: 1 }, end: { x: 1, y: 1 } },
      { start: { x: 1, y: 1 }, end: { x: 1, y: 0 } },
      { start: { x: 1, y: 0 }, end: { x: 0, y: 1 } },
    ]);
  });

  it("applies transforms, restores them and enters form XObjects", () => {
    const { segments } = readPdfLines(
      [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.constructPath],
      [null, [2, 0, 0, 2, 100, 0], path(OPS.stroke, M, 0, 0, L, 10, 0), null, [[1, 0, 0, 1, 0, 100], [0, 0, 1, 1]], path(OPS.stroke, M, 0, 0, L, 10, 0), null, path(OPS.stroke, M, 0, 0, L, 10, 0)],
      OPS, [1, 0, 0, 1, 0, 0], 1000, 1000,
    );
    expect(segments).toEqual([
      { start: { x: 0.1, y: 0 }, end: { x: 0.12, y: 0 } },
      { start: { x: 0, y: 0.1 }, end: { x: 0.01, y: 0.1 } },
      { start: { x: 0, y: 0 }, end: { x: 0.01, y: 0 } },
    ]);
  });

  it("skips clipping paths, curves, zero-length edges and malformed data", () => {
    const { segments } = readPdfLines(
      [OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.transform],
      [
        path(END_PATH, M, 0, 0, L, 100, 0),
        path(OPS.stroke, M, 0, 0, C, 10, 10, 20, 10, 30, 0, L, 40, 0, L, 40, 0),
        [OPS.stroke, ["not numbers"], null],
        path(OPS.stroke, M, 0, 0, 9, 5, 5, L, 50, 50),
        ["bad matrix"],
      ],
      OPS, [1, 0, 0, 1, 0, 0], 100, 100,
    );
    // Only the straight edge after the curve: from the curve's end point.
    expect(segments).toEqual([{ start: { x: 0.3, y: 0 }, end: { x: 0.4, y: 0 } }]);
    expect(readPdfLines([OPS.constructPath], [path(OPS.stroke, M, 0, 0, L, 1, 1)], OPS, [1, 0, 0], 100, 100).segments).toEqual([]);
  });

  it("stops at the segment limit and reports it", () => {
    const data = [M, 0, 0];
    for (let index = 1; index <= MAX_PDF_SEGMENTS + 5; index++) data.push(L, index, index % 2);
    const { segments, truncated } = readPdfLines([OPS.constructPath], [path(OPS.stroke, ...data)], OPS, [1, 0, 0, 1, 0, 0], 100_000, 100);
    expect(segments).toHaveLength(MAX_PDF_SEGMENTS);
    expect(truncated).toBe(true);
  });
});
