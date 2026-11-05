"use client";

import { tr } from "@/lib/i18n";
import { useState } from "react";
import { Link2, Trash2 } from "lucide-react";
import type { WallRoomLabel } from "@/domain/floor-plan/types";
import type { ResolvedWallRoom } from "@/domain/floor-plan/wall-room-labels";
import { ROOM_KINDS } from "../room-kinds";

export function UnassignedRoomLabels({
  labels,
  selectedRoom,
  busy,
  error,
  onAssign,
  onRemove,
}: {
  labels: readonly WallRoomLabel[];
  selectedRoom?: ResolvedWallRoom;
  busy: boolean;
  error: string | null;
  onAssign: (labelId: string) => void;
  onRemove: (labelId: string) => void;
}) {
  const [limit, setLimit] = useState(6);
  if (!labels.length) return null;
  const canAssign = !busy && !!selectedRoom && !selectedRoom.labelId;
  return (
    <section className="unassigned-room-labels" aria-label={tr`Непривязанные помещения`}>
      <h3>{tr`Непривязанные помещения `}<span data-testid="unassigned-label-count">{labels.length}</span></h3>
      <p>{tr`После изменения стен связь с помещением неоднозначна. Параметры сохранены. Выберите помещение на плане и привяжите нужную запись.`}</p>
      {labels.slice(0, limit).map((label) => (
        <div className="unassigned-room-label" key={label.id}>
          <div className="unassigned-room-label-title">
            <span style={{ backgroundColor: label.color }} />
            <strong>{label.name}</strong>
          </div>
          <small>{ROOM_KINDS[label.kind].label}</small>
          <button
            className="primary-button"
            type="button"
            aria-label={tr`Привязать «${label.name}» к выбранному помещению`}
            disabled={!canAssign}
            onClick={() => onAssign(label.id)}
          >
            <Link2 size={12} />{tr` Привязать к выбранному`}</button>
          <button
            className="text-button"
            type="button"
            aria-label={tr`Удалить параметры «${label.name}»`}
            disabled={busy}
            onClick={() => onRemove(label.id)}
          >
            <Trash2 size={12} />{tr` Удалить параметры`}</button>
        </div>
      ))}
      {labels.length > limit && (
        <button className="text-button" onClick={() => setLimit(limit + 6)}>{tr`Показать ещё (`}{labels.length - limit})</button>
      )}
      {selectedRoom?.labelId && <p>{tr`У выбранного помещения уже есть сохранённые параметры.`}</p>}
      {error && <p className="construction-error" role="alert">{error}</p>}
    </section>
  );
}
