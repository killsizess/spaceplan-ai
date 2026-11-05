"use client";

import { tr } from "@/lib/i18n";
import { ListChecks, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PlanRequirement, RoomKind, Wall } from "@/domain/floor-plan/types";
import {
  bearingWallsRequirement,
  fixedWallRequirement,
  type RequirementConflict,
  type RequirementResult,
} from "@/domain/floor-plan/plan-requirements";
import { ROOM_KINDS } from "../room-kinds";
import { conflictText, describeRequirement, requirementDetail, STATUS_TEXT } from "../requirement-text";
import "../requirements.css";

type RequirementType = PlanRequirement["type"];

const parse = (value: string) => (value.trim() ? Number(value.replace(",", ".")) : NaN);

/** A room with saved parameters that a requirement can target. */
export interface NamedRoom {
  labelId: string;
  name: string;
  kind: RoomKind;
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
    return index >= 0 ? tr`Стена ${index + 1}` : tr`Удалённая стена`;
  };
  const chosenWall = walls.find((wall) => wall.id === wallId) ?? walls[0];

  return (
    <section className="requirements-panel" aria-labelledby="requirements-title">
      <div className="requirements-heading">
        <ListChecks size={15} />
        <h3 id="requirements-title">{tr`Требования к планировке`}</h3>
        {requirements.length > 0 && (
          <span className={`requirements-count ${violated ? "bad" : "good"}`} data-testid="requirements-summary">
            {violated ? tr`нарушено: ${violated}` : tr`всё выполнено`}
          </span>
        )}
      </div>
      {conflicts.length > 0 && (
        <ul className="requirements-conflicts" aria-label={tr`Противоречия между требованиями`}>
          {conflicts.map((conflict) => (
            <li key={conflict.ids.join("|")} data-conflict={conflict.reason}>
              <TriangleAlert size={13} />
              <span>{conflictText(conflict)}</span>
            </li>
          ))}
        </ul>
      )}
      {requirements.length === 0 ? (
        <p className="requirements-empty">{tr`Задайте свои требования, например минимальную площадь кухни, непроходную спальню или неизменную несущую стену. Приложение проверит их по плану.`}</p>
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
                  <small>{requirementDetail(requirement, result, roomName, wallName)}</small>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={tr`Удалить требование: ${description}`}
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
              setLocalError(tr`Введите площадь числом больше 0.`);
              return;
            }
            const scope = targetRoom ? { kind: targetRoom.kind, labelId: targetRoom.labelId } : { kind };
            onAdd(type === "room-min-area" ? { id, type, ...scope, minArea: value } : { id, type, ...scope, maxArea: value });
          } else if (type === "room-not-walkthrough") {
            onAdd(targetRoom ? { id, type, kind: targetRoom.kind, labelId: targetRoom.labelId } : { id, type, kind });
          } else if (type === "rooms-connected") {
            onAdd({ id, type, kind, otherKind, byDoor });
          } else if (type === "bearing-walls-kept") {
            try {
              onAdd(bearingWallsRequirement(walls, id));
            } catch (error) {
              setLocalError(error instanceof Error ? error.message : tr`Не удалось добавить требование.`);
              return;
            }
          } else {
            if (!chosenWall) {
              setLocalError(tr`В плане нет стен.`);
              return;
            }
            onAdd(fixedWallRequirement(chosenWall, id));
          }
          setLocalError(null);
        }}
      >
        <label htmlFor="requirement-type">{tr`Новое требование`}</label>
        <select id="requirement-type" value={type} onChange={(event) => { setType(event.target.value as RequirementType); setLocalError(null); }}>
          <option value="room-min-area">{tr`Минимальная площадь`}</option>
          <option value="room-max-area">{tr`Максимальная площадь`}</option>
          <option value="room-not-walkthrough">{tr`Непроходное помещение`}</option>
          <option value="rooms-connected">{tr`Помещения рядом`}</option>
          <option value="wall-fixed">{tr`Стена не меняется`}</option>
          <option value="bearing-walls-kept">{tr`Несущие стены не меняются`}</option>
        </select>
        {type === "wall-fixed" ? (
          <>
            <label htmlFor="requirement-wall">{tr`Стена`}</label>
            <select id="requirement-wall" value={chosenWall?.id ?? ""} onChange={(event) => setWallId(event.target.value)}>
              {walls.map((wall, index) => <option key={wall.id} value={wall.id}>{tr`Стена `}{index + 1}{wall.kind === "bearing" ? tr` · несущая` : ""}</option>)}
            </select>
          </>
        ) : type === "bearing-walls-kept" ? (
          <p className="requirements-note">{tr`Запоминает ось, толщину и отметку всех стен, которые сейчас отмечены как несущие (`}{walls.filter((wall) => wall.kind === "bearing").length}).</p>
        ) : (
          <>
            {roomScoped && namedRooms.length > 0 && (
              <>
                <label htmlFor="requirement-room">{tr`Помещение`}</label>
                <select id="requirement-room" value={targetRoom?.labelId ?? ""} onChange={(event) => setLabelId(event.target.value)}>
                  <option value="">{tr`Все с выбранным назначением`}</option>
                  {namedRooms.map((room) => <option key={room.labelId} value={room.labelId}>{room.name}</option>)}
                </select>
              </>
            )}
            {!(roomScoped && targetRoom) && (
              <>
                <label htmlFor="requirement-kind">{tr`Назначение`}</label>
                <select id="requirement-kind" value={kind} onChange={(event) => setKind(event.target.value as RoomKind)}>
                  {Object.entries(ROOM_KINDS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
                </select>
              </>
            )}
          </>
        )}
        {(type === "room-min-area" || type === "room-max-area") && (
          <>
            <label htmlFor="requirement-area">{type === "room-min-area" ? tr`Площадь не меньше, м²` : tr`Площадь не больше, м²`}</label>
            <input id="requirement-area" inputMode="decimal" value={area} onChange={(event) => { setArea(event.target.value); setLocalError(null); }} />
          </>
        )}
        {type === "rooms-connected" && (
          <>
            <label htmlFor="requirement-other-kind">{tr`Рядом с`}</label>
            <select id="requirement-other-kind" value={otherKind} onChange={(event) => setOtherKind(event.target.value as RoomKind)}>
              {Object.entries(ROOM_KINDS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
            </select>
            <label className="requirements-checkbox">
              <input id="requirement-by-door" type="checkbox" checked={byDoor} onChange={(event) => setByDoor(event.target.checked)} />{tr`Соединены дверью`}</label>
          </>
        )}
        {localError && <p className="construction-error" role="alert">{localError}</p>}
        <button className="secondary-button" type="submit" disabled={busy}>
          <Plus size={14} />{tr` Добавить требование`}</button>
        <p className="requirements-note">{tr`Это ваши требования к плану, а не строительные нормы. Назначение помещений берётся из их параметров; без них помещение считается «Комнатой». «Стена не меняется» запоминает ось и толщину стены в момент добавления.`}</p>
      </form>
    </section>
  );
}
