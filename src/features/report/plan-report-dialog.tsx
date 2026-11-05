"use client";

import { tr } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileCheck2, LoaderCircle, X } from "lucide-react";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { formatArea } from "@/lib/format";
import { makePlanExportFilename } from "../editor/export-files";
import { buildPlanReport, REPORT_LEVEL_ORDER, REPORT_LEVELS, type ReportState } from "./plan-report";
import { createPlanReportPdf } from "./report-file";
import "./plan-report.css";

const STATE_LABEL: Readonly<Record<ReportState, string>> = { problem: tr`Замечание`, note: tr`К сведению`, ok: tr`В порядке` };

export default function PlanReportDialog({
  plan,
  appVersion,
  onProof,
  onClose,
}: {
  plan: FloorPlan;
  appVersion: string;
  /** Only a variant is a decision to explain. */
  onProof?: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [generatedAt] = useState(() => new Date().toISOString());
  const report = useMemo(() => buildPlanReport(plan, { generatedAt, appVersion }), [plan, generatedAt, appVersion]);
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
      const blob = await createPlanReportPdf(plan, report, controller.signal);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = makePlanExportFilename(tr`${plan.name} — отчёт`, "pdf");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage(tr`Отчёт сохранён в PDF.`);
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : tr`Не удалось подготовить PDF.`);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const { totals, verdict } = report;
  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-report-dialog"
      aria-labelledby="plan-report-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <button type="button" className="icon-button modal-close" aria-label={tr`Закрыть отчёт`} onClick={close} autoFocus>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-report-header">
        <span className="plan-report-symbol"><FileCheck2 size={22} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">{tr`ОТЧЁТ ПО ПЛАНУ`}</span>
          <h2 id="plan-report-title">{plan.name}</h2>
        </div>
      </header>

      <div className="plan-report-scroll">
        <section className={`plan-report-verdict level-${verdict.level}`} data-testid="report-verdict" data-level={verdict.level}>
          <strong>{verdict.title}</strong>
          <p>{verdict.text}</p>
        </section>

        <dl className="plan-report-figures">
          <div><dt>{tr`Площадь`}</dt><dd data-testid="report-area">{totals.area === null ? tr`не определена` : formatArea(totals.area)}</dd></div>
          <div><dt>{tr`Помещений`}</dt><dd>{totals.rooms}</dd></div>
          <div>
            <dt>{tr`Стен`}</dt>
            <dd>{totals.walls}</dd>
            <small data-testid="report-wall-kinds">{tr`несущих `}{totals.bearing}{tr` · перегородок `}{totals.partition}{tr` · не указано `}{totals.unknownWalls}</small>
          </div>
          <div><dt>{tr`Двери / окна`}</dt><dd>{totals.doors} / {totals.windows}</dd></div>
        </dl>

        {report.origin && (
          <p className="plan-report-origin" data-testid="report-origin">{tr`Вариант плана «`}{report.origin.planName}{tr`». Площадь: было`}{" "}
            {report.origin.areaBefore === null ? tr`не определена` : formatArea(report.origin.areaBefore)}{tr`, стало`}{" "}
            {report.origin.areaAfter === null ? tr`не определена` : formatArea(report.origin.areaAfter)}.
          </p>
        )}

        {REPORT_LEVEL_ORDER.map((level) => {
          const items = report.findings.filter((finding) => finding.level === level);
          if (!items.length) return null;
          return (
            <section key={level} className={`plan-report-level level-${level}`} data-testid={`report-level-${level}`}>
              <h3>
                {REPORT_LEVELS[level].label} <span>{items.length}</span>
                <small>{REPORT_LEVELS[level].meaning}</small>
              </h3>
              <ul>
                {items.map((finding, index) => (
                  <li key={index} data-state={finding.state}>
                    <span className="plan-report-mark" title={STATE_LABEL[finding.state]} aria-label={STATE_LABEL[finding.state]} />
                    <div>
                      <strong>{finding.title}</strong>
                      {finding.detail && <p>{finding.detail}</p>}
                      {finding.source && <p className="plan-report-source">{finding.source}</p>}
                      {finding.ruleStatus && <p className="plan-report-source" data-testid="report-rule-status">{tr`Статус правила: ${finding.ruleStatus}`}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {report.rooms.length > 0 && (
          <section className="plan-report-rooms">
            <h3>{tr`Помещения`}</h3>
            <table>
              <thead>
                <tr><th scope="col">{tr`Название`}</th><th scope="col">{tr`Назначение`}</th><th scope="col">{tr`Площадь`}</th></tr>
              </thead>
              <tbody>
                {report.rooms.map((room, index) => (
                  <tr key={index}><th scope="row">{room.name}</th><td>{room.kind}</td><td>{formatArea(Math.round(room.area * 100) / 100)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {report.facts.length > 0 && (
          <section className="plan-report-facts" data-testid="report-facts">
            <h3>{tr`Ответы о доме`}</h3>
            <p>{tr`Указаны владельцем плана и не проверялись. Выводы по нормам зависят от них.`}</p>
            <dl>
              {report.facts.map((fact) => (
                <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.answer}</dd></div>
              ))}
            </dl>
          </section>
        )}

        <section className="plan-report-limits" data-testid="report-limits">
          <h3>{tr`Границы этого отчёта`}</h3>
          {report.limits.map((limit) => <p key={limit}>{limit}</p>)}
        </section>
      </div>

      <footer className="plan-report-footer">
        <p role="status" data-testid="report-message">{message}</p>
        {onProof && <button type="button" className="secondary-button" onClick={onProof}>{tr`Почему такой вывод`}</button>}
        <button type="button" className="primary-button" disabled={busy} onClick={() => void download()}>
          {busy ? <LoaderCircle className="pdf-loading-icon" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          {busy ? tr`Готовим PDF…` : tr`Скачать PDF`}
        </button>
      </footer>
    </dialog>
  );
}
