"use client";

import { ListChecks, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PlanRequirement, RoomKind, Wall } from "@/domain/floor-plan/types";
import {
  fixedWallRequirement,
  type RequirementConflict,
  type RequirementResult,
  type RequirementStatus,
} from "@/domain/floor-plan/plan-requirements";
import { formatArea } from "@/lib/format";
import { ROOM_KINDS } from "../room-kinds";
import "../requirements.css";

type RequirementType = PlanRequirement["type"];

const STATUS_TEXT: Record<RequirementStatus, string> = {
  met: "Выполнено",
  violated: "Нарушено",
  "no-rooms": "Нет помещений",
  inactive: "Не проверяется",
};

const kindLabel = (kind: RoomKind) => ROOM_KINDS[kind].label;
const parse = (value: string) => (value.trim() ? Number(value.replace(",", ".")) : NaN);

/** A room with saved parameters that a requirement can target. */
export interface NamedRoom {
  labelId: string;
  name: string;
  kind: RoomKind;
}

/** Human description of a requirement, built only from its typed fields. */
export function describeRequirement(
  requirement: PlanRequirement,
  wallName: (id: string) => string,
  labelName: (id: string) => string | undefined = () => undefined,
): string {
  const subject = (kind: RoomKind, labelId?: string) =>
    labelId ? `«${labelName(labelId) ?? "Помещение без параметров"}»` : kindLabel(kind);
  switch (requirement.type) {
    case "room-min-area":
      return `${subject(requirement.kind, requirement.labelId)}: площадь не меньше ${formatArea(requirement.minArea)}`;
    case "room-max-area":
      return `${subject(requirement.kind, requirement.labelId)}: площадь не больше ${formatArea(requirement.maxArea)}`;
    case "room-not-walkthrough":
      return `${subject(requirement.kind, requirement.labelId)}: не проходная`;
    case "rooms-connected":
      return `${kindLabel(requirement.kind)} рядом с «${kindLabel(requirement.otherKind)}»${requirement.byDoor ? ", с дверью" : ""}`;
    case "wall-fixed":
      return `${wallName(requirement.wallId)} не меняется`;
  }
}

function missingRooms(requirement: PlanRequirement): string {
  if (requirement.type === "rooms-connected") {
    return requirement.kind === requirement.otherKind
      ? `Нужно хотя бы два помещения «${kindLabel(requirement.kind)}».`
      : `Нет помещений «${kindLabel(requirement.kind)}» или «${kindLabel(requirement.otherKind)}». Назначение задаётся в параметрах помещения.`;
  }
  if (requirement.type === "wall-fixed") return "";
  return requirement.labelId
    ? "Помещение с этими параметрами сейчас не найдено: после перепланировки привяжите параметры заново или удалите требование."
    : `Нет помещений с назначением «${kindLabel(requirement.kind)}». Назначение задаётся в параметрах помещения.`;
}

function detail(
  requirement: PlanRequirement,
  result: RequirementResult | undefined,
  nameOf: (id: string) => string,
): string {
  if (requirement.type === "wall-fixed") {
    const change = result?.findings[0]?.change;
    return change === "deleted" ? "Стена удалена."
      : change === "moved" ? "Стена перенесена или изменена её длина."
        : change === "thickness" ? "Изменена толщина стены."
          : "Ось и толщина стены совпадают с сохранёнными.";
  }
  if (!result || result.status === "inactive") return "Требования к помещениям проверяются в режиме «По стенам».";
  if (result.status === "no-rooms") return missingRooms(requirement);
  if (requirement.type === "room-min-area" || requirement.type === "room-max-area") {
    return result.findings.map((finding) => `${nameOf(finding.roomId)} — ${formatArea(finding.area ?? 0)}`).join("; ");
  }
  if (requirement.type === "room-not-walkthrough") {
    return result.findings.map((finding) => `${nameOf(finding.roomId)} — дверей: ${finding.doors ?? 0}`).join("; ");
  }
  return result.findings.length
    ? result.findings.map((finding) => `${nameOf(finding.roomId)} ↔ ${nameOf(finding.otherRoomId ?? "")}`).join("; ")
    : requirement.byDoor ? "Ни одна пара не соединена дверью." : "Ни одна пара не граничит через стену.";
}

