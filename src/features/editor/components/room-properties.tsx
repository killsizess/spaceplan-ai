"use client";

import { tr } from "@/lib/i18n";
import { useState } from "react";
import { ArrowDownRight, Check, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Room, RoomKind } from "@/domain/floor-plan/types";
import { rectangleArea } from "@/domain/geometry";
import { formatArea } from "@/lib/format";
import { ROOM_COLORS, ROOM_KINDS } from "../room-kinds";

export function RoomProperties({
  room,
  onUpdate,
  onDelete,
}: {
  room: Room;
  onUpdate: (room: Room) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(room.name);
  const [kind, setKind] = useState(room.kind);
  const [width, setWidth] = useState(String(room.width));
  const [height, setHeight] = useState(String(room.height));
  const [x, setX] = useState(String(room.x));
  const [y, setY] = useState(String(room.y));
  const [color, setColor] = useState(room.color);
  const parse = (value: string) =>
    value.trim() ? Number(value.replace(",", ".")) : NaN;
  const changed =
    name !== room.name ||
    kind !== room.kind ||
    parse(width) !== room.width ||
    parse(height) !== room.height ||
    parse(x) !== room.x ||
    parse(y) !== room.y ||
    color !== room.color;
  return (
    <>
      <div className="properties-heading">
        <span>
          <SlidersHorizontal size={15} />{tr` Свойства комнаты`}</span>
        <span className="small-tag">{tr`м`}</span>
      </div>
      <div className="selected-preview">
        <div className="room-preview" style={{ backgroundColor: color }}>
          <ArrowDownRight size={27} strokeWidth={1} />
        </div>
        <div>
          <span className="eyebrow">{tr`ВЫБРАНО ПОМЕЩЕНИЕ`}</span>
          <h2>{room.name}</h2>
        </div>
      </div>
      <form
        className="properties-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onUpdate({
            ...room,
            name,
            kind,
            color,
            width: parse(width),
            height: parse(height),
            x: parse(x),
            y: parse(y),
          });
        }}
      >
        <label htmlFor="room-name">{tr`Название`}</label>
        <input
          id="room-name"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="room-kind">{tr`Назначение`}</label>
        <select
          id="room-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as RoomKind)}
        >
          {Object.entries(ROOM_KINDS).map(([value, entry]) => (
            <option key={value} value={value}>
              {entry.label}
            </option>
          ))}
        </select>
        <div className="section-label">{tr`РАЗМЕРЫ`}</div>
        <div className="field-pair">
          <div>
            <label htmlFor="room-width">{tr`Ширина`}</label>
            <div className="unit-input">
              <input
                id="room-width"
                inputMode="decimal"
                value={width}
                onChange={(event) => setWidth(event.target.value)}
              />
              <span>{tr`м`}</span>
            </div>
          </div>
          <div>
            <label htmlFor="room-height">{tr`Длина`}</label>
            <div className="unit-input">
              <input
                id="room-height"
                inputMode="decimal"
                value={height}
                onChange={(event) => setHeight(event.target.value)}
              />
              <span>{tr`м`}</span>
            </div>
          </div>
        </div>
        <div className="room-area">
          <span>{tr`Площадь комнаты`}</span>
          <strong data-testid="room-area">
            {formatArea(rectangleArea(room.width, room.height))}
          </strong>
        </div>
        <div className="section-label">{tr`ПОЛОЖЕНИЕ НА ПЛАНЕ`}</div>
        <div className="field-pair">
          <div>
            <label htmlFor="room-x">{tr`Координата X`}</label>
            <div className="unit-input">
              <input
                id="room-x"
                inputMode="decimal"
                value={x}
                onChange={(event) => setX(event.target.value)}
              />
              <span>{tr`м`}</span>
            </div>
          </div>
          <div>
            <label htmlFor="room-y">{tr`Координата Y`}</label>
            <div className="unit-input">
              <input
                id="room-y"
                inputMode="decimal"
                value={y}
                onChange={(event) => setY(event.target.value)}
              />
              <span>{tr`м`}</span>
            </div>
          </div>
        </div>
        <div className="section-label">{tr`ЦВЕТ НА ПЛАНЕ`}</div>
        <div className="color-options">
          {ROOM_COLORS.map((value, index) => (
            <button
              key={value}
              type="button"
              style={{ backgroundColor: value }}
              className={color === value ? "chosen" : ""}
              aria-label={tr`Цвет ${index + 1}`}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
            >
              {color === value && <Check size={15} />}
            </button>
          ))}
        </div>
        <button
          type="submit"
          className="primary-button apply-button"
          disabled={!changed}
        >
          <Check size={15} />{tr` Применить изменения`}</button>
        <p className="field-note">{tr`Размеры: от 0,5 до 100 м. Площадь обновится после применения.`}</p>
      </form>
      <div className="properties-footer">
        <button className="danger-button" onClick={onDelete}>
          <Trash2 size={15} />{tr` Удалить комнату `}<kbd>Del</kbd>
        </button>
      </div>
    </>
  );
}
