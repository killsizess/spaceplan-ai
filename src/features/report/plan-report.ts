import { analyzeDoorWallCollisions } from "@/domain/floor-plan/door-collisions";
import { analyzeDoorPairCollisions } from "@/domain/floor-plan/door-pair-collisions";
import { summarizePlanDiagnostics, type PlanDiagnosticKind } from "@/domain/floor-plan/plan-diagnostics";
import { diffPlans } from "@/domain/floor-plan/plan-diff";
import { planFromOrigin } from "@/domain/floor-plan/plan-origin";
import { evaluateRequirements, findRequirementConflicts } from "@/domain/floor-plan/plan-requirements";
import { findRoomAdjacency } from "@/domain/floor-plan/room-adjacency";
import type { FloorPlan, Opening, RoomKind, Wall } from "@/domain/floor-plan/types";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { analyzeWallIntersections } from "@/domain/floor-plan/wall-intersections";
import { bearingWallChanges, wallKindOf, type BearingChange } from "@/domain/floor-plan/wall-kind";
import { analyzeWallOverlaps } from "@/domain/floor-plan/wall-overlaps";
import { formatArea } from "@/lib/format";
import { conflictText, describeRequirement, requirementDetail } from "../editor/requirement-text";
import { ROOM_KINDS } from "../editor/room-kinds";
import { detectViewRooms } from "../editor/view-rooms";

/**
 * The report on a plan: what the system can state about it, how sure it is of each
 * statement and where its knowledge ends. It only reads the plan and computes everything
 * from it; nothing is stored. It has no regional rules yet and says so on every copy.
 */
export type ReportLevel = "specialist" | "undetermined" | "assumption" | "verified";
/** `problem` is something to fix or decide; `ok` holds; `note` is for information. */
export type ReportState = "problem" | "ok" | "note";

export const REPORT_LEVEL_ORDER: readonly ReportLevel[] = ["specialist", "undetermined", "assumption", "verified"];

export const REPORT_LEVELS: Readonly<Record<ReportLevel, { label: string; meaning: string }>> = {
  specialist: { label: "Требует специалиста", meaning: "Решение зависит от конструктива или нормативов вне базы." },
  undetermined: { label: "Не определено", meaning: "Данных недостаточно, вывода нет." },
  assumption: { label: "Предположение", meaning: "Вывод опирается на неподтверждённые данные." },
  verified: { label: "Проверено правилом", meaning: "Следует из геометрии и данных, подтверждённых пользователем." },
};

export interface ReportFinding {
  level: ReportLevel;
  state: ReportState;
  title: string;
  detail?: string;
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
  limits: string[];
}

export const REPORT_DISCLAIMER =
  "Отчёт построен по геометрии плана и данным, которые ввёл пользователь. Он не заменяет проект перепланировки и её согласование и не является разрешением на работы. Решения о несущих конструкциях принимает специалист.";
export const REPORT_RULES_NOTE =
  "Строительные нормы и правила региона в этой версии не проверяются: база правил ещё не подключена.";

const WET_ROOMS: readonly RoomKind[] = ["kitchen", "bathroom"];
const AREA_TOLERANCE = 0.01;

const BEARING_TEXT: Record<BearingChange, string> = {
  deleted: "удалена",
  moved: "перенесена или изменена её длина",
  thickness: "изменена толщина",
  unmarked: "снята отметка «несущая»",
};

const GEOMETRY_TEXT: Record<PlanDiagnosticKind, { title: string; detail: string }> = {
  connections: { title: "Свободные концы стен", detail: "Контур может быть незамкнут. Соедините концы во вкладке «Стены»." },
  intersections: { title: "Стены пересекаются без общего узла", detail: "Помещения считаются по замкнутым контурам, такое пересечение стоит разрешить." },
  overlaps: { title: "Стены накладываются на одной оси", detail: "Одна стена может закрывать проёмы другой." },
  "door-wall": { title: "Дверь задевает стену при открывании", detail: "Полотно на всём размахе 0–90° проходит через стену." },
  "door-pair": { title: "Зоны открывания двух дверей пересекаются", detail: "Двери могут столкнуться при одновременном открывании." },
};

const sameGeometry = (a: Wall, b: Wall) =>
  a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y &&
  a.thickness === b.thickness && a.height === b.height;

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100, units = count % 10;
  const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
  return `${count} ${word}`;
}

