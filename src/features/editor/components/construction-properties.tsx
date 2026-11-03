"use client";

import { useMemo, useState } from "react";
import {
  Check,
  DoorOpen,
  Move,
  Ruler,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { DoorSwing, Opening, Wall } from "@/domain/floor-plan/types";
import { DEFAULT_DOOR_SWING, doorSwingLocal } from "@/domain/floor-plan/door-swing";
import { connectedWallIds } from "@/domain/floor-plan/wall-nodes";
import { wallMoveContext } from "@/domain/floor-plan/move-wall";
import { wallLength, type Point } from "@/domain/geometry";
import "../construction.css";

interface ConstructionPropertiesProps {
  wall?: Wall;
  opening?: Opening;
  walls: Wall[];
  onUpdateWall: (wall: Wall, connectEndpoints?: boolean) => void;
  /** Explicit whole-wall move that carries corners, T-junctions and openings. */
  onMoveWall: (wallId: string, delta: Point) => void;
  /** CAD-style offset along the wall's normal that keeps other walls' directions. */
  onOffsetWall: (wallId: string, distance: number) => void;
  keepDirections: boolean;
  onKeepDirectionsChange: (value: boolean) => void;
  onUpdateOpening: (opening: Opening) => void;
  onDelete: () => void;
  error?: string | null;
}

const parse = (value: string) =>
  value.trim() ? Number(value.replace(",", ".")) : NaN;
const lengthInput = (value: number) => String(Number(value.toFixed(12)));

function MeterField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <div className="unit-input">
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>м</span>
      </div>
    </div>
  );
}

export function ConstructionProperties(props: ConstructionPropertiesProps) {
  if (props.opening)
    return (
      <OpeningProperties
        key={JSON.stringify(props.opening)}
        {...props}
        opening={props.opening}
      />
    );
  if (props.wall)
    return (
      <WallProperties
        key={JSON.stringify(props.wall)}
        {...props}
        wall={props.wall}
      />
    );
  return null;
}

function PropertiesHeader({ opening }: { opening?: Opening }) {
  return (
    <>
      <div className="properties-heading">
        <span>
          <SlidersHorizontal size={15} />
          {opening ? "Свойства проёма" : "Свойства стены"}
        </span>
        <span className="small-tag">м</span>
      </div>
      <div className="construction-selected">
        <div className="construction-symbol">
          {opening ? <DoorOpen size={25} /> : <Ruler size={25} />}
        </div>
        <div>
          <span className="eyebrow">ВЫБРАНО НА ПЛАНЕ</span>
          <h2>
            {opening
              ? opening.kind === "door"
                ? "Дверной проём"
                : "Оконный проём"
              : "Стена"}
          </h2>
        </div>
      </div>
    </>
  );
}

function DeleteButton({
  opening,
  onDelete,
}: {
  opening?: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="properties-footer">
      <button
        className="danger-button"
        aria-label={opening ? "Удалить проём" : "Удалить стену"}
        onClick={onDelete}
      >
        <Trash2 size={15} />
        {opening ? "Удалить проём" : "Удалить стену"}
        <kbd>Del</kbd>
      </button>
    </div>
  );
}

/** An empty shift field means no shift along that axis. */
const parseShift = (value: string) => (value.trim() ? parse(value) : 0);

