"use client";

import { tr } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { Ruler, X } from "lucide-react";
import type { Point } from "@/domain/geometry";
import type { Underlay } from "@/domain/floor-plan/types";
import "../construction.css";

export function CalibrationDialog({
  start,
  end,
  underlay,
  onApply,
  onClose,
  error,
}: {
  start: Point;
  end: Point;
  underlay: Underlay;
  onApply: (knownMeters: number) => void;
  onClose: () => void;
  error?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="project-dialog calibration-dialog"
      aria-labelledby="calibration-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        className="icon-button modal-close"
        aria-label={tr`Закрыть настройку масштаба`}
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="dialog-symbol">
        <Ruler size={25} />
      </div>
      <span className="eyebrow">{tr`ТОЧНЫЙ МАСШТАБ`}</span>
      <h2 id="calibration-title">{tr`Укажите известный размер`}</h2>
      <p>{tr`Введите реальную длину отрезка между двумя отмеченными точками, например 4 м для стены. Изменится масштаб подложки; существующие комнаты и стены сохранят свои размеры.`}</p>
      <p className="calibration-source" title={underlay.name}>
        {underlay.name}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const meters = value.trim() ? Number(value.replace(",", ".")) : NaN;
          if (!Number.isFinite(meters) || meters < 0.1 || meters > 100) {
            setValidationError(tr`Укажите длину от 0,1 до 100 м.`);
            return;
          }
          if (start.x === end.x && start.y === end.y) {
            setValidationError(
              tr`Точки совпадают. Закройте окно и отметьте другой отрезок.`,
            );
            return;
          }
          setValidationError(null);
          onApply(meters);
        }}
      >
        <label htmlFor="calibration-length">{tr`Известная длина, м`}</label>
        <input
          id="calibration-length"
          inputMode="decimal"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setValidationError(null);
          }}
          placeholder={tr`Например, 4`}
          autoFocus
        />
        {(validationError || error) && (
          <p className="construction-error" role="alert">
            {validationError || error}
          </p>
        )}
        <button className="primary-button" type="submit">
          <Ruler size={16} />{tr`Применить масштаб`}</button>
      </form>
    </dialog>
  );
}