/** What differs from the plan this variant was made from, by what the user marked. */
function changeFindings(plan: FloorPlan, findings: ReportFinding[]): PlanReport["origin"] {
  if (!plan.origin) return null;
  const source = planFromOrigin(plan.origin);
  const diff = diffPlans(source, plan);
  const before = new Map(source.walls.map((wall) => [wall.id, wall]));
  const after = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const numberOf = (id: string) => plan.walls.findIndex((wall) => wall.id === id) + 1;

  for (const change of bearingWallChanges(source, plan)) {
    findings.push({
      level: "specialist",
      state: "problem",
      title: `Затронута несущая стена: стена ${change.number} исходного плана ${BEARING_TEXT[change.change]}`,
      detail: "Изменение несущих конструкций может решать только специалист по проекту.",
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
      title: `Изменено стен без указанного типа: ${unknown.length}`,
      detail: "Пока тип не указан, вывод о допустимости этих изменений не делается: стена может оказаться несущей.",
    });
  }
  if (partitions.length) {
    findings.push({
      level: "assumption",
      state: "note",
      title: `Изменено перегородок: ${partitions.length}`,
      detail: "По отметке пользователя конструктив не затронут. Требования к перепланировке не проверялись.",
    });
  }
  if (diff.walls.added.length) {
    findings.push({ level: "assumption", state: "note", title: `Добавлено стен: ${diff.walls.added.length}` });
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
      title: `Изменён проём в несущей стене: ${inBearing}`,
      detail: "Устройство или перенос проёма в несущей стене требует расчёта и проекта.",
    });
  }
  if (inUnknown) {
    findings.push({
      level: "assumption",
      state: "problem",
      title: `Изменён проём в стене без указанного типа: ${inUnknown}`,
      detail: "Пока тип стены не указан, вывод о допустимости не делается.",
    });
  }
  if (inPartition) {
    findings.push({ level: "assumption", state: "note", title: `Изменён проём в перегородке: ${inPartition}` });
  }

  for (const kind of WET_ROOMS) {
    const was = diff.before.areaByKind[kind], now = diff.after.areaByKind[kind];
    if (diff.before.roomsComputed && diff.after.roomsComputed && Math.abs(was - now) > AREA_TOLERANCE) {
      findings.push({
        level: "specialist",
        state: "problem",
        title: `Затронута мокрая зона: ${ROOM_KINDS[kind].label.toLowerCase()}, ${formatArea(was)} → ${formatArea(now)}`,
        detail: "Перенос и расширение мокрых зон зависят от нормативов и инженерных систем вне этой проверки.",
      });
    }
  }
  if (diff.identical) {
    findings.push({ level: "verified", state: "ok", title: "Вариант совпадает с исходным планом" });
  }
  const area = (computed: boolean, value: number) => (computed ? value : null);
  return {
    planName: plan.origin.planName,
    createdAt: plan.origin.createdAt,
    areaBefore: area(diff.before.roomsComputed, diff.before.totalArea),
    areaAfter: area(diff.after.roomsComputed, diff.after.totalArea),
  };
}