function WallMoveForm({
  wall,
  walls,
  onMoveWall,
  onOffsetWall,
  keepDirections,
  onKeepDirectionsChange,
}: {
  wall: Wall;
  walls: Wall[];
  onMoveWall: (wallId: string, delta: Point) => void;
  onOffsetWall: (wallId: string, distance: number) => void;
  keepDirections: boolean;
  onKeepDirectionsChange: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState({ x: "0", y: "0" });
  const [localError, setLocalError] = useState<string | null>(null);
  const context = useMemo(() => {
    try {
      return wallMoveContext(walls, wall.id);
    } catch {
      return null;
    }
  }, [walls, wall.id]);
  const offsetMode = keepDirections && context !== null && !context.offsetBlocked;
  const x = parseShift(draft.x);
  const y = parseShift(draft.y);
  const ready = !Number.isFinite(x) || !Number.isFinite(y) || x !== 0 || y !== 0;
  const change = (field: "x" | "y") => (value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setLocalError(null);
  };
  return (
    <form
      className="properties-form construction-form wall-move-form"
      aria-label="Перенос стены"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          setLocalError("Введите сдвиг числами.");
          return;
        }
        if (offsetMode && context) {
          const { normal } = context;
          // The axis is the normal turned back by 90°.
          if (Math.abs(x * normal.y - y * normal.x) > 1e-9) {
            setLocalError("Когда соседние стены сохраняют направление, стена сдвигается только поперёк себя. Уберите сдвиг вдоль стены или снимите флажок.");
            return;
          }
          setLocalError(null);
          onOffsetWall(wall.id, x * normal.x + y * normal.y);
          return;
        }
        setLocalError(null);
        onMoveWall(wall.id, { x, y });
      }}
    >
      <div className="section-label">ПЕРЕНОС СТЕНЫ</div>
      <div className="field-pair">
        <MeterField id="wall-move-x" label="Сдвиг по X" value={draft.x} onChange={change("x")} />
        <MeterField id="wall-move-y" label="Сдвиг по Y" value={draft.y} onChange={change("y")} />
      </div>
      <label className="wall-connections-toggle">
        <input
          id="wall-keep-directions"
          type="checkbox"
          checked={keepDirections}
          onChange={(event) => {
            onKeepDirectionsChange(event.target.checked);
            setLocalError(null);
          }}
        />
        Соседние стены сохраняют направление
      </label>
      <p className="wall-connections-note" data-testid="wall-move-mode-note">
        {!keepDirections
          ? "Обычный перенос: всё, что примыкает к стене, сдвигается вместе с ней на тот же вектор; соседние стены могут повернуться."
          : context?.offsetBlocked
            ? `${context.offsetBlocked} Ручка и поля выполнят обычный перенос.`
            : "Стена сдвигается поперёк себя; стены в её углах и примыкающие к ней удлиняются или укорачиваются по своим линиям, не поворачиваясь."}
      </p>
      {localError && (
        <p className="construction-error" role="alert">
          {localError}
        </p>
      )}
      <button className="secondary-button apply-button" type="submit" disabled={!ready}>
        <Move size={15} />
        Перенести стену
      </button>
      <p className="field-note">
        Проёмы переносимой стены едут вместе с ней, проёмы соседних стен остаются
        на месте плана. Перенос, который оторвал бы соединение, свернул соседнюю
        стену или срезал проём, отклоняется. На плане то же делает круглая ручка
        сбоку от стены.
      </p>
    </form>
  );
}

