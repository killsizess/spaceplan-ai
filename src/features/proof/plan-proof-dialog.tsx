"use client";

import { tr } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, LoaderCircle, Scale, X } from "lucide-react";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { formatArea } from "@/lib/format";
import { makePlanExportFilename } from "../editor/export-files";
import { REPORT_LEVELS } from "../report/plan-report";
import { createPagedPdf } from "../report/report-file";
import { buildPlanProof, type ProofReason } from "./plan-proof";
import { layoutPlanProof } from "./proof-layout";
import "../report/plan-report.css";
import "../xray/plan-xray.css";
import "./plan-proof.css";

const areaText = (value: number | null) => (value === null ? tr`нет` : formatArea(value));

function Reason({ reason }: { reason: ProofReason }) {
  return (
    <li className="proof-reason" data-testid="proof-reason" data-rule={reason.ruleId} data-decisive={reason.decisive}>
      <strong>{reason.title}</strong>
      {reason.detail && <p>{reason.detail}</p>}
      <dl>
        {reason.citation && <div><dt>{tr`Правило`}</dt><dd>{reason.citation}</dd></div>}
        {reason.ruleStatus && <div><dt>{tr`Статус`}</dt><dd data-testid="proof-rule-status">{reason.ruleStatus}</dd></div>}
        {reason.dependsOn.length > 0 && <div><dt>{tr`Держится на`}</dt><dd data-testid="proof-depends">{reason.dependsOn.join("; ")}</dd></div>}
        <div>
          <dt>{tr`Уверенность`}</dt>
          <dd>{REPORT_LEVELS[reason.level].label}{reason.decisive && <em>{tr` · определяет итог`}</em>}</dd>
        </div>
      </dl>
    </li>
  );
}

