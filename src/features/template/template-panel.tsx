"use client";

import { useMemo } from "react";
import { CheckCircle2, CircleAlert, Lock, LockOpen, ShoppingBag } from "lucide-react";
import { measureOpenings, measureWalls } from "@/domain/accuracy/recognition-accuracy";
import type { ApartmentTemplate, FixedElement, FloorPlan } from "@/domain/floor-plan/types";
import { fixedRoomIds, labelledRooms } from "@/domain/template/locks";
import { confirmationOf, emptyTemplate, suggestedBuyerWalls, suggestedWetZones, templateReadiness } from "@/domain/template/readiness";
import { tr } from "@/lib/i18n";
import { ROOM_KINDS } from "../editor/room-kinds";
import "./template-panel.css";

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

/** How well the drawing was read, set against what the developer confirmed. */
function RecognitionNote({ plan, template }: { plan: FloorPlan; template: ApartmentTemplate }) {
  const record = plan.recognition;
  if (!record || !template.confirmed) return null;
  const walls = record.walls ? measureWalls(record.walls, template.confirmed.walls) : null;
  const doors = record.openings ? measureOpenings(record.openings, template.confirmed.openings, "door") : null;
  const windows = record.openings ? measureOpenings(record.openings, template.confirmed.openings, "window") : null;
  return (
    <p className="template-note" data-testid="template-accuracy">
      {tr`Распознавание этого плана против подтверждённого:`}{" "}
      {walls && tr`стены найдены на ${percent(walls.lengthRecall)} длины, лишнего ${percent(walls.lengthPrecision === null ? null : 1 - walls.lengthPrecision)}`}
      {doors && tr`; двери ${doors.matched} из ${doors.truthCount}`}
      {windows && tr`; окна ${windows.matched} из ${windows.truthCount}`}.
    </p>
  );
}