export function buildPlanReport(plan: FloorPlan, meta: { generatedAt: string; appVersion: string }): PlanReport {
  const findings: ReportFinding[] = [];
  const wallName = (id: string) => {
    const index = plan.walls.findIndex((wall) => wall.id === id);
    return index >= 0 ? `Стена ${index + 1}` : "Удалённая стена";
  };

  // Rooms and areas.
  const wallMode = plan.roomMode === "walls";
  const detection = detectViewRooms(plan);
  const rooms: ReportRoom[] = wallMode
    ? detection.rooms.map((room) => ({ name: room.name, kind: ROOM_KINDS[room.kind].label, area: room.area }))
    : plan.rooms.map((room) => ({ name: room.name, kind: ROOM_KINDS[room.kind].label, area: room.width * room.height }));
  const area = detection.unresolved ? null : rooms.reduce((sum, room) => sum + room.area, 0);
  if (detection.unresolved) {
    findings.push({ level: "undetermined", state: "problem", title: "Помещения по стенам не определены", detail: detection.unresolved });
  } else if (!rooms.length) {
    findings.push(wallMode
      ? { level: "undetermined", state: "problem", title: "План не образует замкнутый контур", detail: "Без замкнутых помещений площади и требования к комнатам не считаются." }
      : { level: "undetermined", state: "problem", title: "В плане нет помещений" });
  } else if (wallMode) {
    findings.push({
      level: "verified",
      state: "ok",
      title: `Площадь посчитана по стенам: ${plural(rooms.length, "помещение", "помещения", "помещений")}, ${formatArea(area ?? 0)}`,
      detail: "Внутри стен, с учётом их толщины.",
    });
    for (const warning of detection.warnings) findings.push({ level: "assumption", state: "note", title: warning });
  } else {
    findings.push({
      level: "assumption",
      state: "note",
      title: `Помещения заданы вручную: ${formatArea(area ?? 0)}`,
      detail: "Площадь считается по прямоугольникам, которые ввёл пользователь, а не по стенам.",
    });
  }
  if (plan.underlay && !plan.underlay.calibrated) {
    findings.push({
      level: "assumption",
      state: "problem",
      title: "Масштаб подложки не подтверждён",
      detail: "Размеры, снятые с такой подложки, могут не совпадать с чертежом. Задайте масштаб по двум точкам.",
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
      title: `Тип не указан у стен: ${unknownWalls} из ${plan.walls.length}`,
      detail: "Вывод о допустимости изменений этих стен не делается. Укажите тип по документам или у специалиста; приложение его не определяет.",
    });
  } else if (plan.walls.length) {
    findings.push({
      level: "verified",
      state: "ok",
      title: `Тип указан у всех стен: несущих ${bearing}, перегородок ${partition}`,
      detail: "Тип отмечен пользователем.",
    });
  }

  // Requirements.
  const adjacency = wallMode && !detection.unresolved ? findRoomAdjacency(detection.rooms, plan.walls, plan.openings) : null;
  const results = evaluateRequirements(plan, detection.rooms, adjacency);
  const roomName = (id: string) => detection.rooms.find((room) => room.id === id)?.name ?? "Помещение";
  const labelName = (id: string) => plan.wallRoomLabels.find((label) => label.id === id)?.name;
  plan.requirements.forEach((requirement, index) => {
    const result = results[index];
    const title = describeRequirement(requirement, wallName, labelName);
    const detail = requirementDetail(requirement, result, roomName, wallName);
    if (result.status === "met") findings.push({ level: "verified", state: "ok", title: `Выполнено: ${title}`, detail });
    else if (result.status === "violated") findings.push({ level: "verified", state: "problem", title: `Нарушено: ${title}`, detail });
    else findings.push({ level: "undetermined", state: "note", title: `Не проверено: ${title}`, detail });
  });
  for (const conflict of findRequirementConflicts(plan.requirements)) {
    findings.push({ level: conflict.certain ? "verified" : "assumption", state: "problem", title: "Требования противоречат друг другу", detail: conflictText(conflict) });
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
      const more = diagnostics.truncated[kind] ? " (показана часть)" : "";
      findings.push({ level: "verified", state: "problem", title: `${GEOMETRY_TEXT[kind].title}: ${count}${more}`, detail: GEOMETRY_TEXT[kind].detail });
    }
    if (!diagnostics.total) {
      findings.push({ level: "verified", state: "ok", title: "Геометрия без замечаний", detail: "Концы стен соединены, стены не пересекаются и не накладываются, двери открываются свободно." });
    }
  }

  // Changes against the source of a variant.
  const origin = changeFindings(plan, findings);

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
    limits: [REPORT_RULES_NOTE, REPORT_DISCLAIMER],
  };
}

function verdictOf(counts: Readonly<Record<ReportLevel, number>>, problems: number): PlanReport["verdict"] {
  if (counts.specialist) {
    return { level: "specialist", title: "Нужен специалист", text: "Есть изменения, допустимость которых нельзя определить без специалиста: они перечислены первыми." };
  }
  if (counts.undetermined && problems) {
    return { level: "undetermined", title: "Данных недостаточно", text: "По части вопросов вывода нет: без замкнутых помещений или нужных данных проверка не работает." };
  }
  if (problems) {
    return { level: "assumption", title: "Есть что проверить", text: "Найдены замечания и неподтверждённые данные. Они не означают запрет, но до их разбора вывод о плане неполный." };
  }
  if (counts.assumption || counts.undetermined) {
    return { level: "assumption", title: "Замечаний нет, но есть предположения", text: "Нарушений не найдено. Часть выводов опирается на данные, которые никто не подтвердил." };
  }
  return { level: "clear", title: "Замечаний нет", text: "По геометрии плана и заданным требованиям нарушений нет. Нормы региона этот отчёт не проверяет." };
}
