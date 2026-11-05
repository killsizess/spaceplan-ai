import { tr } from "@/lib/i18n";
import { analyzeDoorWallCollisions } from "@/domain/floor-plan/door-collisions";
import { analyzeDoorPairCollisions } from "@/domain/floor-plan/door-pair-collisions";
import { summarizePlanDiagnostics, type PlanDiagnosticKind } from "@/domain/floor-plan/plan-diagnostics";
import { diffPlans } from "@/domain/floor-plan/plan-diff";
import { planFromOrigin } from "@/domain/floor-plan/plan-origin";
import { evaluateRequirements, findRequirementConflicts } from "@/domain/floor-plan/plan-requirements";
import { findRoomAdjacency } from "@/domain/floor-plan/room-adjacency";
import { countsInTotal, type FloorPlan, type Opening, type RoomKind, type Wall } from "@/domain/floor-plan/types";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { analyzeWallIntersections } from "@/domain/floor-plan/wall-intersections";
import { bearingWallChanges, wallKindOf, type BearingChange } from "@/domain/floor-plan/wall-kind";
import { analyzeWallOverlaps } from "@/domain/floor-plan/wall-overlaps";
import { citation, rulesForPlan, RULE_STATUS_LABELS } from "@/domain/rules/engine";
import { factLines, type FactLine } from "@/domain/rules/facts";
import type { RuleReport } from "@/domain/rules/types";
import { formatArea, pluralRu } from "@/lib/format";
import { conflictText, describeRequirement, requirementDetail } from "../editor/requirement-text";
import { ROOM_KINDS } from "../editor/room-kinds";
import { detectViewRooms } from "../editor/view-rooms";

/**
 * The report on a plan: what the system can state about it, how sure it is of each
 * statement and where its knowledge ends. It only reads the plan and computes everything
 * from it; nothing is stored. Regional rules run only for the region the owner chose, and
 * every copy says which edition it was built on, or that no rules were checked.
 */
export type ReportLevel = "specialist" | "undetermined" | "assumption" | "verified";
/** `problem` is something to fix or decide; `ok` holds; `note` is for information. */
export type ReportState = "problem" | "ok" | "note";

export const REPORT_LEVEL_ORDER: readonly ReportLevel[] = ["specialist", "undetermined", "assumption", "verified"];

export const REPORT_LEVELS: Readonly<Record<ReportLevel, { label: string; meaning: string }>> = {
  specialist: { label: tr`Требует специалиста`, meaning: tr`Решение зависит от конструктива или нормативов вне базы.` },
  undetermined: { label: tr`Не определено`, meaning: tr`Данных недостаточно, вывода нет.` },
  assumption: { label: tr`Предположение`, meaning: tr`Вывод опирается на неподтверждённые данные.` },
  verified: { label: tr`Проверено правилом`, meaning: tr`Следует из геометрии и данных, подтверждённых пользователем.` },
};

export interface ReportFinding {
  level: ReportLevel;
  state: ReportState;
  title: string;
  detail?: string;
  /** The document and point behind the statement. */
  source?: string;
  /** Where that rule stands: a draft, confirmed by a specialist, the developer's own. */
  ruleStatus?: string;
}

export interface ReportRoom {
  name: string;
  kind: string;
  area: number;
}

export interface PlanReport {
  planName: string;
  generatedAt: string;
  appVersion: string;
  verdict: { level: ReportLevel | "clear"; title: string; text: string };
  counts: Readonly<Record<ReportLevel, number>>;
  problems: number;
  totals: {
    /** Null when rooms could not be computed: an unknown is not a zero. */
    area: number | null;
    rooms: number;
    walls: number;
    bearing: number;
    partition: number;
    unknownWalls: number;
    doors: number;
    windows: number;
  };
  rooms: ReportRoom[];
  findings: ReportFinding[];
  origin: { planName: string; createdAt: string; areaBefore: number | null; areaAfter: number | null } | null;
  /** The owner's answers about the building, which the rule findings were drawn from. */
  facts: FactLine[];
  limits: string[];
}

