"use client";

import { tr } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileImage, LoaderCircle, X } from "lucide-react";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { formatArea } from "@/lib/format";
import {
  createPlanExportLayout,
  DEFAULT_EXPORT_OPTIONS,
  type PlanExportOptions,
} from "../export-layout";
import { createPlanExportBlob, makePlanExportFilename } from "../export-files";
import "../plan-export.css";

export default function PlanExportDialog({
  plan,
  isCurrent,
  onClose,
}: {
  plan: FloorPlan;
  isCurrent: () => boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [options, setOptions] = useState<PlanExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [format, setFormat] = useState<"png" | "pdf">("png");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const result = useMemo(() => {
    try {
      return { layout: createPlanExportLayout(plan, options), error: "" };
    } catch (cause: unknown) {
      return {
        layout: null,
        error: cause instanceof Error ? cause.message : tr`Не удалось подготовить план.`,
      };
    }
  }, [plan, options]);
  const { layout } = result;
  const error = result.error || downloadError;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      operation.current?.abort();
      dialog?.close();
    };
  }, []);

  function changeOptions(next: PlanExportOptions) {
    setOptions(next);
    setMessage("");
    setDownloadError("");
  }

  function close() {
    operation.current?.abort();
    dialogRef.current?.close();
    onClose();
  }

  async function download() {
    if (!layout || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setMessage("");
    setDownloadError("");
    try {
      if (!isCurrent()) throw new Error(tr`План изменился. Откройте экспорт заново.`);
      const blob = await createPlanExportBlob(layout, format, controller.signal);
      if (controller.signal.aborted) return;
      if (!isCurrent()) throw new Error(tr`План изменился. Откройте экспорт заново.`);
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = makePlanExportFilename(plan.name, format);
        document.body.appendChild(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
        setMessage(tr`Файл ${format.toUpperCase()} передан браузеру для скачивания.`);
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        setDownloadError(cause instanceof Error ? cause.message : tr`Не удалось скачать файл.`);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-export-dialog"
      aria-labelledby="plan-export-title"
      aria-describedby="plan-export-description"
      data-status={busy ? "rendering" : error ? "error" : "ready"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <button className="icon-button modal-close" aria-label={tr`Закрыть экспорт плана`} onClick={close}>
        <X size={18} />
      </button>
      <header className="plan-export-header">
        <span className="plan-export-symbol" aria-hidden="true"><FileImage size={24} /></span>
        <div>
          <span className="eyebrow">{tr`ПЛАН, КОТОРЫМ МОЖНО ПОДЕЛИТЬСЯ`}</span>
          <h2 id="plan-export-title">{tr`Экспорт плана`}</h2>
          <p title={plan.name}>{plan.name}</p>
        </div>
      </header>
      <div className="plan-export-body">
        <div className="plan-export-settings">
          <label htmlFor="plan-export-format">{tr`Формат экспорта`}</label>
          <select id="plan-export-format" autoFocus value={format} disabled={busy} onChange={(event) => {
            setFormat(event.target.value === "pdf" ? "pdf" : "png");
            setMessage("");
            setDownloadError("");
          }}>
            <option value="png">{tr`PNG - изображение`}</option>
            <option value="pdf">{tr`PDF - лист для печати`}</option>
          </select>
          <label htmlFor="plan-export-orientation">{tr`Ориентация листа`}</label>
          <select id="plan-export-orientation" value={options.orientation} disabled={busy} onChange={(event) => changeOptions({
            ...options, orientation: event.target.value === "portrait" ? "portrait" : "landscape",
          })}>
            <option value="landscape">{tr`Альбомная · A4`}</option>
            <option value="portrait">{tr`Книжная · A4`}</option>
          </select>
          <label htmlFor="plan-export-scale">{tr`Масштаб печати`}</label>
          <select id="plan-export-scale" value={options.scale} disabled={busy} onChange={(event) => changeOptions({
            ...options, scale: event.target.value === "auto" ? "auto" : Number(event.target.value),
          })}>
            <option value="auto">{tr`Подобрать под лист`}</option>
            {[20, 50, 100, 200, 500, 1000].map((scale) => <option key={scale} value={scale}>1:{scale}</option>)}
          </select>
          <label className="plan-export-checkbox">
            <input type="checkbox" checked={options.dimensions} disabled={busy} onChange={(event) => changeOptions({
              ...options, dimensions: event.target.checked,
            })} />{tr`Показывать размеры`}</label>
          <div className="plan-export-specs">
            <span>A4 <b>{layout ? `${layout.widthMm} × ${layout.heightMm}` : options.orientation === "landscape" ? "297 × 210" : "210 × 297"}{tr` мм`}</b></span>
            <span>{tr`Качество `}<b>300 dpi</b></span>
            {layout && <>
              <span>{tr`На листе `}<b>1:{layout.scaleDenominator}</b></span>
              <span>{tr`Площадь `}<b>{formatArea(layout.totalArea)}</b></span>
              <span>{tr`Помещений `}<b>{layout.roomCount}</b></span>
            </>}
          </div>
          <p id="plan-export-description">{tr`Печатайте в масштабе 100%, без подгонки под страницу. Подложка и элементы редактора в файл не входят.`}</p>
        </div>
        <div
          className="plan-export-preview"
          data-testid="plan-export-preview"
          data-scale={layout?.scaleDenominator}
          data-width-mm={layout?.widthMm}
          data-height-mm={layout?.heightMm}
        >
          {layout ? <div
            className="plan-export-sheet"
            role="img"
            aria-label={tr`Предпросмотр экспорта плана`}
            // SVG is generated locally from validated geometry; all model text is XML-escaped.
            dangerouslySetInnerHTML={{ __html: layout.svg }}
          /> : <div className="plan-export-empty"><FileImage size={32} /><span>{tr`Нет предпросмотра`}</span></div>}
        </div>
      </div>
      <footer className="plan-export-footer">
        {layout && layout.warnings.length > 0 && <ul className="plan-export-warnings">{layout.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        {error && <p role="alert" className="plan-export-error">{error}</p>}
        <div className="plan-export-footer-row">
          <div aria-live="polite" role="status">
            {busy ? tr`Готовим файл…` : message || (format === "pdf" ? tr`PDF: растровый план 300 dpi, текст без выделения.` : tr`PNG: изображение A4 с разрешением 300 dpi.`)}
          </div>
          <div className="plan-export-actions">
            <button className="plan-export-close" onClick={close}>{busy ? tr`Отменить` : tr`Закрыть`}</button>
            <button className="primary-button" disabled={!layout || busy} onClick={() => void download()}>
              {busy ? <LoaderCircle className="plan-export-spinner" size={16} /> : <Download size={16} />}
              {busy ? tr`Подготовка…` : tr`Скачать ${format.toUpperCase()}`}
            </button>
          </div>
        </div>
      </footer>
    </dialog>
  );
}