function WallProperties({
  wall,
  walls,
  onUpdateWall,
  onMoveWall,
  onOffsetWall,
  keepDirections,
  onKeepDirectionsChange,
  onDelete,
  error,
}: ConstructionPropertiesProps & { wall: Wall }) {
  const [draft, setDraft] = useState({
    startX: String(wall.start.x),
    startY: String(wall.start.y),
    endX: String(wall.end.x),
    endY: String(wall.end.y),
    thickness: String(wall.thickness),
    height: String(wall.height),
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectEndpoints, setConnectEndpoints] = useState(true);
  const [length, setLength] = useState(lengthInput(wallLength(wall.start, wall.end)));
  const linkedStart = connectedWallIds(walls, wall.start).filter(
    (id) => id !== wall.id,
  ).length;
  const linkedEnd = connectedWallIds(walls, wall.end).filter(
    (id) => id !== wall.id,
  ).length;
  const change = (field: keyof typeof draft) => (value: string) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    if (field !== "thickness" && field !== "height") {
      const distance = Math.hypot(
        parse(next.endX) - parse(next.startX),
        parse(next.endY) - parse(next.startY),
      );
      setLength(Number.isFinite(distance) ? lengthInput(distance) : "");
    }
    setLocalError(null);
  };
  const changed =
    parse(draft.startX) !== wall.start.x ||
    parse(draft.startY) !== wall.start.y ||
    parse(draft.endX) !== wall.end.x ||
    parse(draft.endY) !== wall.end.y ||
    parse(draft.thickness) !== wall.thickness ||
    parse(draft.height) !== wall.height ||
    !Number.isFinite(parse(length)) ||
    Math.abs(parse(length) - wallLength(wall.start, wall.end)) > 1e-9;
  return (
    <>
      <PropertiesHeader />
      <form
        className="properties-form construction-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (
            Object.values(draft).some((value) => !Number.isFinite(parse(value))) ||
            !Number.isFinite(parse(length)) ||
            parse(length) <= 0
          ) {
            setLocalError("Заполните все размеры и координаты числами.");
            return;
          }
          setLocalError(null);
          onUpdateWall(
            {
              ...wall,
              start: { x: parse(draft.startX), y: parse(draft.startY) },
              end: { x: parse(draft.endX), y: parse(draft.endY) },
              thickness: parse(draft.thickness),
              height: parse(draft.height),
            },
            connectEndpoints,
          );
        }}
      >
        <div className="section-label">НАЧАЛО СТЕНЫ</div>
        <div className="field-pair">
          <MeterField
            id="wall-start-x"
            label="Начало X"
            value={draft.startX}
            onChange={change("startX")}
          />
          <MeterField
            id="wall-start-y"
            label="Начало Y"
            value={draft.startY}
            onChange={change("startY")}
          />
        </div>
        <div className="section-label">КОНЕЦ СТЕНЫ</div>
        <div className="field-pair">
          <MeterField
            id="wall-end-x"
            label="Конец X"
            value={draft.endX}
            onChange={change("endX")}
          />
          <MeterField
            id="wall-end-y"
            label="Конец Y"
            value={draft.endY}
            onChange={change("endY")}
          />
        </div>
        <div className="section-label">РАЗМЕРЫ</div>
        <MeterField
          id="wall-length"
          label="Длина стены"
          value={length}
          onChange={(value) => {
            setLength(value);
            setLocalError(null);
            const distance = parse(value);
            const start = { x: parse(draft.startX), y: parse(draft.startY) };
            const dx = parse(draft.endX) - start.x;
            const dy = parse(draft.endY) - start.y;
            const current = Math.hypot(dx, dy);
            if (
              Number.isFinite(distance) && distance > 0 &&
              current > 0 && Number.isFinite(current)
            ) {
              const rounded = (coordinate: number) => String(Math.round(coordinate * 1e12) / 1e12);
              setDraft({
                ...draft,
                endX: rounded(start.x + dx / current * distance),
                endY: rounded(start.y + dy / current * distance),
              });
            }
          }}
        />
        <div className="field-pair">
          <MeterField
            id="wall-thickness"
            label="Толщина стены"
            value={draft.thickness}
            onChange={change("thickness")}
          />
          <MeterField
            id="wall-height"
            label="Высота стены"
            value={draft.height}
            onChange={change("height")}
          />
        </div>
        <label className="wall-connections-toggle">
          <input
            type="checkbox"
            checked={connectEndpoints}
            onChange={(event) => setConnectEndpoints(event.target.checked)}
          />
          Сохранять соединения
        </label>
        <p className="wall-connections-note">
          В начале: {linkedStart} соседних стен. В конце: {linkedEnd}.
          {connectEndpoints ? " Общие углы двигаются вместе." : " Меняется только выбранная стена."}
        </p>
        {(localError || error) && (
          <p className="construction-error" role="alert">
            {localError || error}
          </p>
        )}
        <button
          className="primary-button apply-button"
          type="submit"
          disabled={!changed}
        >
          <Check size={15} />
          Применить свойства
        </button>
        <p className="field-note">
          Размеры — в метрах, длина — по оси стены. Начало и направление
          сохраняются при вводе длины. Если проём перестанет помещаться в стене,
          изменение будет отклонено.
        </p>
      </form>
      <WallMoveForm
        wall={wall}
        walls={walls}
        onMoveWall={onMoveWall}
        onOffsetWall={onOffsetWall}
        keepDirections={keepDirections}
        onKeepDirectionsChange={onKeepDirectionsChange}
      />
      <DeleteButton onDelete={onDelete} />
    </>
  );
}

