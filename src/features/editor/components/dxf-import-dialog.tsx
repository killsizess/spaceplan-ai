"use client";

import { tr } from "@/lib/i18n";
import { sizeText } from "@/lib/units";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, DraftingCompass, Layers, LoaderCircle, X } from "lucide-react";
import {
  decodeDxf,
  DXF_UNIT_CHOICES,
  dxfGeometry,
  MAX_DXF_FILE_BYTES,
  parseDxf,
  type DxfDrawing,
  type DxfGeometry,
} from "@/domain/floor-plan/dxf";
import type { Underlay } from "@/domain/floor-plan/types";
import { createDxfUnderlay, drawDxfGeometry, dxfCanvasSize } from "../dxf-underlay";
import type { PdfLines } from "../pdf-vector-lines";
import "../pdf-import.css";
import "../dxf-import.css";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : tr`Не удалось прочитать чертёж.`);

/** The drawing fitted into the preview box. */
function DxfPreview({ geometry }: { geometry: DxfGeometry }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const longest = 900;
    const scale = longest / (Math.max(geometry.width, geometry.height) + 1);
    const size = dxfCanvasSize(geometry, scale);
    canvas.width = size.width;
    canvas.height = size.height;
    drawDxfGeometry(context, geometry, scale, 1.2);
  }, [geometry]);
  return <canvas ref={canvasRef} aria-label={tr`Предпросмотр выбранных слоёв чертежа`} />;
}

/**
 * Importing a DXF: the file's units decide the scale, the user chooses which layers are
 * the plan. A unit the file does not state must be chosen; it is never assumed.
 */
