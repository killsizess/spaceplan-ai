"use client";

import { TriangleAlert } from "lucide-react";
import "../unresolved-rooms.css";

/**
 * Shown when a project was opened whose rooms cannot be computed from its walls. It says
 * what is wrong and why, and what has been kept: the project is never changed on opening.
 */
export function UnresolvedRoomsNotice({
  reason,
  wallCount,
  labelCount,
  busy,
  onUseManualRooms,
}: {
  reason: string;
  wallCount: number;
  labelCount: number;
  busy: boolean;
  onUseManualRooms: () => void;
}) {
  return (
    <section className="unresolved-rooms-notice" role="alert" data-testid="unresolved-rooms-notice">
      <h3>
        <TriangleAlert size={14} /> Помещения по стенам не определены
      </h3>
      <p>
        <strong>Что не так:</strong> <span data-testid="unresolved-rooms-reason">{reason}</span>
      </p>
      <p>
        <strong>Что сохранено:</strong> проект открыт без изменений. Стен: {wallCount}, подписей помещений: {labelCount};
        ничего не удалено и не перестроено.
      </p>
      <p>
        <strong>Что недоступно, пока помещения не определены:</strong> площади, требования к помещениям, пол в 3D и экспорт чертежа.
        Экспорт проекта в JSON работает.
      </p>
      <p>
        <strong>Что можно сделать:</strong> исправить стены (принимаются правки, после которых помещения определяются) или
        переключиться на ручные комнаты. Стены и проёмы при этом остаются в проекте.
      </p>
      <button type="button" className="secondary-button" disabled={busy} onClick={onUseManualRooms}>
        Перейти к ручным комнатам
      </button>
    </section>
  );
}
