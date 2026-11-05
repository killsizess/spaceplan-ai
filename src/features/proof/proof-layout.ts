import { tr } from "@/lib/i18n";
import type { Procedure } from "@/domain/rules/types";
import { formatArea } from "@/lib/format";
import { addReportFooters, Flow, formatDate, INK, LINE, MUTED, PAPER, REPORT_LEVEL_COLORS, type MeasureText, type ReportPage } from "../report/report-layout";
import { REPORT_LEVELS } from "../report/plan-report";
import type { PlanProof, ProofReason } from "./plan-proof";

/** The colours of a procedure on paper, in the same spirit as the screen. */
const PROCEDURE_COLORS: Readonly<Record<Procedure | "none", { fg: string; bg: string }>> = {
  forbidden: { fg: "#a82a14", bg: "#fbe6e0" },
  specialist: { fg: "#8f4e05", bg: "#fdf0d5" },
  project: { fg: "#1f4e8c", bg: "#e3edf9" },
  simplified: { fg: "#14684a", bg: "#def3e8" },
  unknown: { fg: "#3f4c5c", bg: "#e9edf2" },
  none: { fg: "#3f4c5c", bg: "#e9edf2" },
};

const areaText = (value: number | null) => (value === null ? tr`нет` : formatArea(value));

function drawReason(flow: Flow, reason: ProofReason) {
  const left = flow.left + 5, width = flow.width - 5;
  const lines: { text: string; size: number; weight: number; color: string }[] = [
    { text: reason.title, size: 3.2, weight: 600, color: INK },
    ...(reason.detail ? [{ text: reason.detail, size: 3, weight: 400, color: MUTED }] : []),
    ...(reason.citation ? [{ text: tr`Правило: ${reason.citation}`, size: 2.8, weight: 500, color: MUTED }] : []),
    ...(reason.ruleStatus ? [{ text: tr`Статус правила: ${reason.ruleStatus}`, size: 2.8, weight: 500, color: MUTED }] : []),
    ...(reason.dependsOn.length ? [{ text: tr`Держится на: ${reason.dependsOn.join("; ")}`, size: 2.8, weight: 500, color: MUTED }] : []),
    { text: tr`Уверенность: ${REPORT_LEVELS[reason.level].label}${reason.decisive ? tr`. Определяет итог` : ""}`, size: 2.8, weight: 500, color: REPORT_LEVEL_COLORS[reason.level].fg },
  ];
  flow.need(lines.reduce((sum, line) => sum + flow.height(width, line.text, line.size, line.weight), 0) + 2);
  for (const line of lines) flow.y += flow.lines(left, width, line.text, line.size, line.weight, line.color);
  flow.y += 2;
}

function drawLines(flow: Flow, rows: readonly { label: string; answer: string }[]) {
  const { left, width } = flow;
  for (const row of rows) {
    flow.need(5.2);
    flow.rect(left, flow.y, width, 0.2, LINE);
    flow.y += 1.1;
    flow.text(left, flow.y + 3.1, row.label, 3.1, 400, INK);
    flow.text(left + width, flow.y + 3.1, row.answer, 3.1, 600, INK, "right");
    flow.y += 4.1;
  }
  flow.y += 2;
}