export const REPORT_DISCLAIMER =
  tr`Отчёт построен по геометрии плана и данным, которые ввёл пользователь. Он не заменяет проект перепланировки и её согласование и не является разрешением на работы. Решения о несущих конструкциях принимает специалист.`;
export const REPORT_RULES_NOTE =
  tr`Строительные нормы и правила региона в этой версии не проверяются: база правил ещё не подключена.`;

/** The limits of a report built on a rule base: which editions, and how far they can be trusted. */
function regulationLimits(rules: RuleReport): string[] {
  if (rules.kind === "owner") {
    return [
      tr`Нормы: правила заданы застройщиком своими словами. Приложение проверило план по ним, но не сверяло их с нормами страны или региона.`,
      ...(rules.notUnderstood.length ? [tr`Не понято и не проверяется: ${rules.notUnderstood.map((phrase) => `«${phrase}»`).join(", ")}.`] : []),
    ];
  }
  const version = rules.version.split("-").reverse().join(".");
  return [
    tr`Нормы: ${rules.region}, база правил от ${version}. ${rules.reviewed ? tr`База сверена со специалистом.` : tr`База не сверена со специалистом, поэтому выводы по ней остаются предположениями.`}`,
    ...rules.documents.map((item) => `${item.short}: ${item.edition}. ${item.gaps}`),
    tr`База не проверяет: ${rules.notChecked.join(" ")}`,
  ];
}

const WET_ROOMS: readonly RoomKind[] = ["kitchen", "bathroom"];
const AREA_TOLERANCE = 0.01;

const BEARING_TEXT: Record<BearingChange, string> = {
  deleted: tr`удалена`,
  moved: tr`перенесена или изменена её длина`,
  thickness: tr`изменена толщина`,
  unmarked: tr`снята отметка «несущая»`,
};

const GEOMETRY_TEXT: Record<PlanDiagnosticKind, { title: string; detail: string }> = {
  connections: { title: tr`Свободные концы стен`, detail: tr`Контур может быть незамкнут. Соедините концы во вкладке «Стены».` },
  intersections: { title: tr`Стены пересекаются без общего узла`, detail: tr`Помещения считаются по замкнутым контурам, такое пересечение стоит разрешить.` },
  overlaps: { title: tr`Стены накладываются на одной оси`, detail: tr`Одна стена может закрывать проёмы другой.` },
  "door-wall": { title: tr`Дверь задевает стену при открывании`, detail: tr`Полотно на всём размахе 0–90° проходит через стену.` },
  "door-pair": { title: tr`Зоны открывания двух дверей пересекаются`, detail: tr`Двери могут столкнуться при одновременном открывании.` },
};

const sameGeometry = (a: Wall, b: Wall) =>
  a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y &&
  a.thickness === b.thickness && a.height === b.height;