function DoorSwingPreview({ door }: { door: DoorSwing }) {
  const geometry = doorSwingLocal({
    id: "preview", wallId: "preview-wall", kind: "door", offset: 0,
    width: 1, height: 2, sillHeight: 0, door,
  });
  if (!geometry) return null;
  return <div className="door-swing-preview" data-testid="door-swing-preview" data-hinge={door.hinge} data-side={door.side}>
    <svg viewBox="0 0 240 128" role="img" aria-label="Схема открывания двери">
      <g transform="translate(97 64) scale(46)">
        <path d="M-1.2 0 H0 M1 0 H2.2" stroke="#778570" strokeWidth="0.12" />
        <polyline points={geometry.arc.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke="#7c9670" strokeWidth="0.025" strokeDasharray="0.08 0.05" />
        <line x1={geometry.hinge.x} y1={geometry.hinge.y} x2={geometry.openEnd.x} y2={geometry.openEnd.y} stroke="#446d46" strokeWidth="0.065" strokeLinecap="round" />
        <circle cx={geometry.hinge.x} cy={geometry.hinge.y} r="0.065" fill="#446d46" />
      </g>
    </svg>
    <span>Начало стены <b aria-hidden="true">→</b> конец стены</span>
  </div>;
}

function OpeningProperties({
  opening,
  walls,
  onUpdateOpening,
  onDelete,
  error,
}: ConstructionPropertiesProps & { opening: Opening }) {
  const [kind, setKind] = useState(opening.kind);
  const [wallId, setWallId] = useState(opening.wallId);
  const [door, setDoor] = useState<DoorSwing>(opening.door ?? DEFAULT_DOOR_SWING);
  const [draft, setDraft] = useState({
    offset: String(opening.offset),
    width: String(opening.width),
    height: String(opening.height),
    sillHeight: String(opening.sillHeight),
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const change = (field: keyof typeof draft) => (value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setLocalError(null);
  };
  const changed =
    kind !== opening.kind ||
    wallId !== opening.wallId ||
    parse(draft.offset) !== opening.offset ||
    parse(draft.width) !== opening.width ||
    parse(draft.height) !== opening.height ||
    parse(draft.sillHeight) !== opening.sillHeight ||
    (kind === "door" && (
      door.hinge !== (opening.door ?? DEFAULT_DOOR_SWING).hinge ||
      door.side !== (opening.door ?? DEFAULT_DOOR_SWING).side
    ));
  return (
    <>
      <PropertiesHeader opening={opening} />
      <form
        className="properties-form construction-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (
            Object.values(draft).some((value) => !Number.isFinite(parse(value)))
          ) {
            setLocalError("Заполните размеры проёма числами.");
            return;
          }
          setLocalError(null);
          const next: Opening = {
            ...opening,
            kind,
            wallId,
            offset: parse(draft.offset),
            width: parse(draft.width),
            height: parse(draft.height),
            sillHeight: parse(draft.sillHeight),
          };
          if (kind === "door") next.door = { ...door };
          else delete next.door;
          onUpdateOpening(next);
        }}
      >
        <label htmlFor="opening-kind">Тип проёма</label>
        <select
          id="opening-kind"
          value={kind}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "door" || value === "window") {
              setKind(value);
              if (value === "door")
                setDraft((previous) => ({ ...previous, sillHeight: "0" }));
            }
            setLocalError(null);
          }}
        >
          <option value="door">Дверь</option>
          <option value="window">Окно</option>
        </select>
        <label htmlFor="opening-wall">Стена проёма</label>
        <select
          id="opening-wall"
          value={wallId}
          onChange={(event) => {
            setWallId(event.target.value);
            setLocalError(null);
          }}
        >
          {walls.map((wall, index) => (
            <option key={wall.id} value={wall.id}>
              Стена {index + 1}
            </option>
          ))}
        </select>
        <div className="section-label">РАЗМЕРЫ И ПОЛОЖЕНИЕ</div>
        <MeterField
          id="opening-offset"
          label="Отступ от начала стены"
          value={draft.offset}
          onChange={change("offset")}
        />
        <div className="field-pair">
          <MeterField
            id="opening-width"
            label="Ширина проёма"
            value={draft.width}
            onChange={change("width")}
          />
          <MeterField
            id="opening-height"
            label="Высота проёма"
            value={draft.height}
            onChange={change("height")}
          />
        </div>
        <MeterField
          id="opening-sill-height"
          label="Высота от пола"
          value={draft.sillHeight}
          onChange={change("sillHeight")}
        />
        {kind === "door" && <fieldset className="door-swing-controls">
          <legend>ОТКРЫВАНИЕ ДВЕРИ</legend>
          <label htmlFor="door-hinge">Петли двери</label>
          <select id="door-hinge" value={door.hinge} onChange={(event) => {
            const hinge = event.target.value;
            if (hinge === "start" || hinge === "end") setDoor((previous) => ({ ...previous, hinge }));
            setLocalError(null);
          }}>
            <option value="start">У начала проёма</option>
            <option value="end">У конца проёма</option>
          </select>
          <label htmlFor="door-side">Сторона открывания</label>
          <select id="door-side" value={door.side} onChange={(event) => {
            const side = event.target.value;
            if (side === "left" || side === "right") setDoor((previous) => ({ ...previous, side }));
            setLocalError(null);
          }}>
            <option value="left">Слева от направления стены</option>
            <option value="right">Справа от направления стены</option>
          </select>
          <DoorSwingPreview door={door} />
          <p className="field-note">Сторона определяется по направлению от начала стены к концу. Полотно показано открытым на 90°.</p>
        </fieldset>}
        {(localError || error) && (
          <p className="construction-error" role="alert">
            {localError || error}
          </p>
        )}
        <button
          className="primary-button apply-button"
          type="submit"
          disabled={!changed}
        >
          <Check size={15} />
          Применить свойства
        </button>
        <p className="field-note">
          Отступ измеряется вдоль стены до ближнего края проёма. Проём должен
          помещаться в стене и не пересекать другие проёмы.
        </p>
      </form>
      <DeleteButton opening onDelete={onDelete} />
    </>
  );
}
