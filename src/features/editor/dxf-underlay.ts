import { tr } from "@/lib/i18n";
import type { DxfGeometry } from "@/domain/floor-plan/dxf";
import type { Underlay } from "@/domain/floor-plan/types";
import type { PdfLines } from "./pdf-vector-lines";
import { underlayFromCanvas } from "./underlay-image";

/** White space around the drawing on the underlay image, in metres. */
export const DXF_MARGIN_METRES = 0.5;
const PIXELS_PER_METRE = 150;
const MAX_EDGE = 2048;

export function dxfPixelsPerMetre(geometry: Pick<DxfGeometry, "width" | "height">): number {
  const longest = Math.max(geometry.width, geometry.height) + 2 * DXF_MARGIN_METRES;
  return Math.min(PIXELS_PER_METRE, MAX_EDGE / longest);
}

/** Draws the chosen layers. `scale` is pixels per metre; the margin is included. */
export function drawDxfGeometry(context: CanvasRenderingContext2D, geometry: DxfGeometry, scale: number, lineWidth: number) {
  const { canvas } = context;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#20302a";
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  const x = (value: number) => (value + DXF_MARGIN_METRES) * scale;
  const y = (value: number) => (value + DXF_MARGIN_METRES) * scale;
  context.beginPath();
  for (const segment of geometry.segments) {
    context.moveTo(x(segment.start.x), y(segment.start.y));
    context.lineTo(x(segment.end.x), y(segment.end.y));
  }
  for (const curve of geometry.curves) {
    curve.points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(point.x), y(point.y));
      else context.lineTo(x(point.x), y(point.y));
    });
  }
  context.stroke();
}

export function dxfCanvasSize(geometry: Pick<DxfGeometry, "width" | "height">, scale: number) {
  return {
    width: Math.max(1, Math.ceil((geometry.width + 2 * DXF_MARGIN_METRES) * scale)),
    height: Math.max(1, Math.ceil((geometry.height + 2 * DXF_MARGIN_METRES) * scale)),
  };
}

/**
 * Puts a rendered image where the drawing is. The scale comes from the file's units,
 * so the underlay is calibrated from the start; `pagePixels` is the width it was drawn at.
 */
export function placeDxfUnderlay(underlay: Underlay, scale: number, pagePixels: number): Underlay {
  return {
    ...underlay,
    x: -DXF_MARGIN_METRES,
    y: -DXF_MARGIN_METRES,
    metersPerPixel: pagePixels / scale / underlay.pixelWidth,
    opacity: 0.55,
    calibrated: true,
  };
}

/** The drawing's lines as fractions of the underlay image, the form PDF lines have too. */
export function dxfLinesForUnderlay(geometry: DxfGeometry, underlay: Underlay, truncated: boolean): PdfLines {
  const width = underlay.pixelWidth * underlay.metersPerPixel;
  const height = underlay.pixelHeight * underlay.metersPerPixel;
  const page = (point: { x: number; y: number }) => ({
    x: (point.x - underlay.x) / width,
    y: (point.y - underlay.y) / height,
  });
  return {
    segments: geometry.segments.map((segment) => ({ start: page(segment.start), end: page(segment.end) })),
    curves: geometry.curves.map((curve) => ({ points: curve.points.map(page) })),
    truncated,
  };
}

/** The underlay and lines for the plan; browser only. */
export function createDxfUnderlay(geometry: DxfGeometry, name: string, truncated: boolean): { underlay: Underlay; lines: PdfLines } {
  const scale = dxfPixelsPerMetre(geometry);
  const size = dxfCanvasSize(geometry, scale);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(tr`Браузер не смог подготовить изображение чертежа.`);
  drawDxfGeometry(context, geometry, scale, 1.4);
  try {
    const underlay = placeDxfUnderlay(underlayFromCanvas(canvas, name), scale, size.width);
    return { underlay, lines: dxfLinesForUnderlay(geometry, underlay, truncated) };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