/** What differs from the plan this variant was made from, by what the user marked. */
function changeFindings(plan: FloorPlan, findings: ReportFinding[], rules: RuleReport | null): PlanReport["origin"] {
  if (!plan.origin) return null;
  const source = planFromOrigin(plan.origin);
  const diff = diffPlans(source, plan);
  const area = (computed: boolean, value: number) => (computed ? value : null);
  const summary = {
    planName: plan.origin.planName,
    createdAt: plan.origin.createdAt,
    areaBefore: area(diff.before.roomsComputed, diff.before.totalArea),
    areaAfter: area(diff.after.roomsComputed, diff.after.totalArea),
  };
  if (diff.identical) {
    findings.push({ level: "verified", state: "ok", title: tr`Вариант совпадает с исходным планом` });
  }
  // A rule base says the same about these changes, and names the document behind it.
  if (rules) return summary;
  const before = new Map(source.walls.map((wall) => [wall.id, wall]));
  const after = new Map(plan.walls.map((wall) => [wall.id, wall]));

  for (const change of bearingWallChanges(source, plan)) {
    findings.push({
      level: "specialist",
      state: "problem",
      title: tr`Затронута несущая стена: стена ${change.number} исходного плана ${BEARING_TEXT[change.change]}`,
      detail: tr`Изменение несущих конструкций может решать только специалист по проекту.`,
    });
  }
  const changedWalls = [...diff.walls.changed, ...diff.walls.removed].filter((id) => {
    const previous = before.get(id)!, current = after.get(id);
    return !current || !sameGeometry(previous, current);
  });
  const unknown = changedWalls.filter((id) => wallKindOf(before.get(id)!) === "unknown");
  const partitions = changedWalls.filter((id) => wallKindOf(before.get(id)!) === "partition");
  if (unknown.length) {
    findings.push({
      level: "assumption",
      state: "problem",
      title: tr`Изменено стен без указанного типа: ${unknown.length}`,
      detail: tr`Пока тип не указан, вывод о допустимости этих изменений не делается: стена может оказаться несущей.`,
    });
  }
  if (partitions.length) {
    findings.push({
      level: "assumption",
      state: "note",
      title: tr`Изменено перегородок: ${partitions.length}`,
      detail: tr`По отметке пользователя конструктив не затронут. Требования к перепланировке не проверялись.`,
    });
  }
  if (diff.walls.added.length) {
    findings.push({ level: "assumption", state: "note", title: tr`Добавлено стен: ${diff.walls.added.length}` });
  }

  const hostKind = (opening: Opening | undefined, walls: ReadonlyMap<string, Wall>) => {
    const wall = opening && walls.get(opening.wallId);
    return wall ? wallKindOf(wall) : "unknown";
  };
  const openingsBefore = new Map(source.openings.map((item) => [item.id, item]));
  const openingsAfter = new Map(plan.openings.map((item) => [item.id, item]));
  const openingHosts = [
    ...diff.openings.added.map((id) => hostKind(openingsAfter.get(id), after)),
    ...diff.movedOpenings.map((id) => hostKind(openingsAfter.get(id), after)),
    ...diff.openings.removed.map((id) => hostKind(openingsBefore.get(id), before)),
  ];
  const inBearing = openingHosts.filter((kind) => kind === "bearing").length;
  const inUnknown = openingHosts.filter((kind) => kind === "unknown").length;
  const inPartition = openingHosts.filter((kind) => kind === "partition").length;
  if (inBearing) {
    findings.push({
      level: "specialist",
      state: "problem",
      title: tr`Изменён проём в несущей стене: ${inBearing}`,
      detail: tr`Устройство или перенос проёма в несущей стене требует расчёта и проекта.`,
    });
  }
  if (inUnknown) {
    findings.push({
      level: "assumption",
      state: "problem",
      title: tr`Изменён проём в стене без указанного типа: ${inUnknown}`,
      detail: tr`Пока тип стены не указан, вывод о допустимости не делается.`,
    });
  }
  if (inPartition) {
    findings.push({ level: "assumption", state: "note", title: tr`Изменён проём в перегородке: ${inPartition}` });
  }

  for (const kind of WET_ROOMS) {
    const was = diff.before.areaByKind[kind], now = diff.after.areaByKind[kind];
    if (diff.before.roomsComputed && diff.after.roomsComputed && Math.abs(was - now) > AREA_TOLERANCE) {
      findings.push({
        level: "specialist",
        state: "problem",
        title: tr`Затронута мокрая зона: ${ROOM_KINDS[kind].label.toLowerCase()}, ${formatArea(was)} → ${formatArea(now)}`,
        detail: tr`Перенос и расширение мокрых зон зависят от нормативов и инженерных систем вне этой проверки.`,
      });
    }
  }
  return summary;
}

