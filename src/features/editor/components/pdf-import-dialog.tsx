"use client";

import { tr } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import type { Underlay } from "@/domain/floor-plan/types";
import { openLocalPdf, type LocalPdfDocument } from "../underlay-pdf";
import type { PdfLines } from "../pdf-vector-lines";
import { underlayFromCanvas } from "../underlay-image";
import "../pdf-import.css";

type LoadedPdf = {
  file: File;
  attempt: number;
} & (
  | { document: LocalPdfDocument; error: null }
  | { document: null; error: string }
);

type RenderedPage = {
  document: LocalPdfDocument;
  pageNumber: number;
  rotation: number;
  attempt: number;
} & (
  /** Lines are optional: a page whose paths cannot be read still imports as a raster. */
  | { canvas: HTMLCanvasElement; lines: PdfLines | null; error: null }
  | { canvas: null; lines: null; error: string }
);

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : tr`Не удалось открыть страницу PDF. Попробуйте другой файл.`;
}

function PdfPreview({
  canvas,
  page,
}: {
  canvas: HTMLCanvasElement;
  page: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", tr`Предпросмотр страницы PDF ${page}`);
    host.current?.replaceChildren(canvas);
    return () => canvas.remove();
  }, [canvas, page]);
  return <div className="pdf-preview-canvas" ref={host} />;
}

