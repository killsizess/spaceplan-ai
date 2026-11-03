"use client";

import { useId, useRef, type ReactNode } from "react";
import { FileUp, ImagePlus, Move, Ruler, Trash2 } from "lucide-react";
import type { Underlay } from "@/domain/floor-plan/types";
import "../construction.css";

export function UnderlayPanel({
  underlay,
  busy,
  onUpload,
  onChange,
  onCalibrate,
  onMove,
  children,
}: {
  underlay?: Underlay;
  busy: boolean;
  onUpload: (file: File) => void;
  onChange: (underlay: Underlay | null) => void;
  onCalibrate: () => void;
  onMove: () => void;
  /** Extra tools for the current underlay (walls from a PDF page). */
  children?: ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <section className="underlay-panel" aria-label="Подложка плана">
      <div className="underlay-heading">
        <ImagePlus size={15} />
        <h2>Подложка плана</h2>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        aria-label="Изображение плана JPG или PNG"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
          event.target.value = "";
        }}
      />
      <button
        className="underlay-upload"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      >
        <ImagePlus size={16} />
        {busy
          ? "Подготовка изображения…"
          : underlay
            ? "Заменить JPG / PNG"
            : "Загрузить JPG / PNG"}
      </button>
      <input
        ref={pdfRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        aria-label="Файл плана PDF"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
          event.target.value = "";
        }}
      />
      <button
        className="underlay-upload"
        onClick={() => pdfRef.current?.click()}
        disabled={busy}
      >
        <FileUp size={16} />
        {underlay ? "Заменить из PDF" : "Загрузить PDF"}
      </button>
      {underlay ? (
        <>
          <p className="underlay-filename" title={underlay.name}>
            {underlay.name}
          </p>
          <div className="underlay-controls">
            <label className="underlay-checkbox" htmlFor={`${id}-visible`}>
              <input
                id={`${id}-visible`}
                type="checkbox"
                checked={underlay.visible}
                disabled={busy}
                onChange={(event) =>
                  onChange({ ...underlay, visible: event.target.checked })
                }
              />
              Показывать подложку
            </label>
            <label className="underlay-opacity-label" htmlFor={`${id}-opacity`}>
              Непрозрачность <span>{Math.round(underlay.opacity * 100)}%</span>
            </label>
            <input
              id={`${id}-opacity`}
              className="underlay-opacity"
              type="range"
              min="0"
              max="100"
              step="5"
              value={Math.round(underlay.opacity * 100)}
              disabled={busy}
              onChange={(event) =>
                onChange({
                  ...underlay,
                  opacity: Number(event.target.value) / 100,
                })
              }
            />
            <span
              className={`underlay-scale-status ${underlay.calibrated ? "calibrated" : ""}`}
            >
              {underlay.calibrated
                ? "Масштаб настроен"
                : "Масштаб ещё не настроен"}
            </span>
            <div className="underlay-action-pair">
              <button
                onClick={onCalibrate}
                disabled={busy || !underlay.visible}
              >
                <Ruler size={14} />
                Масштаб
              </button>
              <button onClick={onMove} disabled={busy || !underlay.visible}>
                <Move size={14} />
                Сдвинуть
              </button>
            </div>
            <button
              className="underlay-remove"
              onClick={() => onChange(null)}
              disabled={busy}
            >
              <Trash2 size={13} />
              Удалить подложку
            </button>
            {children}
          </div>
        </>
      ) : null}
      <p className="underlay-help">
        JPG / PNG до 12 МБ. Изображение сохраняется в проекте; для экономии
        места оно уменьшается до 2048 px и сжимается. Обработка — в браузере.{" "}
        PDF до 25 МБ: выберите страницу, затем задайте масштаб.
      </p>
    </section>
  );
}
