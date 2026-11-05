"use client";

import { FileText, Undo2 } from "lucide-react";
import type { BuildingFacts } from "@/domain/floor-plan/types";
import type { FactKey } from "@/domain/rules/types";
import { tr } from "@/lib/i18n";
import type { BuyerReview } from "./buyer-review";
import "../xray/plan-xray.css";
import "./buyer-panel.css";

const TO: Readonly<Record<"buyer" | "developer" | "specialist", () => string>> = {
  buyer: () => tr`Вопрос вам`,
  developer: () => tr`Вопрос застройщику`,
  specialist: () => tr`Вопрос специалисту`,
};

/** The buyer's side panel: the journal of changes with their checks, questions and conflicts. */
export function BuyerPanel({
  review,
  facts,
  onShow,
  onRevert,
  onAnswer,
  onPassport,
  busy,
}: {
  review: BuyerReview;
  facts: BuildingFacts | undefined;
  onShow: (id: string) => void;
  onRevert: (changeId: string) => void;
  onAnswer: (facts: BuildingFacts) => void;
  onPassport: () => void;
  busy: boolean;
}) {
  const { proof, changes, questions, conflicts, unconfirmed } = review;
  return (
    <section className="buyer-panel" data-testid="buyer-panel">
      <p className="buyer-note">{tr`Квартира по шаблону «${review.templateName}». Менять можно перегородки и комнаты, которые разрешил застройщик: они отмечены пунктиром на плане.`}</p>
      <div className="buyer-answer" data-testid="buyer-answer" data-procedure={proof.answer.procedure ?? "none"}>
        <span className={`xray-chip procedure-${proof.answer.procedure ?? "unknown"}`}>{proof.answer.label}</span>
        <p>{proof.answer.meaning}</p>
        {proof.draftNote && <small>{proof.draftNote}</small>}
      </div>

      <h3>{tr`Журнал изменений`}</h3>
      {!changes.length && <p className="buyer-note" data-testid="buyer-no-changes">{tr`Изменений пока нет. Выберите разрешённую перегородку и перенесите или уберите её, или нарисуйте новую внутри разрешённой комнаты.`}</p>}
      <ol className="buyer-changes" data-testid="buyer-changes">
        {changes.map((change) => (
          <li key={change.id} data-testid="buyer-change" data-change={change.id} data-tone={change.tone} data-level={change.level}>
            <div className="buyer-change-head">
              <strong>{change.text}</strong>
              <span className={`xray-chip procedure-${change.procedure ?? "unknown"}`} data-testid="buyer-verdict">{change.verdict}</span>
            </div>
            <dl>
              <div><dt>{tr`Уверенность`}</dt><dd data-testid="buyer-level">{change.levelLabel}</dd></div>
              <div><dt>{tr`Правило`}</dt><dd data-testid="buyer-rule">{change.rule}</dd></div>
              <div><dt>{tr`Статус`}</dt><dd data-testid="buyer-rule-status">{change.ruleStatus}</dd></div>
            </dl>
            {change.reasons.length > 1 && (
              <details>
                <summary>{tr`Все выводы: ${change.reasons.length}`}</summary>
                <ul>{change.reasons.map((reason) => <li key={reason.ruleId + reason.title}>{reason.title}</li>)}</ul>
              </details>
            )}
            <div className="buyer-actions">
              {(change.wallIds[0] || change.openingIds[0]) && (
                <button type="button" className="text-button" onClick={() => onShow(change.wallIds[0] ?? change.openingIds[0])}>{tr`Показать`}</button>
              )}
              <button type="button" className="text-button" disabled={busy} onClick={() => onRevert(change.id)}>
                <Undo2 size={12} aria-hidden="true" /> {tr`Отменить это изменение`}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {proof.general.length > 0 && (
        <>
          <h3>{tr`Что ещё сказали правила`}</h3>
          <ul className="buyer-list">{proof.general.map((reason) => <li key={reason.ruleId + reason.title}>{reason.title}</li>)}</ul>
        </>
      )}

      {questions.length > 0 && (
        <>
          <h3>{tr`Уточняющие вопросы`}</h3>
          <ul className="buyer-questions" data-testid="buyer-questions">
            {questions.map((question) => (
              <li key={question.id} data-testid="buyer-question" data-question={question.id} data-to={question.to}>
                <small>{TO[question.to]()}</small>
                <strong>{question.text}</strong>
                {question.why.length > 0 && <p>{tr`От ответа зависит: ${question.why.join("; ")}`}</p>}
                {question.answer && (
                  <div className="buyer-answers">
                    {question.answer.options.map((option) => (
                      <button
                        key={String(option.value)}
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => onAnswer({ ...facts, [question.answer!.key as FactKey]: option.value } as BuildingFacts)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {conflicts.length > 0 && (
        <>
          <h3>{tr`Противоречия`}</h3>
          <ul className="buyer-list" data-testid="buyer-conflicts">
            {conflicts.map((conflict) => (
              <li key={conflict.text}><strong>{conflict.text}</strong><p>{conflict.fix}</p></li>
            ))}
          </ul>
        </>
      )}

      {unconfirmed.length > 0 && (
        <>
          <h3>{tr`Не подтверждено`}</h3>
          <ul className="buyer-list" data-testid="buyer-unconfirmed">{unconfirmed.map((item) => <li key={item}>{item}</li>)}</ul>
        </>
      )}

      <button type="button" className="primary-button" disabled={busy} onClick={onPassport}>
        <FileText size={15} aria-hidden="true" /> {tr`Паспорт квартиры (PDF)`}
      </button>
    </section>
  );
}
