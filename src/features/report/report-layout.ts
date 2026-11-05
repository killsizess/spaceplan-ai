import { currentLocale, tr } from "@/lib/i18n";
import { formatArea, formatLength } from "@/lib/format";
import { REPORT_LEVEL_ORDER, REPORT_LEVELS, type PlanReport, type ReportFinding, type ReportLevel, type ReportState } from "./plan-report";

/**
 * Pages of the report as drawing operations, in millimetres on A4. Pure: the only thing
 * it needs from a browser is how wide a text is, so it can be tested without one.
 */
export const REPORT_PAGE = { width: 210, height: 297, margin: 16, footer: 14 } as const;

export type ReportOp =
  | { kind: "text"; x: number; y: number; text: string; size: number; weight: number; color: string; align?: "left" | "right" }
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill: string; radius?: number };

export interface ReportPage {
  ops: ReportOp[];
}

/** Width of a text in millimetres at a font size in millimetres. */
export type MeasureText = (text: string, size: number, weight: number) => number;

export const INK = "#10231c", MUTED = "#55635b", LINE = "#dfdccf", PAPER = "#f6f4ec", WHITE = "#ffffff";

export const REPORT_LEVEL_COLORS: Readonly<Record<ReportLevel | "clear", { fg: string; bg: string }>> = {
  specialist: { fg: "#a82a14", bg: "#fbe6e0" },
  undetermined: { fg: "#3f4c5c", bg: "#e9edf2" },
  assumption: { fg: "#8f4e05", bg: "#fdf0d5" },
  verified: { fg: "#14684a", bg: "#def3e8" },
  clear: { fg: "#14684a", bg: "#def3e8" },
};

const STATE_MARK: Readonly<Record<ReportState, string>> = { problem: "!", note: "·", ok: "✓" };

/** Greedy wrapping by words; a word wider than the line is cut. */
export function wrapText(text: string, width: number, size: number, weight: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size, weight) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (measure(rest, size, weight) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut), size, weight) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export class Flow {
  readonly pages: ReportPage[] = [{ ops: [] }];
  y: number = REPORT_PAGE.margin;
  readonly left = REPORT_PAGE.margin;
  readonly width = REPORT_PAGE.width - 2 * REPORT_PAGE.margin;
  readonly bottom = REPORT_PAGE.height - REPORT_PAGE.footer - 4;
  constructor(readonly measure: MeasureText) {}
  private get ops() {
    return this.pages[this.pages.length - 1].ops;
  }
  /** Starts a new page unless `height` still fits here. */
  need(height: number) {
    if (this.y + height > this.bottom && this.y > REPORT_PAGE.margin) {
      this.pages.push({ ops: [] });
      this.y = REPORT_PAGE.margin;
    }
  }
  text(x: number, y: number, text: string, size: number, weight: number, color: string, align?: "left" | "right") {
    this.ops.push({ kind: "text", x, y, text, size, weight, color, ...(align ? { align } : {}) });
  }
  rect(x: number, y: number, width: number, height: number, fill: string, radius?: number) {
    this.ops.push({ kind: "rect", x, y, width, height, fill, ...(radius ? { radius } : {}) });
  }
  lines(x: number, width: number, text: string, size: number, weight: number, color: string): number {
    const wrapped = wrapText(text, width, size, weight, this.measure);
    const leading = size * 1.35;
    wrapped.forEach((line, index) => this.text(x, this.y + size + index * leading, line, size, weight, color));
    return wrapped.length * leading;
  }
  height(width: number, text: string, size: number, weight: number): number {
    return wrapText(text, width, size, weight, this.measure).length * size * 1.35;
  }
  heading(text: string, after = 0) {
    this.need(12 + after);
    this.y += 3;
    this.text(this.left, this.y + 4.4, text, 4.4, 650, INK);
    this.y += 7.5;
  }
}

