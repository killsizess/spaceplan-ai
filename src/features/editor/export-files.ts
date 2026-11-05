import { tr } from "@/lib/i18n";
import { assertA4Page, assertRasterSize, createRasterPdf } from "@/lib/raster-pdf";
import type { PlanExportLayout } from "./export-layout";

export type PlanExportFormat = "png" | "pdf";
export const PLAN_EXPORT_DPI = 300;
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_SVG_CHARACTERS = 5 * 1024 * 1024;

function abortError() {
  return new DOMException(tr`Экспорт отменён.`, "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** The caller owns the returned canvas and must release it after use. */
export async function rasterizePlanExport(
  layout: PlanExportLayout,
  signal: AbortSignal,
  dpi = PLAN_EXPORT_DPI,
): Promise<HTMLCanvasElement> {
  checkAbort(signal);
  assertA4Page(layout.widthMm, layout.heightMm);
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 600) {
    throw new Error(tr`Некорректное разрешение экспорта.`);
  }
  const width = Math.round((layout.widthMm * dpi) / 25.4);
  const height = Math.round((layout.heightMm * dpi) / 25.4);
  assertRasterSize(width, height);
  if (
    typeof layout.svg !== "string" ||
    !layout.svg.trimStart().startsWith("<svg") ||
    layout.svg.length > MAX_SVG_CHARACTERS
  ) {
    throw new Error(tr`Не удалось подготовить изображение плана.`);
  }
  const image = new Image();
  image.decoding = "async";
  const objectUrl = URL.createObjectURL(new Blob([layout.svg], { type: "image/svg+xml;charset=utf-8" }));
  let canvas: HTMLCanvasElement | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        signal.removeEventListener("abort", aborted);
        action();
      };
      const aborted = () => finish(() => reject(abortError()));
      const timeout = setTimeout(
        () => finish(() => reject(new Error(tr`Изображение плана обрабатывается слишком долго. Попробуйте ещё раз.`))),
        OPERATION_TIMEOUT_MS,
      );
      image.onload = () => finish(resolve);
      image.onerror = () => finish(() => reject(new Error(tr`Не удалось отрисовать план для экспорта.`)));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else image.src = objectUrl;
    });
    checkAbort(signal);
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(tr`Браузер не поддерживает создание изображения плана.`);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    checkAbort(signal);
    return canvas;
  } catch (error) {
    if (canvas) releaseCanvas(canvas);
    throw error;
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    URL.revokeObjectURL(objectUrl);
  }
}

export function canvasBlob(canvas: HTMLCanvasElement, mime: string, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      action();
    };
    const aborted = () => finish(() => reject(abortError()));
    const timeout = setTimeout(
      () => finish(() => reject(new Error(tr`Браузер слишком долго создаёт файл. Попробуйте ещё раз.`))),
      OPERATION_TIMEOUT_MS,
    );
    signal.addEventListener("abort", aborted, { once: true });
    try {
      canvas.toBlob(
        (blob) => finish(() => {
          if (blob && blob.size > 0 && blob.type === mime) resolve(blob);
          else reject(new Error(tr`Браузер не смог создать файл плана.`));
        }),
        mime,
        mime === "image/jpeg" ? 0.95 : undefined,
      );
    } catch {
      finish(() => reject(new Error(tr`Не удалось сохранить изображение плана.`)));
    }
  });
}

export function blobBytes(blob: Blob, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      action();
    };
    const aborted = () => finish(() => reject(abortError()));
    const timeout = setTimeout(
      () => finish(() => reject(new Error(tr`Не удалось прочитать изображение для экспорта.`))),
      OPERATION_TIMEOUT_MS,
    );
    signal.addEventListener("abort", aborted, { once: true });
    blob.arrayBuffer().then(
      (buffer) => finish(() => resolve(new Uint8Array(buffer))),
      () => finish(() => reject(new Error(tr`Не удалось прочитать изображение для экспорта.`))),
    );
  });
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Canvas encoders default to 96 dpi; PNG pHYs preserves the actual print scale. */
export function setPngPrintResolution(bytes: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    !Number.isFinite(dpi) || dpi <= 0 || dpi > 600 ||
    !signature.every((value, index) => bytes[index] === value)
  ) throw new Error(tr`Не удалось подготовить PNG для экспорта.`);
  const density = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4);
  chunkView.setUint32(8, density);
  chunkView.setUint32(12, density);
  chunk[16] = 1;
  chunkView.setUint32(17, crc32(chunk.subarray(4, 17)));
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 8;
  let inserted = false;
  let ended = false;
  while (cursor + 12 <= bytes.length) {
    const length = view.getUint32(cursor);
    const end = cursor + length + 12;
    if (end > bytes.length) throw new Error(tr`Изображение PNG повреждено.`);
    const type = String.fromCharCode(...bytes.subarray(cursor + 4, cursor + 8));
    if (cursor === 8 && (type !== "IHDR" || length !== 13)) throw new Error(tr`Изображение PNG повреждено.`);
    if (type !== "pHYs") parts.push(bytes.subarray(cursor, end));
    if (!inserted && type === "IHDR") {
      parts.push(chunk);
      inserted = true;
    }
    cursor = end;
    if (type === "IEND") {
      ended = length === 0 && cursor === bytes.length;
      break;
    }
  }
  if (!inserted || !ended) throw new Error(tr`Изображение PNG повреждено.`);
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Creates a file only; the dialog checks its captured plan before downloading. */
export async function createPlanExportBlob(
  layout: PlanExportLayout,
  format: PlanExportFormat,
  signal: AbortSignal,
): Promise<Blob> {
  checkAbort(signal);
  if (format !== "png" && format !== "pdf") throw new Error(tr`Неизвестный формат экспорта.`);
  const canvas = await rasterizePlanExport(layout, signal);
  try {
    checkAbort(signal);
    const image = await canvasBlob(canvas, format === "png" ? "image/png" : "image/jpeg", signal);
    const bytes = await blobBytes(image, signal);
    checkAbort(signal);
    const output = format === "png"
      ? setPngPrintResolution(bytes, PLAN_EXPORT_DPI)
      : createRasterPdf({
        jpeg: bytes,
        widthPixels: canvas.width,
        heightPixels: canvas.height,
        widthMm: layout.widthMm,
        heightMm: layout.heightMm,
      });
    checkAbort(signal);
    return new Blob([output], { type: format === "png" ? "image/png" : "application/pdf" });
  } finally {
    releaseCanvas(canvas);
  }
}

export function makePlanExportFilename(name: string, format: PlanExportFormat): string {
  const sanitized = name.normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .replace(/\.(?:pdf|png)$/i, "")
    .trim();
  const safe = sanitized.slice(0, 100).replace(/[. ]+$/g, "") || "SpacePlan-AI";
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe);
  return `${reserved ? `SpacePlan-${safe}` : safe}.${format}`;
}
