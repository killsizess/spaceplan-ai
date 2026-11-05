import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { buildPlanReport, type PlanReport } from "./plan-report";
import { layoutPlanReport, REPORT_PAGE, wrapText, type MeasureText, type ReportOp } from "./report-layout";

/** Roughly the width of a sans-serif face: half the size per character. */
const measure: MeasureText = (text, size) => text.length * size * 0.5;

const meta = { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "0.29.0" };
const plan: FloorPlan = {
  ...createEmptyPlan("layout"),
  name: "Квартира на Садовой",
  roomMode: "walls",
  walls: [
    { id: "a", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 },
    { id: "b", start: { x: 5, y: 0 }, end: { x: 5, y: 4 }, thickness: 0.2, height: 2.7 },
    { id: "c", start: { x: 5, y: 4 }, end: { x: 0, y: 4 }, thickness: 0.2, height: 2.7 },
    { id: "d", start: { x: 0, y: 4 }, end: { x: 0, y: 0 }, thickness: 0.2, height: 2.7 },
  ],
};
const texts = (ops: readonly ReportOp[]) => ops.flatMap((op) => (op.kind === "text" ? [op] : []));
const allText = (pages: ReturnType<typeof layoutPlanReport>) => pages.flatMap((page) => texts(page.ops).map((op) => op.text)).join(" ");

function longReport(findings: number): PlanReport {
  const report = buildPlanReport(plan, meta);
  return {
    ...report,
    findings: Array.from({ length: findings }, (_, index) => ({
      level: "assumption" as const,
      state: "problem" as const,
      title: `Замечание номер ${index + 1}`,
      detail: "Подробное объяснение, которое занимает несколько строк и должно переноситься по словам, не выходя за поле страницы и не пропадая.",
    })),
    rooms: Array.from({ length: 40 }, (_, index) => ({ name: `Помещение ${index + 1}`, kind: "Комната", area: 12.5 })),
  };
}

describe("text wrapping", () => {
  it("breaks by words and keeps every word", () => {
    const lines = wrapText("один два три четыре пять шесть", 10, 2, 400, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("один два три четыре пять шесть");
    for (const line of lines) expect(measure(line, 2, 400)).toBeLessThanOrEqual(10);
  });

  it("cuts a word wider than the line rather than letting it run off the page", () => {
    const word = "оченьдлинноеслово".repeat(4);
    const lines = wrapText(word, 10, 2, 400, measure);
    expect(lines.join("")).toBe(word);
    for (const line of lines) expect(measure(line, 2, 400)).toBeLessThanOrEqual(10);
  });

  it("keeps one line for empty text", () => {
    expect(wrapText("", 10, 2, 400, measure)).toEqual([""]);
  });
});

describe("report pages", () => {
  it("states the name, the verdict, the levels and the limits", () => {
    const report = buildPlanReport(plan, meta);
    const text = allText(layoutPlanReport(report, measure));
    expect(text).toContain("Квартира на Садовой");
    expect(text).toContain(report.verdict.title);
    expect(text).toContain("Предположение");
    expect(text).toContain("Границы этого отчёта");
    expect(text).toContain("Строительные нормы");
    expect(text).toMatch(/0[456]\.11\.(20)?26/);
  });

  it("prints the answers about the building, and leaves them out when no region is chosen", () => {
    const facts: FloorPlan["buildingFacts"] = { region: "moscow", gasified: true };
    const text = allText(layoutPlanReport(buildPlanReport({ ...plan, buildingFacts: facts }, meta), measure));
    expect(text).toContain("Ответы о доме");
    expect(text).toContain("В квартире есть газ");
    expect(text).toContain("Этажом ниже");
    expect(allText(layoutPlanReport(buildPlanReport(plan, meta), measure))).not.toContain("Ответы о доме");
  });

  it("carries a footer with the page number and the warning on every page", () => {
    const pages = layoutPlanReport(longReport(60), measure);
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((page, index) => {
      const content = texts(page.ops).map((op) => op.text);
      expect(content).toContain(`Стр. ${index + 1} из ${pages.length}`);
      expect(content.join(" ")).toContain("не заменяет проект и согласование");
    });
  });

  it("keeps everything inside the page margins, however long the report", () => {
    for (const count of [0, 1, 7, 60, 200]) {
      for (const page of layoutPlanReport(longReport(count), measure)) {
        for (const op of page.ops) {
          if (op.kind === "text") {
            const width = measure(op.text, op.size, op.weight);
            const left = op.align === "right" ? op.x - width : op.x;
            expect(left).toBeGreaterThanOrEqual(REPORT_PAGE.margin - 0.001);
            expect(left + width).toBeLessThanOrEqual(REPORT_PAGE.width - REPORT_PAGE.margin + 0.001);
            expect(op.y).toBeLessThanOrEqual(REPORT_PAGE.height - 2);
          } else {
            expect(op.x).toBeGreaterThanOrEqual(REPORT_PAGE.margin - 0.001);
            expect(op.x + op.width).toBeLessThanOrEqual(REPORT_PAGE.width - REPORT_PAGE.margin + 0.001);
            expect(op.y + op.height).toBeLessThanOrEqual(REPORT_PAGE.height);
          }
        }
      }
    }
  });

  it("loses nothing to pagination: every finding and room appears exactly once", () => {
    const pages = layoutPlanReport(longReport(60), measure);
    const all = pages.flatMap((page) => texts(page.ops).map((op) => op.text));
    for (let index = 1; index <= 60; index++) {
      expect(all.filter((text) => text === `Замечание номер ${index}`)).toHaveLength(1);
    }
    for (let index = 1; index <= 40; index++) {
      expect(all.filter((text) => text === `Помещение ${index}`)).toHaveLength(1);
    }
  });

  it("does not write body text over the footer", () => {
    for (const page of layoutPlanReport(longReport(120), measure)) {
      const footerTop = REPORT_PAGE.height - REPORT_PAGE.footer;
      for (const op of texts(page.ops)) {
        const isFooter = op.text.startsWith("Стр.") || op.text.startsWith("SpacePlan AI 0.29.0");
        if (!isFooter) expect(op.y).toBeLessThanOrEqual(footerTop);
      }
    }
  });

  it("wraps a very long plan name instead of running off the page", () => {
    const report = { ...buildPlanReport(plan, meta), planName: "Очень длинное название проекта ".repeat(5).trim() };
    const [page] = layoutPlanReport(report, measure);
    for (const op of texts(page.ops)) {
      expect(measure(op.text, op.size, op.weight)).toBeLessThanOrEqual(REPORT_PAGE.width - 2 * REPORT_PAGE.margin + 0.001);
    }
  });
});