/** The moment in the reader's own time zone: a report is read by a person, not a server. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(currentLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

function drawFinding(flow: Flow, finding: ReportFinding) {
  const textLeft = flow.left + 6;
  const textWidth = flow.width - 6;
  const titleHeight = flow.height(textWidth, finding.title, 3.4, 600);
  const detailHeight = finding.detail ? flow.height(textWidth, finding.detail, 3, 400) : 0;
  const sourceHeight = finding.source ? flow.height(textWidth, finding.source, 2.8, 500) : 0;
  const height = titleHeight + detailHeight + sourceHeight + 2.6;
  flow.need(height);
  const colors = REPORT_LEVEL_COLORS[finding.level];
  flow.rect(flow.left, flow.y + 0.5, 4, 4, finding.state === "problem" ? colors.fg : colors.bg, 2);
  flow.text(flow.left + 2, flow.y + 3.5, STATE_MARK[finding.state], 2.8, 700, finding.state === "problem" ? WHITE : colors.fg);
  flow.lines(textLeft, textWidth, finding.title, 3.4, 600, INK);
  flow.y += titleHeight;
  if (finding.detail) {
    flow.lines(textLeft, textWidth, finding.detail, 3, 400, MUTED);
    flow.y += detailHeight;
  }
  if (finding.source) {
    flow.lines(textLeft, textWidth, finding.source, 2.8, 500, MUTED);
    flow.y += sourceHeight;
  }
  flow.y += 2.6;
}

export function layoutPlanReport(report: PlanReport, measure: MeasureText): ReportPage[] {
  const flow = new Flow(measure);
  const { left, width } = flow;

  // Title.
  flow.rect(left, flow.y, 6.4, 6.4, "#0f3d2e", 1.4);
  flow.text(left + 9, flow.y + 4.9, "SpacePlan AI", 4, 700, INK);
  flow.text(left + width, flow.y + 4.9, formatDate(report.generatedAt), 3, 400, MUTED, "right");
  flow.y += 12;
  flow.text(left, flow.y + 3.4, tr`ОТЧЁТ ПО ПЛАНУ`, 3, 650, MUTED);
  flow.y += 5.2;
  flow.y += flow.lines(left, width, report.planName, 7.4, 650, INK) + 3.5;

  // Verdict.
  const colors = REPORT_LEVEL_COLORS[report.verdict.level];
  const verdictHeight = flow.height(width - 12, report.verdict.text, 3.3, 400) + 15;
  flow.rect(left, flow.y, width, verdictHeight, colors.bg, 2.4);
  flow.text(left + 6, flow.y + 8.4, report.verdict.title, 5.2, 700, colors.fg);
  const verdictTop = flow.y;
  flow.y += 11;
  flow.lines(left + 6, width - 12, report.verdict.text, 3.3, 400, INK);
  flow.y = verdictTop + verdictHeight + 5;

  // Figures.
  const { totals } = report;
  const figures: [string, string][] = [
    [tr`Площадь`, totals.area === null ? tr`не определена` : formatArea(totals.area)],
    [tr`Помещений`, String(totals.rooms)],
    [tr`Стен`, `${totals.walls}`],
    [tr`Двери / окна`, `${totals.doors} / ${totals.windows}`],
  ];
  const cell = (width - 3 * 3) / 4;
  figures.forEach(([label, value], index) => {
    const x = left + index * (cell + 3);
    flow.rect(x, flow.y, cell, 16, PAPER, 2);
    flow.text(x + 3.5, flow.y + 5.6, label, 2.8, 500, MUTED);
    flow.text(x + 3.5, flow.y + 12.2, value, value.length > 10 ? 3.8 : 5, 700, INK);
  });
  flow.y += 19;
  flow.text(left, flow.y + 3, tr`Типы стен: несущих ${totals.bearing}, перегородок ${totals.partition}, не указано ${totals.unknownWalls}.`, 3, 400, MUTED);
  flow.y += 7;
  if (report.origin) {
    const was = report.origin.areaBefore === null ? tr`не определена` : formatArea(report.origin.areaBefore);
    const now = report.origin.areaAfter === null ? tr`не определена` : formatArea(report.origin.areaAfter);
    flow.y += flow.lines(left, width, tr`Вариант плана «${report.origin.planName}». Площадь: было ${was}, стало ${now}.`, 3, 400, MUTED) + 2;
  }

  // Findings by level.
  flow.heading(tr`Выводы`);
  for (const level of REPORT_LEVEL_ORDER) {
    const items = report.findings.filter((finding) => finding.level === level);
    if (!items.length) continue;
    const info = REPORT_LEVELS[level];
    flow.need(16);
    flow.rect(left, flow.y, width, 6.6, REPORT_LEVEL_COLORS[level].bg, 1.4);
    flow.text(left + 3, flow.y + 4.5, info.label, 3.2, 700, REPORT_LEVEL_COLORS[level].fg);
    flow.text(left + width - 3, flow.y + 4.5, info.meaning, 2.7, 400, REPORT_LEVEL_COLORS[level].fg, "right");
    flow.y += 9;
    for (const finding of items) drawFinding(flow, finding);
    flow.y += 1.5;
  }

  // Rooms.
  if (report.rooms.length) {
    flow.heading(tr`Помещения`);
    const nameWidth = width - 62;
    flow.need(8);
    flow.text(left, flow.y + 3, tr`Название`, 2.8, 600, MUTED);
    flow.text(left + nameWidth + 2, flow.y + 3, tr`Назначение`, 2.8, 600, MUTED);
    flow.text(left + width, flow.y + 3, tr`Площадь`, 2.8, 600, MUTED, "right");
    flow.y += 5;
    for (const room of report.rooms) {
      const height = flow.height(nameWidth, room.name, 3.3, 500);
      flow.need(height + 2.4);
      flow.rect(left, flow.y, width, 0.2, LINE);
      flow.y += 1.1;
      flow.lines(left, nameWidth, room.name, 3.3, 500, INK);
      flow.text(left + nameWidth + 2, flow.y + 3.3, room.kind, 3.1, 400, MUTED);
      flow.text(left + width, flow.y + 3.3, tr`${formatLength(Math.round(room.area * 100) / 100)} м²`, 3.3, 600, INK, "right");
      flow.y += height + 1.2;
    }
    flow.y += 3;
  }

  // The answers the rule findings were drawn from.
  if (report.facts.length) {
    flow.heading(tr`Ответы о доме`);
    flow.y += flow.lines(left, width, tr`Указаны владельцем плана и не проверялись. Выводы по нормам зависят от них.`, 3, 400, MUTED) + 1.4;
    for (const fact of report.facts) {
      flow.need(5.2);
      flow.rect(left, flow.y, width, 0.2, LINE);
      flow.y += 1.1;
      flow.text(left, flow.y + 3.1, fact.label, 3.1, 400, INK);
      flow.text(left + width, flow.y + 3.1, fact.answer, 3.1, 600, INK, "right");
      flow.y += 4.1;
    }
    flow.y += 3;
  }

  // Limits.
  const limitHeight = report.limits.reduce((sum, limit) => sum + flow.height(width - 10, limit, 3, 400) + 1.6, 0) + 12;
  flow.need(limitHeight + 3);
  flow.y += 3;
  flow.rect(left, flow.y, width, limitHeight, PAPER, 2.4);
  const top = flow.y;
  flow.text(left + 5, flow.y + 6.6, tr`Границы этого отчёта`, 3.6, 700, INK);
  flow.y += 9;
  for (const limit of report.limits) {
    flow.y += flow.lines(left + 5, width - 10, limit, 3, 400, INK) + 1.6;
  }
  flow.y = top + limitHeight;

  addReportFooters(flow, report.appVersion);
  return flow.pages;
}

/** Footers, once the page count is known. */
export function addReportFooters(flow: Flow, appVersion: string) {
  const { left, width } = flow;
  const total = flow.pages.length;
  flow.pages.forEach((page, index) => {
    const y = REPORT_PAGE.height - REPORT_PAGE.footer + 4;
    page.ops.push({ kind: "rect", x: left, y: y - 4.5, width, height: 0.2, fill: LINE });
    page.ops.push({ kind: "text", x: left, y, text: tr`SpacePlan AI ${appVersion} · не заменяет проект и согласование`, size: 2.6, weight: 400, color: MUTED });
    page.ops.push({ kind: "text", x: left + width, y, text: tr`Стр. ${index + 1} из ${total}`, size: 2.6, weight: 400, color: MUTED, align: "right" });
  });
}