export default function DxfImportDialog({
  file,
  onApply,
  onClose,
}: {
  file: File;
  onApply: (underlay: Underlay, lines: PdfLines) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [drawing, setDrawing] = useState<DxfDrawing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [off, setOff] = useState<ReadonlySet<string> | null>(null);
  const [chosenUnit, setChosenUnit] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (file.size > MAX_DXF_FILE_BYTES) {
          throw new Error(tr`Файл больше ${MAX_DXF_FILE_BYTES / 1024 / 1024} МБ. Удалите из чертежа лишнее или сохраните только план этажа.`);
        }
        const parsed = parseDxf(decodeDxf(new Uint8Array(await file.arrayBuffer())));
        if (cancelled) return;
        if (!parsed.segments.length && !parsed.curves.length) {
          throw new Error(tr`В чертеже нет линий и дуг в пространстве модели. Проверьте, что план не лежит только на листе.`);
        }
        setDrawing(parsed);
      } catch (cause) {
        if (!cancelled) setLoadError(message(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const hidden = useMemo<ReadonlySet<string>>(
    () => off ?? new Set(drawing?.layers.filter((layer) => !layer.visible).map((layer) => layer.name)),
    [off, drawing],
  );
  const metresPerUnit = chosenUnit ?? drawing?.units.metresPerUnit ?? null;
  const preview = useMemo(() => {
    if (!drawing || metresPerUnit === null) return { geometry: null, error: null };
    try {
      const chosen = new Set(drawing.layers.map((layer) => layer.name).filter((name) => !hidden.has(name)));
      return { geometry: dxfGeometry(drawing, metresPerUnit, chosen), error: null };
    } catch (cause) {
      return { geometry: null, error: message(cause) };
    }
  }, [drawing, metresPerUnit, hidden]);

  const toggle = (name: string) => {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOff(next);
    setApplyError(null);
  };

  const status = loadError ? "error" : drawing ? "ready" : "loading";
  return (
    <dialog
      ref={dialogRef}
      className="project-dialog pdf-import-dialog dxf-import-dialog"
      aria-labelledby="dxf-import-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button type="button" className="icon-button modal-close" aria-label={tr`Закрыть импорт DXF`} onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="pdf-import-header">
        <span className="pdf-import-symbol">
          <DraftingCompass size={22} aria-hidden="true" />
        </span>
        <div>
          <h2 id="dxf-import-title">{tr`Импорт чертежа DXF`}</h2>
          <p className="pdf-import-filename" title={file.name}>{file.name}</p>
        </div>
      </header>

      <div className="dxf-import-body" data-testid="dxf-import" data-status={status}>
        <div className="pdf-preview dxf-preview" data-testid="dxf-preview">
          {preview.geometry ? (
            <DxfPreview geometry={preview.geometry} />
          ) : (
            <div className="pdf-preview-message" role={loadError || preview.error ? "alert" : "status"}>
              {status === "loading" && <LoaderCircle className="pdf-loading-icon" size={26} aria-hidden="true" />}
              <p>
                {loadError ??
                  preview.error ??
                  (status === "loading"
                    ? tr`Читаем чертёж…`
                    : metresPerUnit === null
                      ? tr`Выберите единицы чертежа, чтобы увидеть его размер.`
                      : tr`Включите хотя бы один слой с линиями.`)}
              </p>
            </div>
          )}
        </div>

        {drawing && (
          <aside className="dxf-import-side">
            <label htmlFor="dxf-units">{tr`Единицы чертежа`}</label>
            <select
              id="dxf-units"
              value={metresPerUnit ?? ""}
              onChange={(event) => {
                setChosenUnit(Number(event.target.value));
                setApplyError(null);
              }}
            >
              {metresPerUnit === null && <option value="">{tr`Выберите…`}</option>}
              {DXF_UNIT_CHOICES.map((unit) => (
                <option key={unit.label} value={unit.metresPerUnit}>{unit.label}</option>
              ))}
            </select>
            <p className="dxf-import-note" data-testid="dxf-units-note">
              {drawing.units.metresPerUnit !== null
                ? tr`В файле указано: ${drawing.units.label}.`
                : tr`В файле единицы не указаны. Выберите их сами: по ним считаются все размеры.`}
            </p>
            {preview.geometry && (
              <p className="dxf-import-size" data-testid="dxf-size">
                {sizeText(preview.geometry.width, preview.geometry.height)}<small>{tr`Проверьте: это похоже на размер плана?`}</small>
              </p>
            )}
            <h3>
              <Layers size={13} aria-hidden="true" />{tr` Слои `}<span data-testid="dxf-layer-count">{drawing.layers.length}</span>
            </h3>
            <ul className="dxf-layer-list" aria-label={tr`Слои чертежа`}>
              {drawing.layers.map((layer) => (
                <li key={layer.name}>
                  <label>
                    <input type="checkbox" checked={!hidden.has(layer.name)} onChange={() => toggle(layer.name)} />
                    <span title={layer.name}>{layer.name}</span>
                    <small>{layer.segments + layer.curves}</small>
                  </label>
                </li>
              ))}
            </ul>
            <p className="dxf-import-note">{tr`Оставьте слои со стенами, дверями и окнами. Мебель и оформление лучше выключить: они мешают искать стены.`}</p>
            {drawing.warnings.map((warning) => (
              <p key={warning} className="dxf-import-warning" role="status">{warning}</p>
            ))}
          </aside>
        )}
      </div>

      <footer className="pdf-import-footer">
        <p>{tr`Файл обрабатывается на вашем устройстве. Масштаб берётся из единиц чертежа, отдельно задавать его не нужно.`}</p>
        {applyError && <p className="pdf-apply-error" role="alert">{applyError}</p>}
        <div className="pdf-import-actions">
          <button type="button" className="pdf-cancel-button" onClick={onClose}>{tr`Отмена`}</button>
          <button
            type="button"
            className="primary-button"
            disabled={!preview.geometry}
            onClick={() => {
              if (!preview.geometry || !drawing) return;
              try {
                const { underlay, lines } = createDxfUnderlay(preview.geometry, file.name.slice(0, 160) || tr`Чертёж DXF`, drawing.truncated);
                onApply(underlay, lines);
              } catch (cause) {
                setApplyError(message(cause));
              }
            }}
          >
            <Check size={16} />{tr`Использовать чертёж`}</button>
        </div>
      </footer>
    </dialog>
  );
}