/** One decision and why the rules answer it the way they do. Nothing here changes the plan. */
export default function PlanProofDialog({
  plan,
  appVersion,
  question,
  onSave,
  onClose,
}: {
  plan: FloorPlan;
  appVersion: string;
  question?: string;
  /** Present while the plan exists only on this screen. */
  onSave?: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [generatedAt] = useState(() => new Date().toISOString());
  const proof = useMemo(
    () => buildPlanProof(plan, { generatedAt, appVersion, ...(question ? { question } : {}) }),
    [plan, generatedAt, appVersion, question],
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      operation.current?.abort();
      dialog?.close();
    };
  }, []);

  function close() {
    operation.current?.abort();
    onClose();
  }

  async function download() {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setMessage("");
    try {
      // The drawing shows the plan after the decision: it must not pass for the plan as it is.
      const drawn = proof.decisions.length ? { ...plan, name: tr`${plan.name.slice(0, 80)}: после решения` } : plan;
      const blob = await createPagedPdf(drawn, (measure) => layoutPlanProof(proof, measure), controller.signal);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = makePlanExportFilename(`${plan.name} — proof`, "pdf");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage(tr`Сохранено в PDF.`);
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : tr`Не удалось подготовить PDF.`);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const { answer } = proof;
  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-report-dialog plan-xray-dialog plan-proof-dialog"
      aria-labelledby="plan-proof-title"
      data-testid="proof-dialog"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <button type="button" className="icon-button modal-close" aria-label={tr`Закрыть Proof`} onClick={close}>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-report-header">
        <span className="plan-report-symbol"><Scale size={22} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">{tr`SPACEPLAN PROOF · ПОЧЕМУ ВЫВОД ТАКОЙ`}</span>
          <h2 id="plan-proof-title">{proof.question}</h2>
          {proof.sourceName && (
            <p className="proof-source">{tr`Относительно плана «`}{proof.sourceName}».{onSave && tr` Это только вопрос: ваш проект не изменился.`}
            </p>
          )}
        </div>
      </header>

      <div className="plan-report-scroll">
        <section className="proof-answer" data-testid="proof-answer" data-status={proof.status} data-procedure={answer.procedure ?? "none"}>
          <span className={`xray-chip procedure-${answer.procedure ?? "unknown"}`} data-testid="proof-label">{answer.label}</span>
          <p>{answer.meaning}</p>
          {answer.citation && <small>{answer.citation}</small>}
          {proof.draftNote && <p className="proof-draft" data-testid="proof-draft">{proof.draftNote}</p>}
        </section>

        {proof.decisions.length > 0 && (
          <section aria-labelledby="proof-decisions-title">
            <h3 id="proof-decisions-title">{tr`Что меняется и почему`}</h3>
            <ol className="proof-decisions">
              {proof.decisions.map((decision) => (
                <li key={decision.id} className="proof-decision" data-testid="proof-decision" data-procedure={decision.procedure ?? "none"}>
                  <div className="proof-decision-head">
                    <strong>{decision.text}</strong>
                    {decision.procedure && <span className={`xray-chip procedure-${decision.procedure}`}>{decision.label}</span>}
                  </div>
                  {decision.reasons.length > 0 ? (
                    <ul>{decision.reasons.map((reason) => <Reason key={reason.ruleId + reason.title} reason={reason} />)}</ul>
                  ) : (
                    <p className="proof-silent" data-testid="proof-silent">
                      {proof.status === "no-rules"
                        ? tr`Правила не проверялись.`
                        : tr`Об этом шаге правила отдельно не говорят. Это не значит, что он разрешён.`}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {proof.general.length > 0 && (
          <section aria-labelledby="proof-general-title">
            <h3 id="proof-general-title">{tr`Что ещё сказали правила`}</h3>
            <ul className="proof-general">
              {proof.general.map((reason) => <Reason key={reason.ruleId + reason.title} reason={reason} />)}
            </ul>
          </section>
        )}

        {proof.status === "checked" && (
          <section aria-labelledby="proof-alternatives-title" data-testid="proof-alternatives">
            <h3 id="proof-alternatives-title">{tr`Что изменит вывод`}</h3>
            <p className="proof-note">{tr`Приложение прогнало те же правила с другими ответами. Показано только то, что меняет итог.`}</p>
            {proof.alternatives.length === 0 && <p data-testid="proof-no-alternatives">{tr`Другой тип стены и другие ответы о доме итог не меняют.`}</p>}
            <ul className="proof-alternatives">
              {proof.alternatives.map((item) => (
                <li key={`${item.subject}:${item.answer}`} data-testid="proof-alternative" data-procedure={item.procedure ?? "none"}>
                  <div className="proof-decision-head">
                    <span><b>{item.subject}: {item.answer.toLowerCase()}</b>{tr` (сейчас: `}{item.current.toLowerCase()})</span>
                    <span className={`xray-chip procedure-${item.procedure ?? "unknown"}`}>{item.label}</span>
                  </div>
                  {item.because.length > 0 && <small>{item.because.join("; ")}</small>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(proof.wallTypes.length > 0 || proof.facts.length > 0) && (
          <section className="plan-report-facts" data-testid="proof-inputs">
            <h3>{tr`На чём это держится`}</h3>
            <p>{tr`Указано владельцем плана и не проверялось. Другой ответ может изменить вывод.`}</p>
            <dl>
              {[...proof.wallTypes, ...proof.facts].map((line) => (
                <div key={line.label}><dt>{line.label}</dt><dd>{line.answer}</dd></div>
              ))}
            </dl>
          </section>
        )}

        <section className="plan-report-facts" data-testid="proof-measures">
          <h3>{tr`Что измерено по плану`}</h3>
          <dl>
            <div>
              <dt>{tr`Общая площадь`}</dt>
              <dd data-testid="proof-area">
                {proof.area.before === null ? areaText(proof.area.after) : `${areaText(proof.area.before)} → ${areaText(proof.area.after)}`}
              </dd>
            </div>
            {proof.roomChanges.map((row) => (
              <div key={row.name}><dt>{row.name}</dt><dd>{areaText(row.before)} → {areaText(row.after)}</dd></div>
            ))}
          </dl>
          {proof.checks.length > 0 && (
            <ul className="proof-checks">
              {proof.checks.map((check) => <li key={check.title} data-state={check.state}>{check.title}</li>)}
            </ul>
          )}
        </section>

        {proof.passed.length > 0 && (
          <details className="proof-passed" data-testid="proof-passed">
            <summary>{tr`Проверено и выполняется: `}{proof.passed.length}</summary>
            <ul className="proof-general">
              {proof.passed.map((reason) => <Reason key={reason.ruleId + reason.title} reason={reason} />)}
            </ul>
          </details>
        )}

        <section className="plan-report-limits" data-testid="proof-limits">
          <h3>{tr`Границы этого вывода`}</h3>
          {proof.limits.map((limit) => <p key={limit}>{limit}</p>)}
          <p data-testid="proof-fingerprint">{tr`Отпечаток плана: `}<b>{proof.fingerprint}</b>{tr`. Совпадает у того же плана с теми же ответами. Это контрольная сумма для сверки, а не электронная подпись.`}</p>
        </section>
      </div>

      <footer className="plan-report-footer">
        <p role="status" data-testid="proof-message">{message}</p>
        {onSave && <button type="button" className="secondary-button" onClick={onSave}>{tr`Сохранить как вариант`}</button>}
        <button type="button" className="primary-button" disabled={busy} onClick={() => void download()}>
          {busy ? <LoaderCircle className="pdf-loading-icon" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          {busy ? tr`Готовим PDF…` : tr`Скачать PDF`}
        </button>
      </footer>
    </dialog>
  );
}