function conflictText(conflict: RequirementConflict): string {
  return conflict.reason === "area-range"
    ? `${kindLabel(conflict.kind)}: минимальная площадь больше максимальной — выполнить оба требования нельзя.`
    : `${kindLabel(conflict.kind)}: помещение не должно быть проходным, но обязано иметь двери в два разных помещения. Если такое помещение одно, это невозможно.`;
}

export function RequirementsPanel({
  requirements,
  results,
  conflicts,
  walls,
  namedRooms = [],
  roomName,
  busy,
  onAdd,
  onRemove,
}: {
  requirements: readonly PlanRequirement[];
  results: readonly RequirementResult[];
  conflicts: readonly RequirementConflict[];
  walls: readonly Wall[];
  /** Rooms with saved parameters, in plan order. */
  namedRooms?: readonly NamedRoom[];
  roomName: (id: string) => string;
  busy: boolean;
  onAdd: (requirement: PlanRequirement) => void;
  onRemove: (id: string) => void;
}) {
  const [type, setType] = useState<RequirementType>("room-min-area");
  const [kind, setKind] = useState<RoomKind>("kitchen");
  const [otherKind, setOtherKind] = useState<RoomKind>("hall");
  const [area, setArea] = useState("8");
  const [byDoor, setByDoor] = useState(true);
  const [wallId, setWallId] = useState(walls[0]?.id ?? "");
  const [labelId, setLabelId] = useState("");
  const targetRoom = namedRooms.find((room) => room.labelId === labelId);
  const roomScoped = type === "room-min-area" || type === "room-max-area" || type === "room-not-walkthrough";
  const labelName = (id: string) => namedRooms.find((room) => room.labelId === id)?.name;
  const [localError, setLocalError] = useState<string | null>(null);
  const resultOf = new Map(results.map((result) => [result.id, result]));
  const violated = results.filter((result) => result.status === "violated").length;
  const wallName = (id: string) => {
    const index = walls.findIndex((wall) => wall.id === id);
    return index >= 0 ? `Стена ${index + 1}` : "Удалённая стена";
  };
  const chosenWall = walls.find((wall) => wall.id === wallId) ?? walls[0];

  return (
    <section className="requirements-panel" aria-labelledby="requirements-title">
      <div className="requirements-heading">
        <ListChecks size={15} />
        <h3 id="requirements-title">Требования к планировке</h3>
        {requirements.length > 0 && (
          <span className={`requirements-count ${violated ? "bad" : "good"}`} data-testid="requirements-summary">
            {violated ? `нарушено: ${violated}` : "всё выполнено"}
          </span>
        )}
      </div>
      {conflicts.length > 0 && (
        <ul className="requirements-conflicts" aria-label="Противоречия между требованиями">
          {conflicts.map((conflict) => (
            <li key={conflict.ids.join("|")} data-conflict={conflict.reason}>
              <TriangleAlert size={13} />
              <span>{conflictText(conflict)}</span>
            </li>
          ))}
        </ul>
      )}
      {requirements.length === 0 ? (
        <p className="requirements-empty">Задайте свои требования, например минимальную площадь кухни, непроходную спальню или неизменную несущую стену. Приложение проверит их по плану.</p>
      ) : (
        <ul className="requirements-list">
          {requirements.map((requirement) => {
            const result = resultOf.get(requirement.id);
            const status = result?.status ?? "inactive";
            const description = describeRequirement(requirement, wallName, labelName);
            return (
              <li key={requirement.id} className={`requirement status-${status}`} data-requirement-status={status}>
                <div>
                  <strong>{description}</strong>
                  <span className="requirement-status">{STATUS_TEXT[status]}</span>
                  <small>{detail(requirement, result, roomName)}</small>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Удалить требование: ${description}`}
                  disabled={busy}
                  onClick={() => onRemove(requirement.id)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="requirements-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const id = `requirement-${crypto.randomUUID()}`;
          if (type === "room-min-area" || type === "room-max-area") {
            const value = parse(area);
            if (!Number.isFinite(value) || value <= 0) {
              setLocalError("Введите площадь числом больше 0.");
              return;
            }
            const scope = targetRoom ? { kind: targetRoom.kind, labelId: targetRoom.labelId } : { kind };
            onAdd(type === "room-min-area" ? { id, type, ...scope, minArea: value } : { id, type, ...scope, maxArea: value });
          } else if (type === "room-not-walkthrough") {
            onAdd(targetRoom ? { id, type, kind: targetRoom.kind, labelId: targetRoom.labelId } : { id, type, kind });
          } else if (type === "rooms-connected") {
            onAdd({ id, type, kind, otherKind, byDoor });
          } else {
            if (!chosenWall) {
              setLocalError("В плане нет стен.");
              return;
            }
            onAdd(fixedWallRequirement(chosenWall, id));
          }
          setLocalError(null);
        }}
      >
        <label htmlFor="requirement-type">Новое требование</label>
        <select id="requirement-type" value={type} onChange={(event) => { setType(event.target.value as RequirementType); setLocalError(null); }}>
          <option value="room-min-area">Минимальная площадь</option>
          <option value="room-max-area">Максимальная площадь</option>
          <option value="room-not-walkthrough">Непроходное помещение</option>
          <option value="rooms-connected">Помещения рядом</option>
          <option value="wall-fixed">Стена не меняется</option>
        </select>
        {type === "wall-fixed" ? (
          <>
            <label htmlFor="requirement-wall">Стена</label>
            <select id="requirement-wall" value={chosenWall?.id ?? ""} onChange={(event) => setWallId(event.target.value)}>
              {walls.map((wall, index) => <option key={wall.id} value={wall.id}>Стена {index + 1}</option>)}
            </select>
          </>
        ) : (
          <>
            {roomScoped && namedRooms.length > 0 && (
              <>
                <label htmlFor="requirement-room">Помещение</label>
                <select id="requirement-room" value={targetRoom?.labelId ?? ""} onChange={(event) => setLabelId(event.target.value)}>
                  <option value="">Все с выбранным назначением</option>
                  {namedRooms.map((room) => <option key={room.labelId} value={room.labelId}>{room.name}</option>)}
                </select>
              </>
            )}
            {!(roomScoped && targetRoom) && (
              <>
                <label htmlFor="requirement-kind">Назначение</label>
                <select id="requirement-kind" value={kind} onChange={(event) => setKind(event.target.value as RoomKind)}>
                  {Object.entries(ROOM_KINDS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
                </select>
              </>
            )}
          </>
        )}
        {(type === "room-min-area" || type === "room-max-area") && (
          <>
            <label htmlFor="requirement-area">{type === "room-min-area" ? "Площадь не меньше, м²" : "Площадь не больше, м²"}</label>
            <input id="requirement-area" inputMode="decimal" value={area} onChange={(event) => { setArea(event.target.value); setLocalError(null); }} />
          </>
        )}
        {type === "rooms-connected" && (
          <>
            <label htmlFor="requirement-other-kind">Рядом с</label>
            <select id="requirement-other-kind" value={otherKind} onChange={(event) => setOtherKind(event.target.value as RoomKind)}>
              {Object.entries(ROOM_KINDS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
            </select>
            <label className="requirements-checkbox">
              <input id="requirement-by-door" type="checkbox" checked={byDoor} onChange={(event) => setByDoor(event.target.checked)} />
              Соединены дверью
            </label>
          </>
        )}
        {localError && <p className="construction-error" role="alert">{localError}</p>}
        <button className="secondary-button" type="submit" disabled={busy}>
          <Plus size={14} /> Добавить требование
        </button>
        <p className="requirements-note">Это ваши требования к плану, а не строительные нормы. Назначение помещений берётся из их параметров; без них помещение считается «Комнатой». «Стена не меняется» запоминает ось и толщину стены в момент добавления.</p>
      </form>
    </section>
  );
}