export function TemplatePanel({
  plan,
  onSet,
  onShow,
  onWallsTab,
  onOpenAsBuyer,
  busy,
}: {
  plan: FloorPlan;
  onSet: (template: ApartmentTemplate | null) => void;
  /** Selects a wall, an opening or a room on the plan. */
  onShow: (id: string) => void;
  onWallsTab: () => void;
  onOpenAsBuyer: () => void;
  busy: boolean;
}) {
  const template = plan.template;
  const readiness = useMemo(() => templateReadiness(plan, template ?? emptyTemplate()), [plan, template]);
  const rooms = useMemo(() => labelledRooms(plan).filter((room) => room.labelId), [plan]);
  const number = (id: string) => plan.walls.findIndex((wall) => wall.id === id) + 1;

  if (!template) {
    return (
      <section className="template-panel" data-testid="template-panel">
        <h3>{tr`Шаблон квартиры для покупателя`}</h3>
        <p className="template-note">
          {tr`Подготовьте квартиру: подтвердите стены по чертежу, укажите их типы, отметьте мокрые зоны, стояки и входную дверь и выберите, что покупатель может менять. Покупатель будет менять только это, а каждое его изменение приложение проверит.`}
        </p>
        <button type="button" className="primary-button" disabled={busy} onClick={() => onSet(emptyTemplate())}>
          {tr`Начать подготовку`}
        </button>
      </section>
    );
  }

  const set = (change: Partial<ApartmentTemplate>) => onSet({ ...template, ...change });
  const fixedOf = (kind: FixedElement["kind"], id: string) =>
    template.fixed.some((item) => item.kind === kind && (item.kind === "entrance-door" ? item.openingId === id : item.roomLabelId === id));
  const toggleFixed = (element: FixedElement) => {
    const id = element.kind === "entrance-door" ? element.openingId : element.roomLabelId;
    set({
      fixed: fixedOf(element.kind, id)
        ? template.fixed.filter((item) => !(item.kind === element.kind && (item.kind === "entrance-door" ? item.openingId === id : item.roomLabelId === id)))
        : [...template.fixed, element],
    });
  };
  const toggle = (list: readonly string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const fixedRooms = fixedRoomIds(template);
  const partitions = plan.walls.filter((wall) => wall.kind === "partition");
  const doors = plan.openings.filter((opening) => opening.kind === "door");
  const entrance = template.fixed.find((item) => item.kind === "entrance-door");

  return (
    <section className="template-panel" data-testid="template-panel" data-ready={readiness.ready}>
      <div className={`template-status ${readiness.ready ? "ready" : "not-ready"}`} data-testid="template-status">
        {readiness.ready ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <strong>{readiness.ready ? tr`Готов для покупателя` : tr`Не готов для покупателя`}</strong>
      </div>
      {readiness.issues.length > 0 && (
        <ul className="template-issues" data-testid="template-issues">
          {readiness.issues.map((issue) => (
            <li key={issue.id} data-issue={issue.id} data-severity={issue.severity}>
              <strong>{issue.title}</strong>
              <p>{issue.fix}</p>
              {issue.targets[0] && (
                <button type="button" className="text-button" onClick={() => onShow(issue.targets[0])}>{tr`Показать на плане`}</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>{tr`1. Стены и проёмы`}</h4>
      <p className="template-note">
        {template.confirmed
          ? tr`Подтверждено: стен ${template.confirmed.walls.length}, проёмов ${template.confirmed.openings.length}.`
          : tr`Сверьте найденные стены и проёмы с чертежом и подтвердите их.`}
      </p>
      <RecognitionNote plan={plan} template={template} />
      <button type="button" className="secondary-button" disabled={busy || !plan.walls.length} onClick={() => set({ confirmed: confirmationOf(plan, new Date().toISOString()) })}>
        {template.confirmed ? tr`Подтвердить заново` : tr`Подтвердить стены и проёмы`}
      </button>

      <h4>{tr`2. Типы стен`}</h4>
      <p className="template-note">
        {readiness.counts.unknownWalls ? tr`Тип не указан у стен: ${readiness.counts.unknownWalls}.` : tr`Тип указан у всех стен.`}
      </p>
      <button type="button" className="text-button" onClick={onWallsTab}>{tr`Указать на вкладке «Стены»`}</button>

      <h4>{tr`3. Фиксированные элементы`}</h4>
      <p className="template-note">{tr`Покупатель не сможет их менять: ни стены этих комнат, ни саму дверь.`}</p>
      {rooms.length ? (
        <ul className="template-list" data-testid="template-fixed">
          {rooms.map((room) => (
            <li key={room.labelId}>
              <span>{room.name} <small>{ROOM_KINDS[room.kind].label.toLowerCase()}</small></span>
              <label><input type="checkbox" checked={fixedOf("wet-zone", room.labelId!)} onChange={() => toggleFixed({ kind: "wet-zone", roomLabelId: room.labelId! })} /> {tr`мокрая зона`}</label>
              <label><input type="checkbox" checked={fixedOf("riser", room.labelId!)} onChange={() => toggleFixed({ kind: "riser", roomLabelId: room.labelId! })} /> {tr`стояк`}</label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="template-note">{tr`Дайте комнатам названия и назначение на вкладке «Комнаты»: отмечать можно только их.`}</p>
      )}
      {suggestedWetZones(plan).some((id) => !fixedRooms.has(id)) && (
        <button type="button" className="text-button" onClick={() => set({ fixed: [...template.fixed, ...suggestedWetZones(plan).filter((id) => !fixedRooms.has(id)).map((roomLabelId) => ({ kind: "wet-zone" as const, roomLabelId }))] })}>
          {tr`Отметить кухни и санузлы как мокрые зоны`}
        </button>
      )}
      <label className="template-field">
        <span>{tr`Входная дверь`}</span>
        <select
          value={entrance?.kind === "entrance-door" ? entrance.openingId : ""}
          onChange={(event) => set({
            fixed: [
              ...template.fixed.filter((item) => item.kind !== "entrance-door"),
              ...(event.target.value ? [{ kind: "entrance-door" as const, openingId: event.target.value }] : []),
            ],
          })}
        >
          <option value="">{tr`Не отмечена`}</option>
          {doors.map((door) => <option key={door.id} value={door.id}>{tr`Дверь в стене ${number(door.wallId)}`}</option>)}
        </select>
      </label>

      <h4>{tr`4. Что может менять покупатель`}</h4>
      <p className="template-note">{tr`Только перегородки: несущие стены и стены без типа покупатель не меняет никогда.`}</p>
      <div className="template-actions">
        <button type="button" className="text-button" onClick={() => set({ buyerWalls: suggestedBuyerWalls(plan, template) })}>{tr`Разрешить перегородки вне мокрых зон`}</button>
        <button type="button" className="text-button" onClick={() => set({ buyerWalls: [] })}>{tr`Снять все`}</button>
      </div>
      {partitions.length ? (
        <ul className="template-list" data-testid="template-buyer-walls">
          {partitions.map((wall) => {
            const allowed = template.buyerWalls.includes(wall.id);
            return (
              <li key={wall.id}>
                <label>
                  <input type="checkbox" checked={allowed} onChange={() => set({ buyerWalls: toggle(template.buyerWalls, wall.id) })} />
                  {allowed ? <LockOpen size={13} aria-hidden="true" /> : <Lock size={13} aria-hidden="true" />} {tr`Стена ${number(wall.id)}`}
                </label>
                <button type="button" className="text-button" onClick={() => onShow(wall.id)}>{tr`Показать`}</button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="template-note">{tr`Перегородок нет: отметьте типы стен.`}</p>
      )}
      {rooms.length > 0 && (
        <>
          <p className="template-note">{tr`Комнаты, которые покупатель может переименовать, сменить назначение и разделить:`}</p>
          <ul className="template-list" data-testid="template-buyer-rooms">
            {rooms.filter((room) => !fixedRooms.has(room.labelId!)).map((room) => (
              <li key={room.labelId}>
                <label>
                  <input type="checkbox" checked={template.buyerRooms.includes(room.labelId!)} onChange={() => set({ buyerRooms: toggle(template.buyerRooms, room.labelId!) })} />
                  {room.name}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>{tr`5. Покупателю`}</h4>
      {!readiness.ready && <p className="template-note warning">{tr`Шаблон не готов: выводы для покупателя будут неполными. Исправьте пункты выше.`}</p>}
      <button type="button" className="primary-button" disabled={busy} onClick={onOpenAsBuyer}>
        <ShoppingBag size={15} aria-hidden="true" /> {tr`Открыть как покупатель`}
      </button>
      <button type="button" className="text-button danger" onClick={() => onSet(null)}>{tr`Убрать шаблон`}</button>
    </section>
  );
}
