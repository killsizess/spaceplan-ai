import type { FloorPlan } from "@/domain/floor-plan/types";
import { createRasterPdfDocument, type RasterPdfInput } from "@/lib/raster-pdf";
import { createPlanExportLayout, DEFAULT_EXPORT_OPTIONS } from "../editor/export-layout";
import { blobBytes, canvasBlob, rasterizePlanExport, releaseCanvas } from "../editor/export-files";
import type { PlanReport } from "./plan-report";
import { layoutPlanReport, REPORT_PAGE, type MeasureText, type ReportPage } from "./report-layout";

const REPORT_DPI = 200;
export const REPORT_FONT = '"Onest Variable", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

const fontOf = (size: number, weight: number) => `${weight} ${size}px ${REPORT_FONT}`;

function drawPage(context: CanvasRenderingContext2D, page: ReportPage) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, REPORT_PAGE.width, REPORT_PAGE.height);
  context.textBaseline = "alphabetic";
  for (const op of page.ops) {
    if (op.kind === "rect") {
      context.fillStyle = op.fill;
      context.beginPath();
      context.roundRect(op.x, op.y, op.width, op.height, op.radius ?? 0);
      context.fill();
    } else {
      context.font = fontOf(op.size, op.weight);
      context.fillStyle = op.color;
      context.textAlign = op.align ?? "left";
      context.fillText(op.text, op.x, op.y);
    }
  }
}

/**
 * The report as a PDF: its pages and, when the plan is valid, the drawing as a last page.
 * Text is rendered into page images, so it reads and prints correctly but cannot be selected.
 */
export function createPlanReportPdf(plan: FloorPlan, report: PlanReport, signal: AbortSignal): Promise<Blob> {
  return createPagedPdf(plan, (measure) => layoutPlanReport(report, measure), signal);
}

/** Any document laid out in report pages, with the drawing of the plan after them. */
export async function createPagedPdf(plan: FloorPlan, layOut: (measure: MeasureText) => ReportPage[], signal: AbortSignal): Promise<Blob> {
  await document.fonts.ready;
  signal.throwIfAborted();
  const measuring = document.createElement("canvas").getContext("2d");
  if (!measuring) throw new Error("Браузер не смог подготовить отчёт.");
  const measure = (text: string, size: number, weight: number) => {
    // Measured large and scaled down: canvas metrics at very small sizes are coarse.
    measuring.font = fontOf(size * 20, weight);
    return measuring.measureText(text).width / 20;
  };
  const pages = layOut(measure);
  const scale = REPORT_DPI / 25.4;
  const output: RasterPdfInput[] = [];
  for (const page of pages) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(REPORT_PAGE.width * scale);
    canvas.height = Math.round(REPORT_PAGE.height * scale);
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Браузер не смог подготовить отчёт.");
      context.scale(canvas.width / REPORT_PAGE.width, canvas.height / REPORT_PAGE.height);
      drawPage(context, page);
      const jpeg = await blobBytes(await canvasBlob(canvas, "image/jpeg", signal), signal);
      output.push({ jpeg, widthPixels: canvas.width, heightPixels: canvas.height, widthMm: REPORT_PAGE.width, heightMm: REPORT_PAGE.height });
    } finally {
      releaseCanvas(canvas);
    }
  }
  // The drawing is an appendix: a plan it cannot be drawn for still gets its report.
  let layout: ReturnType<typeof createPlanExportLayout> | null = null;
  try {
    layout = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
  } catch {
    layout = null;
  }
  if (layout) {
    const canvas = await rasterizePlanExport(layout, signal, REPORT_DPI);
    try {
      const jpeg = await blobBytes(await canvasBlob(canvas, "image/jpeg", signal), signal);
      output.push({ jpeg, widthPixels: canvas.width, heightPixels: canvas.height, widthMm: layout.widthMm, heightMm: layout.heightMm });
    } finally {
      releaseCanvas(canvas);
    }
  }
  return new Blob([createRasterPdfDocument(output)], { type: "application/pdf" });
}
