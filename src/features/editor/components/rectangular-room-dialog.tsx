"use client";

import { useEffect, useRef, useState } from "react";
import { BrickWall, X } from "lucide-react";
import type { RectangularWallRoomInput } from "@/domain/floor-plan/rectangular-wall-room";
import { formatArea } from "@/lib/format";

const parse = (value: string) =>
  value.trim() ? Number(value.replace(",", ".")) : NaN;

export function RectangularRoomDialog({
  x,
  onClose,
  onCreate,
  error,
  busy,
}: {
  x: number;
  onClose: () => void;
  onCreate: (input: RectangularWallRoomInput) => void;
  error: string | null;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState({
    x: String(x), y: "0", width: "5", depth: "4",
    thickness: "0.2", wallHeight: "2.7",
  });
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const area = parse(draft.width) * parse(draft.depth);
  const field = (key: keyof typeof draft, label: string) => (
    <div>
      <label htmlFor={`rectangle-${key}`}>{label}</label>
      <div className="unit-input">
        <input
          id={`rectangle-${key}`}
          inputMode="decimal"
          value={draft[key]}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
        <span>м</span>
      </div>
    </div>
  );
  return (
    <dialog
      ref={ref}
      className="project-dialog rectangular-room-dialog"
      aria-labelledby="rectangle-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button className="icon-button modal-close" aria-label="Закрыть" onClick={onClose}>
        <X size={18} />
      </button>
      <div className="dialog-symbol"><BrickWall size={25} /></div>
      <span className="eyebrow">ТОЧНАЯ ГЕОМЕТРИЯ</span>
      <h2 id="rectangle-title">Прямоугольная комната</h2>
      <p>
        Четыре связанные стены и пол в 2D и 3D. Размеры измеряются внутри стен;
        их толщина добавляется наружу.
      </p>
      <form
        className="rectangle-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({
            x: parse(draft.x), y: parse(draft.y),
            width: parse(draft.width), depth: parse(draft.depth),
            thickness: parse(draft.thickness), wallHeight: parse(draft.wallHeight),
          });
        }}
      >
        <div className="field-pair">
          {field("width", "Внутренняя ширина")}
          {field("depth", "Внутренняя глубина")}
        </div>
        <div className="field-pair">
          {field("thickness", "Толщина стен")}
          {field("wallHeight", "Высота стен")}
        </div>
        <div className="field-pair">
          {field("x", "Внутренний угол X")}
          {field("y", "Внутренний угол Y")}
        </div>
        <p className="rectangle-area-preview">
          Площадь по размерам: <strong>
            {Number.isFinite(area) && parse(draft.width) > 0 && parse(draft.depth) > 0
              ? formatArea(area) : "—"}
          </strong>
        </p>
        <p className="rectangle-form-note">
          Будет включён расчёт помещений по стенам. Ручные комнаты останутся
          в проекте и доступны в режиме «Вручную».
        </p>
        {error && <p className="construction-error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>
          Создать комнату со стенами <BrickWall size={16} />
        </button>
      </form>
    </dialog>
  );
}
