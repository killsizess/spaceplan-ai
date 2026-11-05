import { tr } from "@/lib/i18n";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist";
import { readPdfLines, type PdfLines } from "./pdf-vector-lines";

export const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_EDGE = 2048;
const OPERATION_TIMEOUT_MS = 30_000;

export interface LocalPdfDocument {
  numPages: number;
  renderPage: (
    pageNumber: number,
    rotation: number,
    signal: AbortSignal,
  ) => Promise<HTMLCanvasElement>;
  /** Vector path segments of the page, in fractions of the raster `renderPage` gives. */
  pageLines: (
    pageNumber: number,
    rotation: number,
    signal: AbortSignal,
  ) => Promise<PdfLines>;
  destroy: () => Promise<void>;
}

/** The viewport and canvas size shared by the raster and the vector lines. */
function pageViewport(page: PDFPageProxy, rotation: number) {
  const angle = (page.rotate + rotation) % 360;
  const original = page.getViewport({ scale: 1, rotation: angle });
  const size = pdfPageSize(original.width, original.height);
  return { size, viewport: page.getViewport({ scale: size.scale, rotation: angle }) };
}

export function inspectPdfHeader(bytes: Uint8Array, fileSize: number): void {
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize < 1 ||
    fileSize > MAX_PDF_FILE_BYTES
  ) {
    throw new Error(tr`Выберите непустой PDF размером до 25 МБ.`);
  }
  // PDF readers allow a small prefix before the header.
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 1024));
  if (!/%PDF-(?:1\.[0-7]|2\.0)(?:\s|$)/.test(header)) {
    throw new Error(tr`Содержимое файла не соответствует PDF.`);
  }
}

export function pdfPageSize(width: number, height: number) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(tr`Некорректные размеры страницы PDF.`);
  }
  const scale = MAX_PAGE_EDGE / Math.max(width, height);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(tr`Некорректные размеры страницы PDF.`);
  }
  return {
    scale,
    width: Math.min(MAX_PAGE_EDGE, Math.max(1, Math.ceil(width * scale))),
    height: Math.min(MAX_PAGE_EDGE, Math.max(1, Math.ceil(height * scale))),
  };
}

function abortError() {
  return new DOMException(tr`Операция отменена.`, "AbortError");
}

/** Stop waiting immediately; the cancel callback also releases the worker/render task. */
function cancellable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cancel: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {});
      cancel();
      reject(abortError());
      return;
    }
    let finished = false;
    const finish = (action: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      action();
    };
    const aborted = () =>
      finish(() => {
        cancel();
        reject(abortError());
      });
    // Always subscribe to the underlying promise, even if already aborted.
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    const timeout = setTimeout(
      () =>
        finish(() => {
          cancel();
          reject(
            new Error(
              tr`PDF обрабатывается слишком долго. Попробуйте файл с меньшим числом страниц или сохраните нужный лист отдельно.`,
            ),
          );
        }),
      OPERATION_TIMEOUT_MS,
    );
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function pdfError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return new Error(
      tr`PDF защищён паролем. Откройте его в своём PDF-редакторе и сохраните копию без пароля.`,
    );
  }
  if (name === "InvalidPDFException" || name === "FormatError") {
    return new Error(
      tr`Не удалось прочитать PDF: файл повреждён или имеет неподдерживаемый формат.`,
    );
  }
  if (error instanceof Error && !/worker|fetch|network/i.test(error.message))
    return error;
  return new Error(
    tr`Не удалось открыть PDF. Обновите страницу и попробуйте ещё раз.`,
  );
}

/** The PDF bytes and worker never enter the saved project; only a selected raster does. */
export async function openLocalPdf(
  file: File,
  signal: AbortSignal,
): Promise<LocalPdfDocument> {
  let loading: PDFDocumentLoadingTask | undefined;
  let destruction: Promise<void> | undefined;
  const destroy = () => {
    if (!destruction)
      destruction = loading?.destroy().catch(() => {}) ?? Promise.resolve();
    return destruction;
  };
  const cancel = () => {
    void destroy();
  };
  let pdf: PDFDocumentProxy;
  let ops: typeof import("pdfjs-dist").OPS;
  try {
    inspectPdfHeader(
      new Uint8Array(
        await cancellable(file.slice(0, 1024).arrayBuffer(), signal, cancel),
      ),
      file.size,
    );
    const bytes = new Uint8Array(
      await cancellable(file.arrayBuffer(), signal, cancel),
    );
    const pdfjs = await cancellable(import("pdfjs-dist"), signal, cancel);
    signal.throwIfAborted();
    ops = pdfjs.OPS;
    const assetBase = `/pdfjs/${pdfjs.version}/`;
    pdfjs.GlobalWorkerOptions.workerSrc = `${assetBase}pdf.worker.min.mjs`;
    loading = pdfjs.getDocument({
      data: bytes,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      wasmUrl: `${assetBase}wasm/`,
      iccUrl: `${assetBase}iccs/`,
      useWorkerFetch: true,
      stopAtErrors: true,
      enableXfa: false,
      // Resize large raster decodes rather than silently omitting them from the plan.
      canvasMaxAreaInBytes: 16 * 1024 * 1024,
    });
    pdf = await cancellable(loading.promise, signal, cancel);
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
      throw new Error(tr`В PDF нет страниц для импорта.`);
    }
    signal.throwIfAborted();
  } catch (error) {
    await destroy();
    throw pdfError(error);
  }

  const checkPage = (pageNumber: number, rotation: number) => {
    if (destruction) throw abortError();
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > pdf.numPages ||
      ![0, 90, 180, 270].includes(rotation)
    ) {
      throw new Error(
        tr`Выберите существующую страницу PDF и поворот с шагом 90°.`,
      );
    }
  };
  return {
    numPages: pdf.numPages,
    destroy,
    async pageLines(pageNumber, rotation, linesSignal) {
      checkPage(pageNumber, rotation);
      try {
        const page = await cancellable(pdf.getPage(pageNumber), linesSignal, () => {});
        linesSignal.throwIfAborted();
        if (destruction) throw abortError();
        const { size, viewport } = pageViewport(page, rotation);
        // The display operator list is the one rendering just built, so this is cheap.
        const list = await cancellable(page.getOperatorList(), linesSignal, () => {});
        linesSignal.throwIfAborted();
        return readPdfLines(list.fnArray, list.argsArray, ops, viewport.transform, size.width, size.height);
      } catch (error) {
        throw pdfError(error);
      }
    },
    async renderPage(pageNumber, rotation, renderSignal) {
      checkPage(pageNumber, rotation);
      let canvas: HTMLCanvasElement | undefined;
      try {
        const page = await cancellable(
          pdf.getPage(pageNumber),
          renderSignal,
          () => {},
        );
        renderSignal.throwIfAborted();
        if (destruction) throw abortError();
        const { size, viewport } = pageViewport(page, rotation);
        canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const rendering = page.render({
          canvas,
          viewport,
          background: "#ffffff",
        });
        try {
          await cancellable(rendering.promise, renderSignal, () =>
            rendering.cancel(),
          );
        } catch (error) {
          // Wait for cancellation before resizing/releasing a canvas in use.
          await rendering.promise.catch(() => {});
          throw error;
        }
        renderSignal.throwIfAborted();
        return canvas;
      } catch (error) {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        throw pdfError(error);
      }
    },
  };
}
