"use client";

import { BrickWall, Check, X } from "lucide-react";
import { formatLength } from "@/lib/format";

export interface SuggestedWall {
  length: number;
  thickness: number;
  selected: boolean;
}

/**
 * «Стены из PDF»: offers walls found in the vector lines of the imported PDF page.
 * Nothing is added until the user accepts; each suggestion can be switched off here
 * or by clicking it on the plan, and only the selected ones are added.
 */
export function PdfWallSuggestions({
  lineCount,
  linesTruncated,
  calibrated,
  busy,
  suggestion,
  onSuggest,
  onToggle,
  onSelectAll,
  onAccept,
  onDismiss,
}: {
  lineCount: number;
  linesTruncated: boolean;
  calibrated: boolean;
  busy: boolean;
  suggestion: { walls: readonly SuggestedWall[]; truncated: boolean } | null;
  onSuggest: () => void;
  onToggle: (index: number) => void;
  onSelectAll: (selected: boolean) => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const selected = suggestion?.walls.filter((wall) => wall.selected).length ?? 0;
  return (
    <section className="pdf-wall-suggestions" aria-label="Стены из чертежа" data-testid="pdf-wall-suggestions">
      <h3>
        <BrickWall size={13} /> Стены из чертежа
      </h3>
      {suggestion ? (
        suggestion.walls.length > 0 ? (
          <>
            <p role="status">
              Найдено стен: <strong data-testid="wall-suggestion-count">{suggestion.walls.length}</strong>, выбрано{" "}
              <strong data-testid="wall-suggestion-selected">{selected}</strong>. Они показаны на плане пунктиром:
              щелчок по стене на плане или галочка ниже исключает её.
              {suggestion.truncated && " Чертёж очень подробный: показана только часть."}
            </p>
            <div className="pdf-wall-suggestions-bulk">
              <button type="button" disabled={busy || selected === suggestion.walls.length} onClick={() => onSelectAll(true)}>
                Выбрать все
              </button>
              <button type="button" disabled={busy || selected === 0} onClick={() => onSelectAll(false)}>
                Снять все
              </button>
            </div>
            <ul className="pdf-wall-suggestions-list" aria-label="Предложенные стены">
              {suggestion.walls.map((wall, index) => (
                <li key={index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={wall.selected}
                      disabled={busy}
                      onChange={() => onToggle(index)}
                    />
                    Стена {index + 1}
                    <small>
                      {formatLength(wall.length)} м · {formatLength(wall.thickness)} м
                    </small>
                  </label>
                </li>
              ))}
            </ul>
            <div className="underlay-action-pair">
              <button disabled={busy || selected === 0} onClick={onAccept}>
                <Check size={14} /> Добавить стены ({selected})
              </button>
              <button disabled={busy} onClick={onDismiss}>
                <X size={14} /> Отклонить
              </button>
            </div>
          </>
        ) : (
          <>
            <p role="status">
              Пары параллельных линий, похожие на стены, не найдены. Обведите стены
              вручную инструментом «Стена».
            </p>
            <div className="underlay-action-pair">
              <button onClick={onDismiss}>Понятно</button>
            </div>
          </>
        )
      ) : (
        <>
          <p>
            На странице {lineCount} векторных линий
            {linesTruncated ? " (прочитана только часть)" : ""}. Стены ищутся как пары
            параллельных линий толщиной от 5 до 60 см.
          </p>
          {!calibrated && (
            <p className="pdf-wall-suggestions-hint">
              Сначала задайте масштаб: толщина и длина стен определяются в метрах.
            </p>
          )}
          <div className="underlay-action-pair">
            <button disabled={busy || !calibrated || lineCount === 0} onClick={onSuggest}>
              <BrickWall size={14} /> Предложить стены
            </button>
          </div>
        </>
      )}
    </section>
  );
}