export function buildPlanReport(plan: FloorPlan, meta: { generatedAt: string; appVersion: string }): PlanReport {
  const findings: ReportFinding[] = [];
  const wallName = (id: string) => {
    const index = plan.walls.findIndex((wall) => wall.id === id);
    return index >= 0 ? tr`Стена ${index + 1}` : tr`Удалённая стена`;
  };

  // Rooms and areas.
  const wallMode = plan.roomMode === "walls";
  const detection = detectViewRooms(plan);
  const rooms: ReportRoom[] = wallMode
    ? detection.rooms.map((room) => ({ name: room.name, kind: ROOM_KINDS[room.kind].label, area: room.area }))
    : plan.rooms.map((room) => ({ name: room.name, kind: ROOM_KINDS[room.kind].label, area: room.width * room.height }));
  const counted = wallMode
    ? detection.rooms.filter((room) => countsInTotal(room.kind)).map((room) => room.area)
    : plan.rooms.filter((room) => countsInTotal(room.kind)).map((room) => room.width * room.height);
  const area = detection.unresolved ? null : counted.reduce((sum, value) => sum + value, 0);
  if (detection.unresolved) {
    findings.push({ level: "undetermined", state: "problem", title: tr`Помещения по стенам не определены`, detail: detection.unresolved });
  } else if (!rooms.length) {
    findings.push(wallMode
      ? { level: "undetermined", state: "problem", title: tr`План не образует замкнутый контур`, detail: tr`Без замкнутых помещений площади и требования к комнатам не считаются.` }
      : { level: "undetermined", state: "problem", title: tr`В плане нет помещений` });
  } else if (wallMode) {
    findings.push({
      level: "verified",
      state: "ok",
      title: tr`Площадь посчитана по стенам: ${pluralRu(rooms.length, tr`помещение`, tr`помещения`, tr`помещений`)}, ${formatArea(area ?? 0)}`,
      detail: tr`Внутри стен, с учётом их толщины.`,
    });
    for (const warning of detection.warnings) findings.push({ level: "assumption", state: "note", title: warning });
  } else {
    findings.push({
      level: "assumption",
      state: "note",
      title: tr`Помещения заданы вручную: ${formatArea(area ?? 0)}`,
      detail: tr`Площадь считается по прямоугольникам, которые ввёл пользователь, а не по стенам.`,
    });
  }
  if (plan.underlay && !plan.underlay.calibrated) {
    findings.push({
      level: "assumption",
      state: "problem",
      title: tr`Масштаб подложки не подтверждён`,
      detail: tr`Размеры, снятые с такой подложки, могут не совпадать с чертежом. Задайте масштаб по двум точкам.`,
    });
  }

  // Wall types.
  const bearing = plan.walls.filter((wall) => wallKindOf(wall) === "bearing").length;
  const partition = plan.walls.filter((wall) => wallKindOf(wall) === "partition").length;
  const unknownWalls = plan.walls.length - bearing - partition;
  if (unknownWalls) {
    findings.push({
      level: "assumption",
      state: "problem",
      title: tr`Тип не указан у стен: ${unknownWalls} из ${plan.walls.length}`,
      detail: tr`Вывод о допустимости изменений этих стен не делается. Укажите тип по документам или у специалиста; приложение его не определяет.`,
    });
  } else if (plan.walls.length) {
    findings.push({
      level: "verified",
      state: "ok",
      title: tr`Тип указан у всех стен: несущих ${bearing}, перегородок ${partition}`,
      detail: tr`Тип отмечен пользователем.`,
    });
  }

  // Requirements.
  const adjacency = wallMode && !detection.unresolved ? findRoomAdjacency(detection.rooms, plan.walls, plan.openings) : null;
  const results = evaluateRequirements(plan, detection.rooms, adjacency);
  const roomName = (id: string) => detection.rooms.find((room) => room.id === id)?.name ?? tr`Помещение`;
  const labelName = (id: string) => plan.wallRoomLabels.find((label) => label.id === id)?.name;
  plan.requirements.forEach((requirement, index) => {
    const result = results[index];
    const title = describeRequirement(requirement, wallName, labelName);
    const detail = requirementDetail(requirement, result, roomName, wallName);
    if (result.status === "met") findings.push({ level: "verified", state: "ok", title: tr`Выполнено: ${title}`, detail });
    else if (result.status === "violated") findings.push({ level: "verified", state: "problem", title: tr`Нарушено: ${title}`, detail });
    else findings.push({ level: "undetermined", state: "note", title: tr`Не проверено: ${title}`, detail });
  });
  for (const conflict of findRequirementConflicts(plan.requirements)) {
    findings.push({ level: conflict.certain ? "verified" : "assumption", state: "problem", title: tr`Требования противоречат друг другу`, detail: conflictText(conflict) });
  }

  // Geometry.
  if (plan.walls.length) {
    const diagnostics = summarizePlanDiagnostics({
      // A wall end resting on the middle of another wall is joined: rooms close through it.
      connections: analyzeWallConnections(plan.walls).filter((item) => item.kind !== "junction"),
      intersections: analyzeWallIntersections(plan.walls),
      overlaps: analyzeWallOverlaps(plan.walls),
      doorWalls: analyzeDoorWallCollisions(plan.walls, plan.openings),
      doorPairs: analyzeDoorPairCollisions(plan.walls, plan.openings),
    });
    const kinds = Object.keys(GEOMETRY_TEXT) as PlanDiagnosticKind[];
    for (const kind of kinds) {
      const count = diagnostics.counts[kind];
      if (!count) continue;
      const more = diagnostics.truncated[kind] ? tr` (показана часть)` : "";
      findings.push({ level: "verified", state: "problem", title: `${GEOMETRY_TEXT[kind].title}: ${count}${more}`, detail: GEOMETRY_TEXT[kind].detail });
    }
    if (!diagnostics.total) {
      findings.push({ level: "verified", state: "ok", title: tr`Геометрия без замечаний`, detail: tr`Концы стен соединены, стены не пересекаются и не накладываются, двери открываются свободно.` });
    }
  }

  // Changes against the source of a variant.
  const rules = rulesForPlan(plan);
  const origin = changeFindings(plan, findings, rules);
  if (rules) {
    for (const finding of rules.findings) {
      const source = citation(rules, finding);
      findings.push({
        level: finding.level,
        state: finding.state,
        title: finding.title,
        ...(finding.detail ? { detail: finding.detail } : {}),
        ...(source ? { source } : {}),
        ...(finding.status ? { ruleStatus: RULE_STATUS_LABELS[finding.status] } : {}),
      });
    }
  }

  const order = (finding: ReportFinding) => REPORT_LEVEL_ORDER.indexOf(finding.level) * 3 + ["problem", "note", "ok"].indexOf(finding.state);
  const sorted = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => order(a.finding) - order(b.finding) || a.index - b.index)
    .map(({ finding }) => finding);
  const counts = Object.fromEntries(
    REPORT_LEVEL_ORDER.map((level) => [level, sorted.filter((finding) => finding.level === level).length]),
  ) as Record<ReportLevel, number>;
  const problems = sorted.filter((finding) => finding.state === "problem").length;

  return {
    planName: plan.name,
    generatedAt: meta.generatedAt,
    appVersion: meta.appVersion,
    verdict: verdictOf(counts, problems),
    counts,
    problems,
    totals: {
      area,
      rooms: rooms.length,
      walls: plan.walls.length,
      bearing,
      partition,
      unknownWalls,
      doors: plan.openings.filter((item) => item.kind === "door").length,
      windows: plan.openings.filter((item) => item.kind === "window").length,
    },
    rooms,
    findings: sorted,
    origin,
    facts: factLines(plan.buildingFacts),
    limits: rules ? [...regulationLimits(rules), REPORT_DISCLAIMER] : [REPORT_RULES_NOTE, REPORT_DISCLAIMER],
  };
}

function verdictOf(counts: Readonly<Record<ReportLevel, number>>, problems: number): PlanReport["verdict"] {
  if (counts.specialist) {
    return { level: "specialist", title: tr`Нужен специалист`, text: tr`Есть изменения, допустимость которых нельзя определить без специалиста: они перечислены первыми.` };
  }
  if (counts.undetermined && problems) {
    return { level: "undetermined", title: tr`Данных недостаточно`, text: tr`По части вопросов вывода нет: без замкнутых помещений или нужных данных проверка не работает.` };
  }
  if (problems) {
    return { level: "assumption", title: tr`Есть что проверить`, text: tr`Найдены замечания и неподтверждённые данные. Они не означают запрет, но до их разбора вывод о плане неполный.` };
  }
  if (counts.assumption || counts.undetermined) {
    return { level: "assumption", title: tr`Замечаний нет, но есть предположения`, text: tr`Нарушений не найдено. Часть выводов опирается на данные, которые никто не подтвердил.` };
  }
  return { level: "clear", title: tr`Замечаний нет`, text: tr`По геометрии плана и заданным требованиям нарушений нет. Нормы региона этот отчёт не проверяет.` };
}
