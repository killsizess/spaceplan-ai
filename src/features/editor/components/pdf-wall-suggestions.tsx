"use client";

import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { BrickWall, Check, X } from "lucide-react";

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
    <section className="pdf-wall-suggestions" aria-label={tr`Стены из чертежа`} data-testid="pdf-wall-suggestions">
      <h3>
        <BrickWall size={13} />{tr` Стены из чертежа`}</h3>
      {suggestion ? (
        suggestion.walls.length > 0 ? (
          <>
            <p role="status">{tr`Найдено стен: `}<strong data-testid="wall-suggestion-count">{suggestion.walls.length}</strong>{tr`, выбрано`}{" "}
              <strong data-testid="wall-suggestion-selected">{selected}</strong>{tr`. Они показаны на плане пунктиром: щелчок по стене на плане или галочка ниже исключает её.`}{suggestion.truncated && tr` Чертёж очень подробный: показана только часть.`}
            </p>
            <div className="pdf-wall-suggestions-bulk">
              <button type="button" disabled={busy || selected === suggestion.walls.length} onClick={() => onSelectAll(true)}>{tr`Выбрать все`}</button>
              <button type="button" disabled={busy || selected === 0} onClick={() => onSelectAll(false)}>{tr`Снять все`}</button>
            </div>
            <ul className="pdf-wall-suggestions-list" aria-label={tr`Предложенные стены`}>
              {suggestion.walls.map((wall, index) => (
                <li key={index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={wall.selected}
                      disabled={busy}
                      onChange={() => onToggle(index)}
                    />{tr`Стена `}{index + 1}
                    <small>
                      {lengthText(wall.length)}{" · "}{lengthText(wall.thickness)}</small>
                  </label>
                </li>
              ))}
            </ul>
            <div className="underlay-action-pair">
              <button disabled={busy || selected === 0} onClick={onAccept}>
                <Check size={14} />{tr` Добавить стены (`}{selected})
              </button>
              <button disabled={busy} onClick={onDismiss}>
                <X size={14} />{tr` Отклонить`}</button>
            </div>
          </>
        ) : (
          <>
            <p role="status">{tr`Пары параллельных линий, похожие на стены, не найдены. Обведите стены вручную инструментом «Стена».`}</p>
            <div className="underlay-action-pair">
              <button onClick={onDismiss}>{tr`Понятно`}</button>
            </div>
          </>
        )
      ) : (
        <>
          <p>{tr`На странице `}{lineCount}{tr` векторных линий`}{linesTruncated ? tr` (прочитана только часть)` : ""}{tr`. Стены ищутся как пары параллельных линий толщиной от 5 до 60 см.`}</p>
          {!calibrated && (
            <p className="pdf-wall-suggestions-hint">{tr`Сначала задайте масштаб: толщина и длина стен определяются в метрах.`}</p>
          )}
          <div className="underlay-action-pair">
            <button disabled={busy || !calibrated || lineCount === 0} onClick={onSuggest}>
              <BrickWall size={14} />{tr` Предложить стены`}</button>
          </div>
        </>
      )}
    </section>
  );
}