export default function PdfImportDialog({
  file,
  onApply,
  onClose,
}: {
  file: File;
  onApply: (underlay: Underlay, lines: PdfLines | null) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const [selection, setSelection] = useState({
    file,
    pageNumber: 1,
    rotation: 0,
    draft: "1",
    error: "",
  });
  const [applyError, setApplyError] = useState<{
    file: File;
    message: string;
  } | null>(null);
  const currentSelection =
    selection.file === file
      ? selection
      : { file, pageNumber: 1, rotation: 0, draft: "1", error: "" };
  const { pageNumber, rotation, draft } = currentSelection;
  const currentLoad =
    loaded?.file === file && loaded.attempt === loadAttempt ? loaded : null;
  const pdf = currentLoad?.document ?? null;
  const currentRender =
    rendered?.document === pdf &&
    rendered.pageNumber === pageNumber &&
    rendered.rotation === rotation &&
    rendered.attempt === renderAttempt
      ? rendered
      : null;
  const canvas = currentRender?.canvas ?? null;
  const error = currentLoad?.error ?? currentRender?.error ?? null;
  const status = error ? "error" : canvas ? "ready" : "loading";
  const isValidPage =
    draft.trim() !== "" &&
    Number.isInteger(Number(draft)) &&
    Number(draft) >= 1 &&
    Number(draft) <= (pdf?.numPages ?? 0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let ownedDocument: LocalPdfDocument | null = null;
    void openLocalPdf(file, controller.signal).then(
      (document) => {
        if (controller.signal.aborted) {
          void document.destroy().catch(() => {});
          return;
        }
        ownedDocument = document;
        setLoaded({ file, attempt: loadAttempt, document, error: null });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded({
            file,
            attempt: loadAttempt,
            document: null,
            error: errorMessage(cause),
          });
        }
      },
    );
    return () => {
      controller.abort();
      if (ownedDocument) void ownedDocument.destroy().catch(() => {});
    };
  }, [file, loadAttempt]);

  useEffect(() => {
    if (!pdf) return;
    const controller = new AbortController();
    let ownedCanvas: HTMLCanvasElement | null = null;
    void pdf.renderPage(pageNumber, rotation, controller.signal).then(
      async (pageCanvas) => {
        if (controller.signal.aborted) {
          pageCanvas.width = 0;
          pageCanvas.height = 0;
          return;
        }
        // Owned before waiting, so an abort during the line read still releases it.
        ownedCanvas = pageCanvas;
        const lines = await pdf
          .pageLines(pageNumber, rotation, controller.signal)
          .catch(() => null);
        if (controller.signal.aborted) return;
        setRendered({
          document: pdf,
          pageNumber,
          rotation,
          attempt: renderAttempt,
          canvas: pageCanvas,
          lines,
          error: null,
        });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setRendered({
            document: pdf,
            pageNumber,
            rotation,
            attempt: renderAttempt,
            canvas: null,
            lines: null,
            error: errorMessage(cause),
          });
        }
      },
    );
    return () => {
      controller.abort();
      if (ownedCanvas) {
        ownedCanvas.width = 0;
        ownedCanvas.height = 0;
      }
    };
  }, [pdf, pageNumber, rotation, renderAttempt]);

  function changePage(nextPage: number) {
    if (!pdf || nextPage < 1 || nextPage > pdf.numPages) return;
    setSelection({
      ...currentSelection,
      pageNumber: nextPage,
      draft: String(nextPage),
      error: "",
    });
    setApplyError(null);
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog pdf-import-dialog"
      aria-labelledby="pdf-import-title"
      aria-describedby="pdf-import-description"
      data-status={status}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="icon-button modal-close"
        aria-label={tr`Закрыть импорт PDF`}
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <header className="pdf-import-header">
        <span className="pdf-import-symbol" aria-hidden="true">
          <FileText size={23} />
        </span>
        <div>
          <span className="eyebrow">{tr`ПОДЛОЖКА ИЗ ДОКУМЕНТА`}</span>
          <h2 id="pdf-import-title">{tr`Выберите страницу PDF`}</h2>
          <p className="pdf-import-filename" title={file.name}>
            {file.name}
          </p>
        </div>
      </header>

      <div className="pdf-import-controls">
        <div className="pdf-page-navigation">
          <button
            type="button"
            className="pdf-control-button pdf-page-arrow"
            aria-label={tr`Предыдущая страница`}
            disabled={!pdf || pageNumber <= 1}
            onClick={() => changePage(pageNumber - 1)}
          >
            <ArrowLeft size={17} />
          </button>
          <label className="pdf-page-label" htmlFor="pdf-page-number">{tr`Страница`}</label>
          <input
            id="pdf-page-number"
            className="pdf-page-input"
            aria-label={tr`Страница PDF`}
            aria-invalid={currentSelection.error ? true : undefined}
            aria-describedby={
              currentSelection.error ? "pdf-page-error" : undefined
            }
            type="number"
            inputMode="numeric"
            min={1}
            max={pdf?.numPages ?? 1}
            step={1}
            value={draft}
            disabled={!pdf}
            onChange={(event) => {
              const nextDraft = event.target.value;
              const nextPage = Number(nextDraft);
              const valid =
                nextDraft.trim() !== "" &&
                Number.isInteger(nextPage) &&
                nextPage >= 1 &&
                nextPage <= (pdf?.numPages ?? 0);
              setSelection({
                ...currentSelection,
                draft: nextDraft,
                pageNumber: valid ? nextPage : pageNumber,
                error: "",
              });
              setApplyError(null);
            }}
            onBlur={() => {
              if (!isValidPage) {
                setSelection({
                  ...currentSelection,
                  error: tr`Введите номер от 1 до ${pdf?.numPages ?? 1}.`,
                });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="pdf-page-total">{tr`из `}{pdf?.numPages ?? "…"}</span>
          <button
            type="button"
            className="pdf-control-button pdf-page-arrow"
            aria-label={tr`Следующая страница`}
            disabled={!pdf || pageNumber >= pdf.numPages}
            onClick={() => changePage(pageNumber + 1)}
          >
            <ArrowRight size={17} />
          </button>
        </div>
        <button
          type="button"
          className="pdf-control-button pdf-rotate-button"
          aria-label={tr`Повернуть страницу`}
          disabled={!pdf}
          onClick={() => {
            setSelection({
              ...currentSelection,
              rotation: (rotation + 90) % 360,
            });
            setApplyError(null);
          }}
        >
          <RotateCw size={16} />{tr`Повернуть`}<span>{rotation}°</span>
        </button>
        {currentSelection.error && (
          <span id="pdf-page-error" className="pdf-page-error" role="alert">
            {currentSelection.error}
          </span>
        )}
      </div>

      <div
        className="pdf-preview"
        data-testid="pdf-preview"
        data-page={pageNumber}
        data-rotation={rotation}
        data-status={status}
        data-width={canvas?.width}
        data-height={canvas?.height}
        aria-busy={status === "loading"}
      >
        {canvas ? (
          <PdfPreview canvas={canvas} page={pageNumber} />
        ) : error ? (
          <div className="pdf-preview-message">
            <FileText size={28} aria-hidden="true" />
            <p role="alert">{error}</p>
            <button
              type="button"
              className="pdf-control-button"
              onClick={() => {
                if (pdf) setRenderAttempt((attempt) => attempt + 1);
                else setLoadAttempt((attempt) => attempt + 1);
                setApplyError(null);
              }}
            >{tr`Попробовать ещё раз`}</button>
          </div>
        ) : (
          <div className="pdf-preview-message" role="status">
            <LoaderCircle
              className="pdf-loading-icon"
              size={26}
              aria-hidden="true"
            />
            <p>{pdf ? tr`Готовим страницу ${pageNumber}…` : tr`Открываем PDF…`}</p>
          </div>
        )}
      </div>

      <footer className="pdf-import-footer">
        <p id="pdf-import-description">{tr`Страница станет изображением для обводки. PDF обрабатывается на вашем устройстве. После добавления задайте масштаб по двум точкам.`}</p>
        {applyError?.file === file && (
          <p className="pdf-apply-error" role="alert">
            {applyError.message}
          </p>
        )}
        <div className="pdf-import-actions">
          <button type="button" className="pdf-cancel-button" onClick={onClose}>{tr`Отмена`}</button>
          <button
            type="button"
            className="primary-button"
            disabled={!canvas || !isValidPage || Number(draft) !== pageNumber}
            onClick={() => {
              if (!canvas || !isValidPage || Number(draft) !== pageNumber)
                return;
              try {
                const suffix = tr` · стр. ${pageNumber}`;
                const name = `${(file.name || tr`План PDF`).slice(0, 160 - suffix.length)}${suffix}`;
                onApply(underlayFromCanvas(canvas, name), currentRender?.lines ?? null);
              } catch (cause: unknown) {
                setApplyError({ file, message: errorMessage(cause) });
              }
            }}
          >
            <Check size={16} />{tr`Использовать страницу`}</button>
        </div>
      </footer>
    </dialog>
  );
}
