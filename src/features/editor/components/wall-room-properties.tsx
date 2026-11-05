"use client";

import { tr } from "@/lib/i18n";
import { BrickWall, Check, Ruler, ScanLine } from "lucide-react";
import { useState } from "react";
import type { RoomKind } from "@/domain/floor-plan/types";
import type { ResolvedWallRoom, WallRoomLabelValues } from "@/domain/floor-plan/wall-room-labels";
import { formatArea, formatLength } from "@/lib/format";
import { ROOM_KINDS } from "../room-kinds";

const inputMeters = (value: number) => String(Number(value.toFixed(12)));
const parse = (value: string) =>
  value.trim() ? Number(value.replace(",", ".")) : NaN;

export interface RoomNeighbour {
  id: string;
  name: string;
  /** Shared wall length, in metres. */
  length: number;
  /** Doors between the two rooms. */
  doors: number;
}

const doorsText = (count: number) =>
  count === 0 ? tr`без двери` : count === 1 ? tr`дверь` : tr`двери: ${count}`;

export function WallRoomProperties({
  room,
  neighbours = [],
  exteriorDoors = 0,
  onSelectRoom,
  onEditWalls,
  editableRectangle,
  onResize,
  onSaveLabel,
  onResetLabel,
  busy,
  error,
}: {
  room: ResolvedWallRoom;
  /** Rooms across a wall from this one, from the derived adjacency. */
  neighbours?: readonly RoomNeighbour[];
  /** Doors from this room to no room (outside or an unenclosed area). */
  exteriorDoors?: number;
  onSelectRoom?: (id: string) => void;
  onEditWalls: () => void;
  editableRectangle: { width: number; depth: number } | null;
  onResize: (width: number, depth: number) => void;
  onSaveLabel: (values: WallRoomLabelValues) => void;
  onResetLabel: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [width, setWidth] = useState(inputMeters(editableRectangle?.width ?? 0));
  const [depth, setDepth] = useState(inputMeters(editableRectangle?.depth ?? 0));
  const [name, setName] = useState(room.name);
  const [kind, setKind] = useState(room.kind);
  const [color, setColor] = useState(room.color);
  const labelChanged = !room.labelId || name !== room.name || kind !== room.kind || color !== room.color;
  const unchanged = editableRectangle &&
    Number.isFinite(parse(width)) && Number.isFinite(parse(depth)) &&
    Math.abs(parse(width) - editableRectangle.width) <= 1e-9 &&
    Math.abs(parse(depth) - editableRectangle.depth) <= 1e-9;
  return (
    <>
      <div className="properties-heading">
        <span>
          <ScanLine size={15} />{tr` Контур помещения`}</span>
        <span className="small-tag">{tr`Авто`}</span>
      </div>
      <div className="selected-preview wall-room-selected-preview">
        <div className="room-preview" style={{ backgroundColor: room.color }}>
          <ScanLine size={27} strokeWidth={1} />
        </div>
        <div>
          <span className="eyebrow">{tr`ОПРЕДЕЛЕНО ПО СТЕНАМ`}</span>
          <h2>{room.name}</h2>
          <span className="wall-room-kind">{ROOM_KINDS[room.kind].label}</span>
        </div>
      </div>
      <div className="properties-form wall-room-properties">
        <div className="room-area-card">
          <span>{tr`Внутренняя площадь`}</span>
          <strong data-testid="wall-room-area">{formatArea(room.area)}</strong>
        </div>
        <form
          className="wall-room-label-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSaveLabel({ name, kind, color });
          }}
        >
          <fieldset disabled={busy}>
            <legend>{tr`ПАРАМЕТРЫ ПОМЕЩЕНИЯ`}</legend>
            <label htmlFor="wall-room-name">{tr`Название помещения`}</label>
            <input id="wall-room-name" value={name} onChange={(event) => setName(event.target.value)} />
            <label htmlFor="wall-room-kind">{tr`Назначение помещения`}</label>
            <select id="wall-room-kind" value={kind} onChange={(event) => setKind(event.target.value as RoomKind)}>
              {Object.entries(ROOM_KINDS).map(([value, entry]) => (
                <option key={value} value={value}>{entry.label}</option>
              ))}
            </select>
            <label htmlFor="wall-room-color">{tr`Цвет помещения`}</label>
            <div className="wall-room-color-field">
              <input id="wall-room-color" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              <span>{color.toUpperCase()}</span>
            </div>
            <button className="primary-button" type="submit" disabled={!labelChanged}>
              <Check size={14} />{tr` Сохранить параметры помещения`}</button>
            {room.labelId && (
              <button className="text-button wall-room-label-reset" type="button" onClick={onResetLabel}>{tr`Сбросить параметры помещения`}</button>
            )}
            <p className="rectangle-form-note">{tr`Название — до 60 символов. Изменения применятся после сохранения и не влияют на площадь.`}</p>
          </fieldset>
        </form>
        {error && <p className="construction-error" role="alert">{error}</p>}
        {editableRectangle && (
          <form
            className="rectangle-resize-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              onResize(parse(width), parse(depth));
            }}
          >
            <div className="field-pair">
              <div>
                <label htmlFor="rectangle-resize-width">{tr`Внутренняя ширина`}</label>
                <div className="unit-input">
                  <input id="rectangle-resize-width" inputMode="decimal" value={width} onChange={(event) => setWidth(event.target.value)} />
                  <span>{tr`м`}</span>
                </div>
              </div>
              <div>
                <label htmlFor="rectangle-resize-depth">{tr`Внутренняя глубина`}</label>
                <div className="unit-input">
                  <input id="rectangle-resize-depth" inputMode="decimal" value={depth} onChange={(event) => setDepth(event.target.value)} />
                  <span>{tr`м`}</span>
                </div>
              </div>
            </div>
            <button className="primary-button" type="submit" disabled={busy || !!unchanged}>{tr`Изменить размеры комнаты`}</button>
            <p className="rectangle-form-note">{tr`Левый верхний внутренний угол останется на месте. Правые и нижние углы стен переместятся вместе.`}</p>
          </form>
        )}
        <dl className="wall-room-measurements">
          <div>
            <dt>{tr`Периметр`}</dt>
            <dd data-testid="wall-room-perimeter">
              {formatLength(room.perimeter)}{tr` м`}</dd>
          </div>
          <div>
            <dt>{tr`Габарит по X`}</dt>
            <dd>{formatLength(room.bounds.maxX - room.bounds.minX)}{tr` м`}</dd>
          </div>
          <div>
            <dt>{tr`Габарит по Y`}</dt>
            <dd>{formatLength(room.bounds.maxY - room.bounds.minY)}{tr` м`}</dd>
          </div>
          <div>
            <dt>{tr`Внутренние исключения`}</dt>
            <dd>{room.holes.length}</dd>
          </div>
        </dl>
        <section className="wall-room-neighbours" aria-labelledby="wall-room-neighbours-title">
          <h3 id="wall-room-neighbours-title">{tr`Соседние помещения`}</h3>
          {neighbours.length === 0 ? (
            <p>{tr`Через стены ни с одним помещением не граничит.`}</p>
          ) : (
            <ul>
              {neighbours.map((neighbour) => (
                <li key={neighbour.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRoom?.(neighbour.id)}
                    aria-label={tr`Выбрать соседнее помещение ${neighbour.name}`}
                  >
                    <span>{neighbour.name}</span>
                    <small>{tr`общая стена `}{formatLength(neighbour.length)}{tr` м · `}{doorsText(neighbour.doors)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {exteriorDoors > 0 && (
            <p data-testid="wall-room-exterior-doors">{tr`Наружу: `}{exteriorDoors === 1 ? tr`1 дверь` : tr`${exteriorDoors} двери`}
            </p>
          )}
        </section>
        <p className="wall-room-notice">
          <Check size={15} />{tr` Площадь рассчитана внутри стен. Толщина стен и изолированные опоры исключены из пола.`}</p>
        <p className="wall-room-notice">
          <Ruler size={15} />{tr` Контур пересчитывается при изменении стен. Дверные проёмы считаются границами помещений.`}</p>
        <button className="primary-button" onClick={onEditWalls}>
          <BrickWall size={16} />{tr` Редактировать стены`}</button>
        <p className="wall-room-limit">{tr`Помещения площадью меньше 0,25 м² не включаются. Если после перепланировки связь с сохранёнными параметрами неоднозначна, выберите её во вкладке «Комнаты».`}</p>
      </div>
    </>
  );
}
