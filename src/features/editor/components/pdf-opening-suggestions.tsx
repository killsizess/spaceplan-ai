"use client";

import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { Check, DoorOpen, X } from "lucide-react";

export interface SuggestedOpening {
  kind: "door" | "window";
  /** `low` is shown as «неуверенно» and starts switched off. */
  confidence: "high" | "low";
  width: number;
  /** Where it goes, in words: «в стене 3» or «между стенами: добавится короткая стена». */
  place: string;
  reasons: readonly string[];
  selected: boolean;
}

/**
 * «Двери и окна из PDF»: offers openings found in the drawing lines, for walls the plan
 * already has. Nothing is added until the user accepts; each suggestion can be switched
 * off, its kind can be changed, and a doubtful one («неуверенно») starts switched off.
 */
export function PdfOpeningSuggestions({
  calibrated,
  wallCount,
  busy,
  suggestion,
  onSuggest,
  onToggle,
  onKind,
  onSelectAll,
  onAccept,
  onDismiss,
}: {
  calibrated: boolean;
  wallCount: number;
  busy: boolean;
  suggestion: { openings: readonly SuggestedOpening[]; truncated: boolean } | null;
  onSuggest: () => void;
  onToggle: (index: number) => void;
  onKind: (index: number, kind: "door" | "window") => void;
  onSelectAll: (selected: boolean) => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const items = suggestion?.openings ?? [];
  const selected = items.filter((item) => item.selected).length;
  const doubtful = items.filter((item) => item.confidence === "low").length;
  return (
    <section className="pdf-wall-suggestions pdf-opening-suggestions" aria-label={tr`Двери и окна из чертежа`} data-testid="pdf-opening-suggestions">
      <h3>
        <DoorOpen size={13} />{tr` Двери и окна из чертежа`}</h3>
      {suggestion ? (
        items.length > 0 ? (
          <>
            <p role="status">{tr`Найдено проёмов: `}<strong data-testid="opening-suggestion-count">{items.length}</strong>{tr`, выбрано`}{" "}
              <strong data-testid="opening-suggestion-selected">{selected}</strong>
              {doubtful > 0 && (
                <>{tr`, неуверенно: `}<strong data-testid="opening-suggestion-doubtful">{doubtful}</strong>
                </>
              )}{tr`. Они показаны на плане пунктиром; щелчок по проёму на плане или галочка ниже включает и исключает его. Сомнительные («неуверенно») выключены: прочтите, на чём основан вывод, и включите их сами.`}{suggestion.truncated && tr` Чертёж очень подробный: показана только часть.`}
            </p>
            <div className="pdf-wall-suggestions-bulk">
              <button type="button" disabled={busy || selected === items.length} onClick={() => onSelectAll(true)}>{tr`Выбрать все`}</button>
              <button type="button" disabled={busy || selected === 0} onClick={() => onSelectAll(false)}>{tr`Снять все`}</button>
            </div>
            <ul className="pdf-wall-suggestions-list pdf-opening-suggestions-list" aria-label={tr`Предложенные проёмы`}>
              {items.map((item, index) => (
                <li key={index} data-confidence={item.confidence} data-kind={item.kind}>
                  <label>
                    <input type="checkbox" checked={item.selected} disabled={busy} onChange={() => onToggle(index)} />
                    {item.kind === "door" ? tr`Дверь` : tr`Окно`} {index + 1}
                    <small>
                      {lengthText(item.width)}{" · "}{item.place}
                    </small>
                    {item.confidence === "low" && <span className="opening-doubt">{tr`неуверенно`}</span>}
                  </label>
                  <select
                    aria-label={tr`Тип проёма ${index + 1}`}
                    value={item.kind}
                    disabled={busy}
                    onChange={(event) => onKind(index, event.target.value as "door" | "window")}
                  >
                    <option value="door">{tr`Дверь`}</option>
                    <option value="window">{tr`Окно`}</option>
                  </select>
                  <details>
                    <summary>{tr`Почему`}</summary>
                    <ul>
                      {item.reasons.map((reason, at) => (
                        <li key={at}>{reason}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
            <div className="underlay-action-pair">
              <button disabled={busy || selected === 0} onClick={onAccept}>
                <Check size={14} />{tr` Добавить проёмы (`}{selected})
              </button>
              <button disabled={busy} onClick={onDismiss}>
                <X size={14} />{tr` Отклонить`}</button>
            </div>
          </>
        ) : (
          <>
            <p role="status">{tr`Проёмы не найдены. Они ищутся там, где в линиях чертежа прерываются обе грани стены или две стены на одной оси не доходят друг до друга на 0,4–3,2 м. Если на чертеже проём нарисован иначе, добавьте его вручную инструментами «Дверь» и «Окно».`}</p>
            <div className="underlay-action-pair">
              <button onClick={onDismiss}>{tr`Понятно`}</button>
            </div>
          </>
        )
      ) : (
        <>
          <p>{tr`Ищутся проёмы в стенах плана: разрыв граней стены, створка с дугой открывания у двери, тонкие линии остекления у окна.`}</p>
          {!calibrated && <p className="pdf-wall-suggestions-hint">{tr`Сначала задайте масштаб: ширина проёма определяется в метрах.`}</p>}
          {calibrated && wallCount === 0 && (
            <p className="pdf-wall-suggestions-hint">{tr`В плане пока нет стен. Сначала добавьте стены: проём всегда сидит в стене.`}</p>
          )}
          <div className="underlay-action-pair">
            <button disabled={busy || !calibrated || wallCount === 0} onClick={onSuggest}>
              <DoorOpen size={14} />{tr` Предложить двери и окна`}</button>
          </div>
        </>
      )}
    </section>
  );
}
