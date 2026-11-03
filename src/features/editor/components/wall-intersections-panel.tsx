"use client";

import { useState } from "react";
import { Check, ChevronRight, Focus } from "lucide-react";
import type { Wall } from "@/domain/floor-plan/types";
import type { WallIntersectionDiagnostic } from "@/domain/floor-plan/wall-intersections";
import { formatLength } from "@/lib/format";
import "../wall-connections.css";

export function WallIntersectionsPanel({
  walls,
  intersections,
  truncated,
  onLocate,
  onConnect,
  error,
  busy,
}: {
  walls: readonly Wall[];
  intersections: readonly WallIntersectionDiagnostic[];
  truncated: boolean;
  onLocate: (diagnostic: WallIntersectionDiagnostic) => void;
  onConnect: (diagnostic: WallIntersectionDiagnostic) => void;
  error: string | null;
  busy: boolean;
}) {
  const [limit, setLimit] = useState(6);
  const numbers = new Map(walls.map((wall, index) => [wall.id, index + 1]));
  const pairNumbers = (diagnostic: WallIntersectionDiagnostic) =>
    diagnostic.wallIds.map((id) => numbers.get(id) ?? 0).sort((a, b) => a - b);
  const ordered = intersections.slice().sort((a, b) => {
    const first = pairNumbers(a);
    const second = pairNumbers(b);
    return first[0] - second[0] || first[1] - second[1];
  });
  return (
    <section
      className={`wall-connections-panel wall-intersections-panel ${intersections.length ? "has-open-ends" : "all-connected"}`}
      aria-label="Пересечения стен"
    >
      <div className="wall-connections-heading">
        <h3>{intersections.length ? <Focus size={13} /> : <Check size={13} />} Пересечения стен</h3>
        <strong data-testid="intersection-count" title="Показано пересечений">{intersections.length}</strong>
      </div>
      {intersections.length ? (
        <>
          <p>Стены пересекаются серединами, но общего узла пока нет.</p>
          <div className="connection-diagnostic-list">
            {ordered.slice(0, limit).map((diagnostic) => {
              const [first, second] = pairNumbers(diagnostic);
              return (
                <div className="connection-diagnostic-item" key={diagnostic.id}>
                  <button
                    className="connection-locate"
                    type="button"
                    aria-label={`Показать пересечение стен ${first} и ${second}`}
                    disabled={busy}
                    onClick={() => onLocate(diagnostic)}
                  >
                    <span className="connection-dot is-intersection" />
                    <span>
                      <strong>Стены {first} и {second}</strong>
                      <small>X: {formatLength(diagnostic.point.x)} м · Y: {formatLength(diagnostic.point.y)} м</small>
                    </span>
                    <ChevronRight size={12} />
                  </button>
                  <button
                    className="connection-join"
                    type="button"
                    aria-label={`Соединить пересечение стен ${first} и ${second}`}
                    title="Разделить обе стены в месте пересечения и создать общий узел"
                    disabled={busy}
                    onClick={() => onConnect(diagnostic)}
                  >
                    <Check size={11} /> Соединить стены
                  </button>
                </div>
              );
            })}
          </div>
          {ordered.length > limit && (
            <button className="text-button connection-show-more" onClick={() => setLimit(limit + 6)}>
              Показать ещё ({ordered.length - limit})
            </button>
          )}
          {truncated && (
            <p>Показаны первые {intersections.length} пересечений. Соединяйте их по одному — список обновится.</p>
          )}
          {error && <p className="connection-action-error" role="alert">{error}</p>}
          <p className="connection-distance-note">Обе стены разделятся в этой точке. Их двери и окна сохранят положение. Точка внутри проёма не подходит. Всё действие можно отменить.</p>
          <p className="connection-distance-note">Нажмите строку, чтобы найти пересечение на 2D-плане. Проверяются оси стен; параллельные стены и наложения в этот список не входят.</p>
        </>
      ) : <p>Пересечений середин стен нет. Касания концов показаны отдельно.</p>}
    </section>
  );
}