/** Proof as pages. Pure, like the report: only the width of a text comes from a browser. */
export function layoutPlanProof(proof: PlanProof, measure: MeasureText): ReportPage[] {
  const flow = new Flow(measure);
  const { left, width } = flow;

  flow.rect(left, flow.y, 6.4, 6.4, "#0f3d2e", 1.4);
  flow.text(left + 9, flow.y + 4.9, "SpacePlan AI", 4, 700, INK);
  flow.text(left + width, flow.y + 4.9, formatDate(proof.generatedAt), 3, 400, MUTED, "right");
  flow.y += 12;
  flow.text(left, flow.y + 3.4, tr`SPACEPLAN PROOF: ПОЧЕМУ ВЫВОД ТАКОЙ`, 3, 650, MUTED);
  flow.y += 5.2;
  flow.y += flow.lines(left, width, proof.question, 6.4, 650, INK) + 1.5;
  if (proof.sourceName) flow.y += flow.lines(left, width, tr`Относительно плана «${proof.sourceName}»`, 3.2, 400, MUTED) + 2;

  // The answer.
  const colors = PROCEDURE_COLORS[proof.answer.procedure ?? "none"];
  const notes = [proof.answer.meaning, ...(proof.answer.citation ? [proof.answer.citation] : []), ...(proof.draftNote ? [proof.draftNote] : [])];
  const answerHeight = notes.reduce((sum, note) => sum + flow.height(width - 12, note, 3.2, 400) + 1, 0) + 14;
  flow.need(answerHeight + 4);
  flow.rect(left, flow.y, width, answerHeight, colors.bg, 2.4);
  flow.text(left + 6, flow.y + 8.2, proof.answer.label, 5, 700, colors.fg);
  const top = flow.y;
  flow.y += 11;
  for (const note of notes) flow.y += flow.lines(left + 6, width - 12, note, 3.2, 400, INK) + 1;
  flow.y = top + answerHeight + 4;

  if (proof.decisions.length) {
    flow.heading(tr`Что меняется и почему`);
    for (const decision of proof.decisions) {
      flow.need(14);
      flow.y += flow.lines(left, width, decision.text, 3.5, 700, INK);
      if (decision.label) flow.y += flow.lines(left, width, decision.label, 3, 600, PROCEDURE_COLORS[decision.procedure ?? "none"].fg);
      flow.y += 1.2;
      if (!decision.reasons.length) {
        flow.y += flow.lines(left + 5, width - 5, tr`Об этом шаге правила отдельно не говорят. Это не значит, что он разрешён.`, 3, 400, MUTED) + 2;
      }
      for (const reason of decision.reasons) drawReason(flow, reason);
    }
  }
  if (proof.general.length) {
    flow.heading(tr`Что ещё сказали правила`);
    for (const reason of proof.general) drawReason(flow, reason);
  }

  if (proof.status === "checked") {
    flow.heading(tr`Что изменит вывод`);
    flow.y += flow.lines(left, width, tr`Те же правила прогнаны с другими ответами. Показано только то, что меняет итог.`, 3, 400, MUTED) + 2;
    if (!proof.alternatives.length) flow.y += flow.lines(left, width, tr`Другой тип стены и другие ответы о доме итог не меняют.`, 3.2, 500, INK) + 2;
    for (const item of proof.alternatives) {
      const head = tr`${item.subject}: ${item.answer.toLowerCase()} (сейчас: ${item.current.toLowerCase()})`;
      const because = item.because.join("; ");
      flow.need(flow.height(width, head, 3.2, 600) + flow.height(width, because, 2.9, 400) + 7);
      flow.y += flow.lines(left, width, head, 3.2, 600, INK);
      flow.y += flow.lines(left, width, tr`Итог станет: ${item.label}`, 3, 600, PROCEDURE_COLORS[item.procedure ?? "none"].fg);
      if (because) flow.y += flow.lines(left, width, because, 2.9, 400, MUTED);
      flow.y += 2;
    }
  }

  if (proof.wallTypes.length || proof.facts.length) {
    flow.heading(tr`На чём это держится`);
    flow.y += flow.lines(left, width, tr`Указано владельцем плана и не проверялось. Другой ответ может изменить вывод.`, 3, 400, MUTED) + 2;
    drawLines(flow, [...proof.wallTypes, ...proof.facts].map((line) => ({ label: line.label, answer: line.answer })));
  }

  flow.heading(tr`Что измерено по плану`);
  drawLines(flow, [
    { label: tr`Общая площадь`, answer: proof.area.before === null ? areaText(proof.area.after) : `${areaText(proof.area.before)} → ${areaText(proof.area.after)}` },
    ...proof.roomChanges.map((row) => ({ label: row.name, answer: `${areaText(row.before)} → ${areaText(row.after)}` })),
  ]);
  for (const check of proof.checks) {
    flow.need(flow.height(width, check.title, 3, 500) + 2);
    flow.y += flow.lines(left, width, check.title, 3, 500, INK) + 1;
  }

  // Limits.
  const limits = [...proof.limits, tr`Отпечаток плана: ${proof.fingerprint}. Совпадает у того же плана с теми же ответами. Это контрольная сумма для сверки, а не электронная подпись.`];
  const limitHeight = limits.reduce((sum, limit) => sum + flow.height(width - 10, limit, 3, 400) + 1.6, 0) + 12;
  flow.need(limitHeight + 3);
  flow.y += 3;
  flow.rect(left, flow.y, width, limitHeight, PAPER, 2.4);
  const limitTop = flow.y;
  flow.text(left + 5, flow.y + 6.6, tr`Границы этого вывода`, 3.6, 700, INK);
  flow.y += 9;
  for (const limit of limits) flow.y += flow.lines(left + 5, width - 10, limit, 3, 400, INK) + 1.6;
  flow.y = limitTop + limitHeight;

  addReportFooters(flow, proof.appVersion);
  return flow.pages;
}
