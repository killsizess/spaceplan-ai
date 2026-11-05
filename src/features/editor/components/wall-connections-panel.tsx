"use client";

import { currentLocale, tr } from "@/lib/i18n";
import { INCH, currentUnits, lengthText } from "@/lib/units";
import { useState } from "react";
import { Check, ChevronRight, Focus } from "lucide-react";
import type { Wall } from "@/domain/floor-plan/types";
import type { WallConnectionDiagnostic } from "@/domain/floor-plan/wall-diagnostics";
import "../wall-connections.css";

function distanceLabel(distance: number): string {
  if (currentUnits() === "imperial") return distance < INCH / 16 ? tr`меньше 1/16 дюйма` : lengthText(distance);
  if (distance < 0.0001) return tr`меньше 0,1 мм`;
  if (distance < 0.01) {
    return tr`${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 }).format(distance * 1000)} мм`;
  }
  return lengthText(distance);
}

export function WallConnectionsPanel({
  walls,
  diagnostics,
  onLocate,
  onConnect,
  onCreateJunction,
  error,
  busy,
}: {
  walls: readonly Wall[];
  diagnostics: readonly WallConnectionDiagnostic[];
  onLocate: (diagnostic: WallConnectionDiagnostic) => void;
  onConnect?: (diagnostic: WallConnectionDiagnostic) => void;
  onCreateJunction?: (diagnostic: WallConnectionDiagnostic) => void;
  error?: string | null;
  busy: boolean;
}) {
  const [limit, setLimit] = useState(6);
  const numbers = new Map(walls.map((wall, index) => [wall.id, index + 1]));
  const ordered = diagnostics.slice().sort((first, second) =>
    (numbers.get(first.wallId) ?? 0) - (numbers.get(second.wallId) ?? 0) ||
    (first.endpoint === second.endpoint ? 0 : first.endpoint === "start" ? -1 : 1),
  );
  const description = (diagnostic: WallConnectionDiagnostic) => {
    if (diagnostic.kind === "open") return tr`Нет соединения с другим концом`;
    const number = numbers.get(diagnostic.target.wallId);
    if (diagnostic.kind === "junction") return tr`Касание середины стены ${number} — общего узла нет`;
    const target = diagnostic.kind === "near-endpoint" ? tr`конца` : tr`оси`;
    return tr`До ${target} стены ${number}: ${distanceLabel(diagnostic.distance)}`;
  };
  return (
    <section className={`wall-connections-panel ${diagnostics.length ? "has-open-ends" : "all-connected"}`} aria-label={tr`Соединения стен`}>
      <div className="wall-connections-heading">
        <h3>{diagnostics.length ? <Focus size={13} /> : <Check size={13} />}{tr` Свободные концы`}</h3>
        <strong data-testid="connection-count">{diagnostics.length}</strong>
      </div>
      {diagnostics.length ? (
        <>
          <p>{tr`Точки показывают концы без общего узла. Отдельные стены могут иметь свободные концы.`}</p>
          <div className="connection-diagnostic-list">
            {ordered.slice(0, limit).map((diagnostic) => {
              const number = numbers.get(diagnostic.wallId);
              const endpoint = diagnostic.endpoint === "start" ? tr`начало` : tr`конец`;
              return (
                <div className="connection-diagnostic-item" key={diagnostic.id}>
                  <button
                    className="connection-locate"
                    type="button"
                    aria-label={tr`Показать конец стены ${number}: ${endpoint}`}
                    title={tr`X: ${lengthText(diagnostic.point.x)}; Y: ${lengthText(diagnostic.point.y)}`}
                    disabled={busy}
                    onClick={() => onLocate(diagnostic)}
                  >
                    <span className={`connection-dot ${diagnostic.kind === "junction" ? "is-junction" : ""}`} />
                    <span><strong>{tr`Стена `}{number} · {endpoint}</strong><small>{description(diagnostic)}</small></span>
                    <ChevronRight size={12} />
                  </button>
                  {diagnostic.kind === "near-endpoint" && onConnect && (
                    <button
                      className="connection-join"
                      type="button"
                      aria-label={tr`Соединить конец стены ${number}: ${endpoint}`}
                      title={tr`Переместить ${endpoint} стены ${number} к концу стены ${numbers.get(diagnostic.target.wallId)}`}
                      disabled={busy}
                      onClick={() => onConnect(diagnostic)}
                    >
                      <Check size={11} />{tr` Соединить концы`}</button>
                  )}
                  {(diagnostic.kind === "near-wall" || diagnostic.kind === "junction") && onCreateJunction && (
                    <button
                      className="connection-join"
                      type="button"
                      aria-label={tr`Создать T-соединение стены ${number}: ${endpoint}`}
                      title={tr`Присоединить ${endpoint} стены ${number} к середине стены ${numbers.get(diagnostic.target.wallId)} и разделить её в этой точке`}
                      disabled={busy}
                      onClick={() => onCreateJunction(diagnostic)}
                    >
                      <Check size={11} />{tr` Создать T-соединение`}</button>
                  )}
                </div>
              );
            })}
          </div>
          {ordered.length > limit && (
            <button className="text-button connection-show-more" onClick={() => setLimit(limit + 6)}>{tr`Показать ещё (`}{ordered.length - limit})
            </button>
          )}
          {error && <p className="connection-action-error" role="alert">{error}</p>}
          {onConnect && ordered.some((diagnostic) => diagnostic.kind === "near-endpoint") && (
            <p className="connection-distance-note">{tr`«Соединить концы» перемещает конец из выбранной строки к указанной точке. Целевая стена остаётся на месте. Изменение можно отменить.`}</p>
          )}
          {onCreateJunction && ordered.some((diagnostic) => diagnostic.kind === "near-wall" || diagnostic.kind === "junction") && (
            <p className="connection-distance-note">{tr`«Создать T-соединение» присоединяет конец к середине другой стены и делит её на два участка. Её двери и окна остаются на месте. Точка внутри проёма не подходит. Изменение можно отменить.`}</p>
          )}
          <p className="connection-distance-note">{tr`Расстояния — между осями. Толщина стен не учитывается. Нажмите строку, чтобы найти конец на 2D-плане.`}</p>
        </>
      ) : <p>{tr`Свободных концов нет. Совпадающие концы стен соединены.`}</p>}
    </section>
  );
}
