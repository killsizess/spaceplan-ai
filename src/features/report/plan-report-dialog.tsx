"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileCheck2, LoaderCircle, X } from "lucide-react";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { formatArea } from "@/lib/format";
import { makePlanExportFilename } from "../editor/export-files";
import { buildPlanReport, REPORT_LEVEL_ORDER, REPORT_LEVELS, type ReportState } from "./plan-report";
import { createPlanReportPdf } from "./report-file";
import "./plan-report.css";

const STATE_LABEL: Readonly<Record<ReportState, string>> = { problem: "Замечание", note: "К сведению", ok: "В порядке" };

export default function PlanReportDialog({
  plan,
  appVersion,
  onClose,
}: {
  plan: FloorPlan;
  appVersion: string;
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
      link.download = makePlanExportFilename(`${plan.name} — отчёт`, "pdf");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage("Отчёт сохранён в PDF.");
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : "Не удалось подготовить PDF.");
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
      <button type="button" className="icon-button modal-close" aria-label="Закрыть отчёт" onClick={close} autoFocus>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-report-header">
        <span className="plan-report-symbol"><FileCheck2 size={22} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">ОТЧЁТ ПО ПЛАНУ</span>
          <h2 id="plan-report-title">{plan.name}</h2>
        </div>
      </header>

      <div className="plan-report-scroll">
        <section className={`plan-report-verdict level-${verdict.level}`} data-testid="report-verdict" data-level={verdict.level}>
          <strong>{verdict.title}</strong>
          <p>{verdict.text}</p>
        </section>

        <dl className="plan-report-figures">
          <div><dt>Площадь</dt><dd data-testid="report-area">{totals.area === null ? "не определена" : formatArea(totals.area)}</dd></div>
          <div><dt>Помещений</dt><dd>{totals.rooms}</dd></div>
          <div>
            <dt>Стен</dt>
            <dd>{totals.walls}</dd>
            <small data-testid="report-wall-kinds">несущих {totals.bearing} · перегородок {totals.partition} · не указано {totals.unknownWalls}</small>
          </div>
          <div><dt>Двери / окна</dt><dd>{totals.doors} / {totals.windows}</dd></div>
        </dl>

        {report.origin && (
          <p className="plan-report-origin" data-testid="report-origin">
            Вариант плана «{report.origin.planName}». Площадь: было{" "}
            {report.origin.areaBefore === null ? "не определена" : formatArea(report.origin.areaBefore)}, стало{" "}
            {report.origin.areaAfter === null ? "не определена" : formatArea(report.origin.areaAfter)}.
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
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {report.rooms.length > 0 && (
          <section className="plan-report-rooms">
            <h3>Помещения</h3>
            <table>
              <thead>
                <tr><th scope="col">Название</th><th scope="col">Назначение</th><th scope="col">Площадь</th></tr>
              </thead>
              <tbody>
                {report.rooms.map((room, index) => (
                  <tr key={index}><th scope="row">{room.name}</th><td>{room.kind}</td><td>{formatArea(Math.round(room.area * 100) / 100)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="plan-report-limits" data-testid="report-limits">
          <h3>Границы этого отчёта</h3>
          {report.limits.map((limit) => <p key={limit}>{limit}</p>)}
        </section>
      </div>

      <footer className="plan-report-footer">
        <p role="status" data-testid="report-message">{message}</p>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void download()}>
          {busy ? <LoaderCircle className="pdf-loading-icon" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          {busy ? "Готовим PDF…" : "Скачать PDF"}
        </button>
      </footer>
    </dialog>
  );
}
