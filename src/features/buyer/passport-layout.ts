import { tr } from "@/lib/i18n";
import { formatArea } from "@/lib/format";
import { addReportFooters, Flow, formatDate, INK, LINE, MUTED, PAPER, type MeasureText, type ReportPage } from "../report/report-layout";
import type { ApartmentPassport } from "./apartment-passport";

const TONE_COLORS: Readonly<Record<string, { fg: string; bg: string }>> = {
  danger: { fg: "#a82a14", bg: "#fbe6e0" },
  warn: { fg: "#8f4e05", bg: "#fdf0d5" },
  ok: { fg: "#14684a", bg: "#def3e8" },
  unknown: { fg: "#3f4c5c", bg: "#e9edf2" },
};
const PROCEDURE_TONE: Readonly<Record<string, string>> = { forbidden: "danger", specialist: "warn", project: "warn", simplified: "ok", unknown: "unknown" };
const TO: Readonly<Record<string, () => string>> = {
  buyer: () => tr`Покупателю`,
  developer: () => tr`Застройщику`,
  specialist: () => tr`Специалисту`,
};
const areaText = (value: number | null) => (value === null ? tr`не определена` : formatArea(value));

/** The passport as pages; the drawings of the template and the result follow them. */
export function layoutPassport(passport: ApartmentPassport, measure: MeasureText): ReportPage[] {
  const flow = new Flow(measure);
  const { left, width } = flow;
  const paragraph = (text: string, size = 3.1, weight = 400, color = INK) => {
    flow.need(flow.height(width, text, size, weight) + 1);
    flow.y += flow.lines(left, width, text, size, weight, color) + 1;
  };

  flow.rect(left, flow.y, 6.4, 6.4, "#0f3d2e", 1.4);
  flow.text(left + 9, flow.y + 4.9, "SpacePlan AI", 4, 700, INK);
  flow.text(left + width, flow.y + 4.9, formatDate(passport.generatedAt), 3, 400, MUTED, "right");
  flow.y += 12;
  flow.text(left, flow.y + 3.4, tr`ПАСПОРТ КВАРТИРЫ`, 3, 650, MUTED);
  flow.y += 5.2;
  flow.y += flow.lines(left, width, passport.name, 6.4, 650, INK) + 1.5;
  paragraph(tr`По шаблону застройщика «${passport.templateName}»`, 3.2, 400, MUTED);

  // The outcome.
  const colors = TONE_COLORS[PROCEDURE_TONE[passport.answer.procedure ?? "unknown"] ?? "unknown"];
  const notes = [passport.answer.meaning, ...(passport.lowestLevel ? [tr`Самая низкая уверенность среди изменений: ${passport.lowestLevel}.`] : []), ...(passport.draftNote ? [passport.draftNote] : [])];
  const boxHeight = notes.reduce((sum, note) => sum + flow.height(width - 12, note, 3.2, 400) + 1, 0) + 14;
  flow.need(boxHeight + 4);
  flow.rect(left, flow.y, width, boxHeight, colors.bg, 2.4);
  flow.text(left + 6, flow.y + 8.2, passport.answer.label, 5, 700, colors.fg);
  const top = flow.y;
  flow.y += 11;
  for (const note of notes) flow.y += flow.lines(left + 6, width - 12, note, 3.2, 400, INK) + 1;
  flow.y = top + boxHeight + 4;

  // Before and after.
  flow.heading(tr`Квартира до и после`);
  const row = (label: string, value: string) => {
    flow.need(5.2);
    flow.rect(left, flow.y, width, 0.2, LINE);
    flow.y += 1.1;
    flow.text(left, flow.y + 3.1, label, 3.1, 400, INK);
    flow.text(left + width, flow.y + 3.1, value, 3.1, 600, INK, "right");
    flow.y += 4.1;
  };
  row(tr`Общая площадь`, `${areaText(passport.before.area)} → ${areaText(passport.after.area)}`);
  row(tr`Помещений`, `${passport.before.rooms.length} → ${passport.after.rooms.length}`);
  for (const room of passport.after.rooms) row(`${room.name} (${room.kind.toLowerCase()})`, formatArea(Math.round(room.area * 100) / 100));
  flow.y += 2;

  // Each change and its check.
  flow.heading(tr`Изменения и их проверка`);
  if (!passport.changes.length) paragraph(tr`Изменений нет: квартира как в шаблоне.`, 3.2, 500);
  passport.changes.forEach((change, index) => {
    const tone = TONE_COLORS[change.tone];
    const lines = [
      { text: `${index + 1}. ${change.text}`, size: 3.4, weight: 650, color: INK },
      { text: tr`Вердикт: ${change.verdict}`, size: 3.1, weight: 600, color: tone.fg },
      { text: tr`Уверенность: ${change.levelLabel}`, size: 3, weight: 500, color: MUTED },
      { text: tr`Правило: ${change.rule}`, size: 3, weight: 500, color: MUTED },
      { text: tr`Статус правила: ${change.ruleStatus}`, size: 3, weight: 500, color: MUTED },
      ...change.reasons.slice(1).map((reason) => ({ text: `· ${reason.title}`, size: 2.9, weight: 400, color: MUTED })),
    ];
    flow.need(lines.reduce((sum, line) => sum + flow.height(width, line.text, line.size, line.weight), 0) + 3);
    for (const line of lines) flow.y += flow.lines(left, width, line.text, line.size, line.weight, line.color);
    flow.y += 3;
  });

  if (passport.questions.length) {
    flow.heading(tr`Вопросы`);
    for (const question of passport.questions) {
      paragraph(`${TO[question.to]()}: ${question.text}`, 3.2, 600);
      if (question.why.length) paragraph(tr`От ответа зависит: ${question.why.join("; ")}`, 2.9, 400, MUTED);
    }
  }
  if (passport.conflicts.length) {
    flow.heading(tr`Противоречия`);
    for (const conflict of passport.conflicts) {
      paragraph(conflict.text, 3.1, 600);
      paragraph(conflict.fix, 2.9, 400, MUTED);
    }
  }
  if (passport.unconfirmed.length) {
    flow.heading(tr`Не подтверждено`);
    for (const item of passport.unconfirmed) paragraph(`· ${item}`, 3.1);
  }

  // The disclaimer, from the one shared file, and the limits of the rule base.
  const texts = [passport.disclaimer, ...passport.limits, tr`Отпечаток плана: ${passport.fingerprint}. Это контрольная сумма для сверки, а не электронная подпись.`];
  const height = texts.reduce((sum, text) => sum + flow.height(width - 10, text, 3, 400) + 1.6, 0) + 12;
  flow.need(height + 3);
  flow.y += 3;
  flow.rect(left, flow.y, width, height, PAPER, 2.4);
  const boxTop = flow.y;
  flow.text(left + 5, flow.y + 6.6, tr`Оговорка и границы`, 3.6, 700, INK);
  flow.y += 9;
  for (const text of texts) flow.y += flow.lines(left + 5, width - 10, text, 3, 400, INK) + 1.6;
  flow.y = boxTop + height;

  addReportFooters(flow, passport.appVersion);
  return flow.pages;
}
