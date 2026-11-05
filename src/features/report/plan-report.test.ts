import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import type { FloorPlan, Opening, Wall } from "@/domain/floor-plan/types";
import { APP_VERSION } from "@/lib/app-version";
import { apartment, variantOf } from "@/domain/rules/rules.fixtures";
import { buildPlanReport, REPORT_DISCLAIMER, REPORT_RULES_NOTE, type PlanReport, type ReportFinding } from "./plan-report";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, kind?: Wall["kind"]): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7, ...(kind ? { kind } : {}),
});

function room(kinds: { top?: Wall["kind"]; right?: Wall["kind"]; bottom?: Wall["kind"]; left?: Wall["kind"] } = {}): FloorPlan {
  return {
    ...createEmptyPlan("report"),
    name: "Квартира",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 5, 0, kinds.top),
      wall("right", 5, 0, 5, 4, kinds.right),
      wall("bottom", 5, 4, 0, 4, kinds.bottom),
      wall("left", 0, 4, 0, 0, kinds.left),
    ],
  };
}
const allTyped = () => room({ top: "bearing", right: "partition", bottom: "bearing", left: "partition" });

const meta = { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" };
const build = (plan: FloorPlan) => buildPlanReport(plan, meta);
const find = (report: PlanReport, text: RegExp): ReportFinding | undefined => report.findings.find((item) => text.test(item.title));

describe("plan report", () => {
  it("always states its limits, including that regional rules are not checked", () => {
    const report = build(allTyped());
    expect(report.limits).toEqual([REPORT_RULES_NOTE, REPORT_DISCLAIMER]);
    expect(REPORT_DISCLAIMER).toMatch(/не заменяет проект/);
    expect(REPORT_RULES_NOTE).toMatch(/не проверяются/);
  });

  it("gives a clear verdict only for a closed plan with every wall typed, and still names what it did not check", () => {
    const report = build(allTyped());
    expect(report.verdict.level).toBe("clear");
    expect(report.verdict.text).toMatch(/Нормы региона этот отчёт не проверяет/);
    expect(report.problems).toBe(0);
    expect(report.totals).toMatchObject({ rooms: 1, walls: 4, bearing: 2, partition: 2, unknownWalls: 0 });
    expect(report.totals.area).toBeCloseTo(4.8 * 3.8, 6);
    expect(report.rooms[0]).toMatchObject({ kind: "Комната" });
    expect(find(report, /Площадь посчитана/)).toMatchObject({ level: "verified", state: "ok" });
    expect(find(report, /Тип указан у всех стен: несущих 2, перегородок 2/)?.level).toBe("verified");
    expect(find(report, /Геометрия без замечаний/)?.level).toBe("verified");
  });

  it("treats an unknown wall type as an assumption and blocks a clear verdict", () => {
    const report = build(room({ top: "bearing" }));
    const finding = find(report, /Тип не указан у стен: 3 из 4/)!;
    expect(finding).toMatchObject({ level: "assumption", state: "problem" });
    expect(finding.detail).toMatch(/вывод о допустимости изменений этих стен не делается/i);
    expect(report.verdict.level).toBe("assumption");
  });

  it("says an open contour is undetermined: an unknown area is not a zero", () => {
    const open = { ...room(), walls: room().walls.slice(0, 3) };
    const report = build(open);
    expect(find(report, /не образует замкнутый контур/)?.level).toBe("undetermined");
    expect(report.verdict.level).toBe("undetermined");
    expect(find(report, /Свободные концы стен/)).toMatchObject({ level: "verified", state: "problem" });
  });

  it("does not call a T-junction a free end: rooms close through it", () => {
    const plan = { ...allTyped(), walls: [...allTyped().walls, wall("inner", 2, 0, 2, 4, "partition")] };
    const report = build(plan);
    expect(find(report, /Свободные концы/)).toBeUndefined();
    expect(report.totals.rooms).toBe(2);
    expect(report.verdict.level).toBe("clear");
  });

  it("reports rooms that cannot be computed, with the reason and no area", () => {
    const walls: Wall[] = [];
    for (let line = 0; line <= 11; line++) {
      walls.push(wall(`h${line}`, 0, line * 2, 22, line * 2), wall(`v${line}`, line * 2, 0, line * 2, 22));
    }
    const report = build({ ...createEmptyPlan("grid"), roomMode: "walls", walls });
    expect(report.totals.area).toBeNull();
    expect(find(report, /Помещения по стенам не определены/)?.detail).toMatch(/больше 100 помещений/);
    expect(report.verdict.level).toBe("undetermined");
  });

  it("calls manual rooms what they are, and notes an empty plan and an uncalibrated underlay", () => {
    const manual: FloorPlan = {
      ...createEmptyPlan("manual"),
      rooms: [{ id: "r", name: "Зал", kind: "living", color: "#e8e5dd", x: 0, y: 0, width: 5, height: 4 }],
    };
    const report = build(manual);
    expect(find(report, /заданы вручную/)?.level).toBe("assumption");
    expect(report.totals.area).toBe(20);
    expect(report.rooms).toEqual([{ name: "Зал", kind: "Гостиная", area: 20 }]);
    expect(find(build(createEmptyPlan("empty")), /В плане нет помещений/)?.level).toBe("undetermined");
    const underlay = {
      name: "p.png", dataUrl: "data:image/png;base64,AAAA", pixelWidth: 10, pixelHeight: 10,
      x: 0, y: 0, metersPerPixel: 1, opacity: 1, visible: true, calibrated: false,
    };
    expect(find(build({ ...allTyped(), underlay }), /Масштаб подложки не подтверждён/)?.level).toBe("assumption");
    expect(find(build({ ...allTyped(), underlay: { ...underlay, calibrated: true } }), /Масштаб/)).toBeUndefined();
  });

  it("reports requirements with their results, and rooms-only ones as not checked in manual mode", () => {
    const requirements: FloorPlan["requirements"] = [
      { id: "a", type: "room-min-area", kind: "other", minArea: 10 },
      { id: "b", type: "room-max-area", kind: "other", maxArea: 5 },
      { id: "c", type: "room-min-area", kind: "kitchen", minArea: 5 },
      { id: "d", type: "wall-fixed", wallId: "top", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2 },
    ];
    const report = build({ ...allTyped(), requirements });
    expect(find(report, /^Выполнено: Комната: площадь не меньше/)).toMatchObject({ level: "verified", state: "ok" });
    expect(find(report, /^Нарушено: Комната: площадь не больше/)).toMatchObject({ level: "verified", state: "problem" });
    expect(find(report, /^Не проверено: Кухня/)?.level).toBe("undetermined");
    expect(find(report, /^Выполнено: Стена 1 не меняется/)?.detail).toMatch(/совпадают/);
    expect(find(build({ ...allTyped(), roomMode: "manual", requirements }), /^Не проверено: Комната/)?.detail).toMatch(/По стенам/);
  });

  it("reports contradictions between requirements", () => {
    const requirements: FloorPlan["requirements"] = [
      { id: "a", type: "room-min-area", kind: "other", minArea: 30 },
      { id: "b", type: "room-max-area", kind: "other", maxArea: 10 },
    ];
    const finding = find(build({ ...allTyped(), requirements }), /противоречат/)!;
    expect(finding).toMatchObject({ level: "verified", state: "problem" });
    expect(finding.detail).toMatch(/минимальная площадь больше максимальной/);
  });

  it("lists the most serious findings first and counts each level", () => {
    const source = room({ top: "bearing" });
    const variant: FloorPlan = {
      ...source,
      id: "variant",
      walls: source.walls.map((item) => (item.id === "top" ? { ...item, thickness: 0.3 } : item)),
      origin: createPlanOrigin(source, meta.generatedAt),
    };
    const report = build(variant);
    expect(report.findings[0].level).toBe("specialist");
    const levels = report.findings.map((item) => item.level);
    const rank = { specialist: 0, undetermined: 1, assumption: 2, verified: 3 };
    expect([...levels].sort((a, b) => rank[a] - rank[b])).toEqual(levels);
    expect(report.counts.specialist).toBe(1);
    expect(report.findings.filter((item) => item.state === "problem").length).toBe(report.problems);
  });

  it("does not change the plan, and is the same for the same plan", () => {
    const plan = allTyped();
    const before = JSON.stringify(plan);
    expect(build(plan)).toEqual(build(plan));
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe("a variant compared with its source", () => {
  function variantOf(source: FloorPlan, edit: (plan: FloorPlan) => FloorPlan) {
    return { ...edit(source), id: "variant", origin: createPlanOrigin(source, meta.generatedAt) };
  }
  const moved = (id: string) => (plan: FloorPlan): FloorPlan => ({
    ...plan,
    walls: plan.walls.map((item) => (item.id === id ? { ...item, height: item.height, thickness: 0.3 } : item)),
  });

  it("says it matches its source when nothing changed", () => {
    const source = allTyped();
    const report = build(variantOf(source, (plan) => plan));
    expect(find(report, /совпадает с исходным планом/)?.level).toBe("verified");
    expect(report.origin).toMatchObject({ planName: "Квартира" });
    expect(report.origin!.areaBefore).toBeCloseTo(report.origin!.areaAfter!, 9);
  });

  it("sends a change to a bearing wall to a specialist", () => {
    const report = build(variantOf(allTyped(), moved("top")));
    const finding = find(report, /Затронута несущая стена/)!;
    expect(finding).toMatchObject({ level: "specialist", state: "problem" });
    expect(finding.title).toMatch(/стена 1 исходного плана изменена толщина/);
    expect(report.verdict.level).toBe("specialist");
  });

  it("does not call a change to an unknown wall acceptable", () => {
    const report = build(variantOf(room(), moved("top")));
    const finding = find(report, /Изменено стен без указанного типа: 1/)!;
    expect(finding).toMatchObject({ level: "assumption", state: "problem" });
    expect(finding.detail).toMatch(/вывод о допустимости/);
    expect(report.findings.some((item) => /допустимо\b/i.test(item.title))).toBe(false);
  });

  it("calls a change to a partition an assumption, and still does not approve it", () => {
    const report = build(variantOf(allTyped(), moved("right")));
    const finding = find(report, /Изменено перегородок: 1/)!;
    expect(finding).toMatchObject({ level: "assumption", state: "note" });
    expect(finding.detail).toMatch(/Требования к перепланировке не проверялись/);
    expect(report.counts.specialist).toBe(0);
  });

  it("does not count a change of type alone as a change of the wall's geometry", () => {
    const source = room();
    const report = build(variantOf(source, (plan) => ({ ...plan, walls: plan.walls.map((item) => (item.id === "top" ? { ...item, kind: "partition" as const } : item)) })));
    expect(find(report, /Изменено стен без указанного типа/)).toBeUndefined();
  });

  it.each([
    ["bearing", "specialist", /Изменён проём в несущей стене: 1/],
    [undefined, "assumption", /Изменён проём в стене без указанного типа: 1/],
    ["partition", "assumption", /Изменён проём в перегородке: 1/],
  ] as const)("judges a new opening by its wall's type (%s)", (kind, level, title) => {
    const source = room({ top: kind });
    const door: Opening = { id: "door", wallId: "top", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0 };
    const report = build(variantOf(source, (plan) => ({ ...plan, openings: [door] })));
    expect(find(report, title)?.level).toBe(level);
  });

  it("sends a change to the area of a wet room to a specialist", () => {
    const source: FloorPlan = {
      ...createEmptyPlan("wet"),
      name: "С ванной",
      rooms: [{ id: "bath", name: "Ванная", kind: "bathroom", color: "#dce8ed", x: 0, y: 0, width: 2, height: 2 }],
    };
    const report = build(variantOf(source, (plan) => ({
      ...plan,
      rooms: plan.rooms.map((item) => ({ ...item, width: 3 })),
    })));
    const finding = find(report, /Затронута мокрая зона: ванная, 4 м² → 6 м²/)!;
    expect(finding.level).toBe("specialist");
    expect(find(build(variantOf(source, (plan) => plan)), /мокрая зона/)).toBeUndefined();
  });
});

describe("app version", () => {
  it("matches package.json", () => {
    expect(APP_VERSION).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });
});

describe("a report on a plan with a chosen region", () => {
  const moscow = () => apartment();

  it("says which edition it was built on and that no specialist confirmed it", () => {
    const report = buildPlanReport(moscow(), { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" });
    expect(report.limits).not.toContain(REPORT_RULES_NOTE);
    expect(report.limits[0]).toBe("Нормы: Москва, база правил от 05.11.2026. База не сверена со специалистом, поэтому выводы по ней остаются предположениями.");
    expect(report.limits.some((limit) => limit.startsWith("508-ПП:") && limit.includes("№ 841-ПП от 18.04.2025"))).toBe(true);
    expect(report.limits.some((limit) => limit.startsWith("СП 54:") && limit.includes("27.12.2024"))).toBe(true);
    expect(report.limits.some((limit) => limit.startsWith("База не проверяет:"))).toBe(true);
    expect(report.limits.at(-1)).toBe(REPORT_DISCLAIMER);
  });

  it("carries the rule findings with the document behind them", () => {
    const report = buildPlanReport(moscow(), { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" });
    const daylight = report.findings.find((finding) => finding.title.startsWith("Окно наружу есть"))!;
    expect(daylight.source).toBe("ПП РФ № 47, п. 25");
    expect(daylight.level).toBe("assumption");
  });

  it("replaces uncited change notes with cited ones, without saying the same thing twice", () => {
    const variant = variantOf(moscow(), (plan) => ({
      ...plan,
      walls: plan.walls.filter((wall) => wall.id !== "top"),
      openings: plan.openings.filter((opening) => opening.wallId !== "top"),
    }));
    const report = buildPlanReport(variant, { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" });
    const bearing = report.findings.filter((finding) => finding.title.startsWith("Затронута несущая стена"));
    expect(bearing).toHaveLength(1);
    expect(bearing[0].source).toBe("508-ПП, прил. 1, пп. 9.3, 9.6");
    expect(report.verdict.level).toBe("specialist");
    expect(report.origin?.planName).toBe("Квартира");
  });

  it("forbidden work makes the verdict «specialist», never a clearance", () => {
    const variant = variantOf(apartment({ region: "moscow", gasified: true }), (plan) => ({
      ...plan,
      walls: plan.walls.filter((wall) => wall.id !== "living-kitchen"),
    }));
    const report = buildPlanReport(variant, { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" });
    const finding = report.findings.find((item) => item.title.startsWith("Газифицированная кухня"))!;
    expect(finding.level).toBe("specialist");
    expect(finding.state).toBe("problem");
    expect(report.verdict.level).toBe("specialist");
  });

  it("checks no rules for another region and says so", () => {
    const report = buildPlanReport(apartment({ region: "other" }), { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" });
    expect(report.limits[0]).toBe(REPORT_RULES_NOTE);
    expect(report.findings.some((finding) => finding.source)).toBe(false);
  });
});

describe("the answers a report was built on", () => {
  const meta = { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" };

  it("lists them, with an unanswered one as not known", () => {
    const { facts } = buildPlanReport(apartment({ region: "moscow", gasified: true }), meta);
    expect(facts).toContainEqual({ label: "В квартире есть газ", answer: "Да" });
    expect(facts).toContainEqual({ label: "Этажом ниже", answer: "Не знаю" });
  });

  it("has none without a region", () => {
    expect(buildPlanReport(apartment({}), meta).facts).toEqual([]);
  });
});
