import type { LineSegment } from "@/domain/floor-plan/wall-candidates";

/**
 * Straight segments of painted vector paths on a PDF page, read from the pdf.js
 * operator list. Coordinates are fractions of the rendered page (0..1 across its
 * width and height), so they stay valid after the raster is resized for the project.
 * Text, images and clipping paths contribute nothing; curves only move the pen.
 */
export interface PdfLines {
  segments: LineSegment[];
  /** The page had more segments than the limit; only the first ones are kept. */
  truncated: boolean;
}

export const MAX_PDF_SEGMENTS = 20_000;

/** The pdf.js operator codes this reader needs (values of `pdfjs.OPS`). */
export interface PdfOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

/** pdf.js DrawOPS codes inside constructPath data. */
const MOVE_TO = 0, LINE_TO = 1, CURVE_TO = 2, QUADRATIC_TO = 3, CLOSE_PATH = 4;

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const isMatrix = (value: unknown): value is Matrix =>
  Array.isArray(value) && value.length === 6 && value.every((item) => typeof item === "number" && Number.isFinite(item));

const isNumbers = (value: unknown): value is ArrayLike<number> =>
  (ArrayBuffer.isView(value) && !(value instanceof DataView)) || Array.isArray(value);

/**
 * @param viewport  pdf.js viewport transform of the rendered page (PDF space → canvas pixels)
 * @param width     rendered canvas width in pixels
 * @param height    rendered canvas height in pixels
 */
export function readPdfLines(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: PdfOps,
  viewport: readonly number[],
  width: number,
  height: number,
): PdfLines {
  const segments: LineSegment[] = [];
  let truncated = false;
  if (!isMatrix(viewport) || !(width > 0) || !(height > 0)) return { segments, truncated };
  const painting = new Set([
    ops.stroke, ops.closeStroke, ops.fill, ops.eoFill,
    ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke,
  ]);
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  const push = (x1: number, y1: number, x2: number, y2: number, matrix: Matrix) => {
    if (x1 === x2 && y1 === y2) return;
    if (segments.length >= MAX_PDF_SEGMENTS) {
      truncated = true;
      return;
    }
    const map = (x: number, y: number) => ({
      x: (matrix[0] * x + matrix[2] * y + matrix[4]) / width,
      y: (matrix[1] * x + matrix[3] * y + matrix[5]) / height,
    });
    const start = map(x1, y1), end = map(x2, y2);
    if ([start.x, start.y, end.x, end.y].every(Number.isFinite)) segments.push({ start, end });
  };

  for (let index = 0; index < fnArray.length; index++) {
    const fn = fnArray[index];
    const args = argsArray[index];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === ops.transform) {
      if (isMatrix(args)) ctm = multiply(ctm, args);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = Array.isArray(args) ? args[0] : null;
      if (isMatrix(matrix)) ctm = multiply(ctm, matrix);
    } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (fn === ops.constructPath && Array.isArray(args)) {
      const [paint, buffers] = args as [unknown, unknown];
      // Clipping paths end with endPath and are never painted.
      if (typeof paint !== "number" || !painting.has(paint) || !Array.isArray(buffers)) continue;
      const data = buffers[0];
      if (!isNumbers(data)) continue;
      const matrix = multiply(viewport, ctm);
      let x = 0, y = 0, startX = 0, startY = 0;
      for (let i = 0; i < data.length;) {
        const op = data[i++];
        if (op === MOVE_TO) {
          x = startX = data[i++];
          y = startY = data[i++];
        } else if (op === LINE_TO) {
          const nx = data[i++], ny = data[i++];
          push(x, y, nx, ny, matrix);
          x = nx;
          y = ny;
        } else if (op === CURVE_TO) {
          i += 4;
          x = data[i++];
          y = data[i++];
        } else if (op === QUADRATIC_TO) {
          i += 2;
          x = data[i++];
          y = data[i++];
        } else if (op === CLOSE_PATH) {
          push(x, y, startX, startY, matrix);
          x = startX;
          y = startY;
        } else break; // Unknown data: stop reading this path rather than misalign.
      }
    }
  }
  return { segments, truncated };
}
