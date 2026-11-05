import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { planFromOrigin } from "@/domain/floor-plan/plan-origin";
import { formatArea } from "@/lib/format";
import type { FloorPlan, Opening, RoomKind, Wall } from "@/domain/floor-plan/types";
import { openingChanges, roomKindChanges, wallChanges } from "./plan-changes";
import {
  hasOutsideWindow,
  isPerimeterOpening,
  isPerimeterWall,
  roomHeight,
  openingCentre,
  overlapArea,
  roomsBeside,
  roomsOfPlan,
  sameShape,
  type RuleRoom,
  type RuleRooms,
} from "./rule-rooms";
import type { FactKey, Procedure, RegulationDocument, RuleFinding, RulePack, RuleSource } from "./types";
import { MOSCOW_SIGNOFFS } from "./moscow-signoffs";

/**
 * The Moscow rule base. Every rule here was written from a text that was actually read;
 * `documents` says which edition and what is missing. Nothing comes from memory. It has
 * not been confirmed by a specialist yet (`reviewed: false`), and the engine caps every
 * statement accordingly. See docs/RULES_MOSCOW.md.
 */
const DOCUMENTS: readonly RegulationDocument[] = [
  {
    id: "moscow-508",
    short: tr`508-ПП`,
    title: tr`Постановление Правительства Москвы от 25.10.2011 № 508-ПП, приложение 1 «Требования к проведению переустройства и (или) перепланировки помещений в многоквартирном доме»`,
    edition: tr`Приложение 1 в редакции № 1083-ПП от 15.06.2022 с изменениями № 841-ПП от 18.04.2025, подписанные тексты с mos.ru`,
    url: "https://www.mos.ru/authority/documents/doc/55691220/",
    gaps: tr`Не прочитан № 3005-ПП от 26.12.2022. № 2920-ПП от 28.11.2025 и № 950-ПП от 07.04.2026 прочитаны как проекты с сайта Мосжилинспекции; пункты 2 и 9 они, судя по проектам, не меняют.`,
  },
  {
    id: "rf-pp-47",
    short: tr`ПП РФ № 47`,
    title: tr`Постановление Правительства РФ от 28.01.2006 № 47, Положение о признании помещения жилым помещением`,
    edition: tr`Редакция от 20.06.2026`,
    url: "https://legalacts.ru/doc/postanovlenie-pravitelstva-rf-ot-28012006-n-47/",
    gaps: tr`Прочитана копия на legalacts.ru, а не официальная публикация.`,
  },
  {
    id: "sp-54",
    short: tr`СП 54`,
    title: tr`СП 54.13330.2022 «Здания жилые многоквартирные»`,
    edition: tr`Редакция от 27.12.2024, с изменениями № 1 и № 2`,
    url: "https://meganorm.ru/mega_doc/norm_update_29032025/nomenklatura/0/sp_54_13330_2022_svod_pravil_zdaniya_zhilye_mnogokvartirnye.html",
    gaps: tr`Прочитана копия на meganorm.ru. Свод относится к проектированию новых и реконструируемых зданий (п. 1.1); применимость к перепланировке в существующем доме определяет специалист.`,
  },
  {
    id: "zhk-rf",
    short: tr`ЖК РФ`,
    title: tr`Жилищный кодекс РФ, статьи 25 и 26`,
    edition: tr`Действующая редакция по zakonrf.info, дата редакции там не указана`,
    url: "https://www.zakonrf.info/jk/26/",
    gaps: tr`Прочитана копия, а не официальная публикация.`,
  },
];

const NOT_CHECKED: readonly string[] = [
  tr`Вентиляционные каналы и короба, не отмеченные на плане как помещение «Вентшахта, короб» (508-ПП, п. 9.5).`,
  tr`Инженерные сети, радиаторы и тёплые полы от общедомовых систем (508-ПП, пп. 9.4, 9.7, 9.8).`,
  tr`Пилоны, диафрагмы, колонны и места связей между элементами (508-ПП, п. 9.10): план такого не хранит.`,
  tr`Балконы и лоджии, не отмеченные на плане как помещение «Балкон, лоджия» (508-ПП, пп. 9.13, 9.18), а также террасы и веранды.`,
  tr`Нагрузка на перекрытия и материал перегородок (508-ПП, пп. 2.2.9, 9.6).`,
  tr`Инсоляция, шум и другие санитарные требования (ПП РФ № 47, пп. 21, 26).`,
  tr`Порядок подачи документов и сроки согласования.`,
];

const from508 = (...points: string[]): RuleSource[] =>
  points.map((point) => ({ document: "moscow-508", point: tr`прил. 1, п. ${point}` }));
const fromPp47 = (point: string): RuleSource => ({ document: "rf-pp-47", point: tr`п. ${point}` });
const fromSp54 = (point: string): RuleSource => ({ document: "sp-54", point: tr`п. ${point}` });
const fromZhk = (point: string): RuleSource => ({ document: "zhk-rf", point });

export const PROCEDURES: Readonly<Record<Procedure, { label: string; meaning: string; sources: readonly RuleSource[] }>> = {
  forbidden: { label: tr`Не допускается`, meaning: tr`Такую работу запрещает документ из базы правил.`, sources: [] },
  specialist: { label: tr`Нужен специалист`, meaning: tr`Ответ зависит от конструкций дома, а на плане их состояния не видно.`, sources: [] },
  project: {
    label: tr`Нужен проект`,
    meaning: tr`Проект перепланировки, решение о согласовании до работ и акт после них; работы выполняет член СРО.`,
    sources: [...from508("2", "13", "15"), fromZhk(tr`ст. 26, ч. 2`)],
  },
  simplified: {
    label: tr`Упрощённый порядок`,
    meaning: tr`Согласование до работ не требуется; после работ подаётся запрос на акт и эскиз планов до и после.`,
    sources: from508("19", "19.1", "19.4"),
  },
  unknown: { label: tr`Нет данных`, meaning: tr`Ответ зависит от того, чего на плане нет.`, sources: [] },
};

/** Heaviest first; `overall` takes the first one found among the changes. */
export const PROCEDURE_ORDER: readonly Procedure[] = ["forbidden", "specialist", "project", "unknown", "simplified"];

const LIVING_KINDS: readonly RoomKind[] = ["living", "bedroom"];
const isLiving = (room: RuleRoom) => LIVING_KINDS.includes(room.kind);

/** Less than this is a drawing inaccuracy, not a room over a room. */
const MIN_STACK_OVERLAP = 0.1;
/** Rooms that share less than this with the new room were not merged into it. */
const MIN_MERGE_OVERLAP = 1;
/** A balcony counts as absorbed once a room covers at least this share of it. */
const SAME_ROOM_SHARE = 0.5;
const AREA_TOLERANCE = 0.005;

const hasHeight = (height: number, minimum: number) => height >= minimum - 1e-9;

function numberOf(plan: Pick<FloorPlan, "walls">, wall: Wall): number {
  return plan.walls.findIndex((item) => item.id === wall.id) + 1;
}
function wallList(plan: Pick<FloorPlan, "walls">, walls: readonly Wall[]): string {
  const numbers = walls.map((wall) => numberOf(plan, wall)).sort((a, b) => a - b);
  return `${numbers.length === 1 ? tr`стена` : tr`стены`} ${numbers.join(", ")}`;
}

/** «стены 5, 7 исходного плана; новые: стена 9». */
function changedWalls(source: Pick<FloorPlan, "walls">, plan: Pick<FloorPlan, "walls">, before: readonly Wall[], added: readonly Wall[]): string {
  return [
    before.length ? tr`${wallList(source, before)} исходного плана` : "",
    added.length ? tr`новые: ${wallList(plan, added)}` : "",
  ].filter(Boolean).join("; ");
}

function missingFacts(plan: FloorPlan, rooms: readonly RuleRoom[]): FactKey[] {
  const facts = plan.buildingFacts ?? {};
  const missing: FactKey[] = [];
  if (facts.emergency === undefined) missing.push("emergency");
  if (facts.heritage === undefined) missing.push("heritage");
  if (facts.woodenFloors === undefined) missing.push("woodenFloors");
  if (facts.gasified === undefined && rooms.some((room) => room.kind === "kitchen")) missing.push("gasified");
  if (facts.floorLevel === undefined && rooms.some((room) => room.kind === "balcony")) missing.push("floorLevel");
  if (rooms.some((room) => room.kind === "kitchen" || room.kind === "bathroom")) {
    if (facts.below === undefined) missing.push("below");
    if (facts.above === undefined) missing.push("above");
  }
  return missing;
}

/** What can be said about the plan as it stands, without comparing it to anything. */
function stateFindings(plan: FloorPlan, { rooms, unresolved }: RuleRooms): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const facts = plan.buildingFacts ?? {};
  if (facts.emergency) {
    findings.push({
      ruleId: "moscow.building.emergency",
      level: "specialist",
      state: "problem",
      procedure: "forbidden",
      title: tr`Дом признан аварийным: переустройство и перепланировка не допускаются`,
      sources: from508("9.15"),
    });
  }
  if (facts.heritage) {
    findings.push({
      ruleId: "moscow.building.heritage",
      level: "specialist",
      state: "note",
      procedure: "project",
      title: tr`Объект культурного наследия: работы только по проекту`,
      detail: tr`Нужно ещё заключение Департамента культурного наследия города Москвы.`,
      sources: from508("2.1.2", "2.2.13", "12"),
    });
  }
  if (unresolved) {
    findings.push({
      ruleId: "moscow.rooms.unresolved",
      level: "undetermined",
      state: "problem",
      title: tr`Помещения не определены, поэтому площади, окна и высоты не проверены`,
      detail: unresolved,
      sources: [],
    });
    return findings;
  }
  if (!rooms.length) {
    findings.push({
      ruleId: "moscow.rooms.none",
      level: "undetermined",
      state: "problem",
      title: tr`В плане нет помещений: проверять по нормам пока нечего`,
      sources: [],
    });
    return findings;
  }
  const unnamed = rooms.filter((room) => room.kind === "other");
  if (unnamed.length) {
    findings.push({
      ruleId: "moscow.rooms.kind",
      level: "undetermined",
      state: "note",
      title: tr`Назначение не указано: ${unnamed.map((room) => room.name).join(", ")}`,
      detail: tr`Нормы для жилых комнат, кухонь и санузлов к таким помещениям не применялись. Укажите назначение в свойствах помещения.`,
      roomIds: unnamed.map((room) => room.id),
      sources: [],
    });
  }

  // Minimum areas.
  const livingCount = rooms.filter(isLiving).length;
  const minimum = (room: RuleRoom): number | null => {
    if (room.kind === "living") return livingCount >= 2 ? 16 : 14;
    if (room.kind === "bedroom") return 8;
    if (room.kind === "kitchen") return livingCount === 1 ? 5 : 8;
    return null;
  };
  const measured = rooms.filter((room) => minimum(room) !== null);
  const small = measured.filter((room) => room.area < minimum(room)! - AREA_TOLERANCE);
  for (const room of small) {
    findings.push({
      ruleId: "moscow.sp54.5.11",
      level: "verified",
      state: "problem",
      title: tr`${room.name}: ${formatArea(round(room.area))} при минимуме ${minimum(room)} м²`,
      detail: tr`Минимум из свода правил для проектирования новых и реконструируемых домов. Обязателен ли он при этой перепланировке, определяет специалист. Спальня на двух человек: 10 м²; мансардный этаж: 7 м².`,
      roomIds: [room.id],
      sources: [fromSp54("5.11")],
    });
  }
  if (measured.length && !small.length) {
    findings.push({
      ruleId: "moscow.sp54.5.11",
      level: "verified",
      state: "ok",
      title: tr`Площади не ниже минимумов СП 54: помещений ${measured.length}`,
      sources: [fromSp54("5.11")],
    });
  }

  if (plan.roomMode !== "walls") {
    findings.push({
      ruleId: "moscow.rooms.manual",
      level: "undetermined",
      state: "note",
      title: tr`Помещения заданы вручную: окна, высоты и стены по нормам не проверялись`,
      detail: tr`Нарисуйте стены, чтобы правила увидели границы помещений и проёмы.`,
      sources: [],
    });
    return findings;
  }

  // Daylight: a window between a room and the outside.
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const needDaylight = rooms.filter((room) => isLiving(room) || room.kind === "kitchen");
  const dark = needDaylight.filter((room) => !hasOutsideWindow(plan, room, rooms));
  for (const room of dark) {
    findings.push({
      ruleId: "moscow.pp47.25",
      level: "verified",
      state: "problem",
      title: tr`${room.name}: нет окна наружу`,
      detail: tr`Комнаты и кухни должны иметь непосредственное естественное освещение. Окно на балкон или лоджию считается окном наружу.`,
      roomIds: [room.id],
      sources: [fromPp47("25")],
    });
  }
  if (needDaylight.length && !dark.length) {
    findings.push({
      ruleId: "moscow.pp47.25",
      level: "verified",
      state: "ok",
      title: tr`Окно наружу есть в каждой комнате и кухне: помещений ${needDaylight.length}`,
      sources: [fromPp47("25")],
    });
  }

  // A door-way with no door between a kitchen and a living room.
  const openToKitchen = plan.openings.filter((opening) => {
    if (!opening.doorless) return false;
    const sides = roomsBeside(walls.get(opening.wallId)!, openingCentre(opening), rooms);
    return sides.some((room) => room?.kind === "kitchen") && sides.some((room) => room && isLiving(room));
  });
  if (openToKitchen.length && facts.gasified !== false) {
    const ids = openToKitchen.map((opening) => opening.id);
    findings.push(facts.gasified
      ? {
        ruleId: "moscow.508.9.25",
        level: "specialist",
        state: "problem",
        procedure: "forbidden",
        title: tr`Проём без двери между жилой комнатой и газифицированной кухней: не допускается`,
        openingIds: ids,
        sources: from508("9.25"),
      }
      : {
        ruleId: "moscow.508.9.25",
        level: "undetermined",
        state: "problem",
        procedure: "unknown",
        title: tr`Проём без двери между кухней и жилой комнатой, но неизвестно, есть ли газ`,
        detail: tr`С газифицированной кухней такой проём не допускается. Ответьте на вопрос о газе.`,
        openingIds: ids,
        sources: from508("9.25"),
      });
  }

  // Heights: the lowest wall around a room.
  const heightOf = (room: RuleRoom) => roomHeight(plan, room);
  const low = rooms.filter((room) => {
    const height = heightOf(room);
    if (isLiving(room) || room.kind === "kitchen") return !hasHeight(height, 2.5);
    if (room.kind === "hall") return !hasHeight(height, 2.1);
    return false;
  });
  for (const room of low) {
    findings.push({
      ruleId: "moscow.pp47.22",
      level: "verified",
      state: "problem",
      title: tr`${room.name}: высота ${lengthText(round(heightOf(room)))} при минимуме ${lengthText(room.kind === "hall" ? 2.1 : 2.5)}`,
      detail: tr`Высота взята по самой низкой стене помещения. В отдельных климатических районах минимум 2,7 м; район Москвы по СП 131 не сверялся.`,
      roomIds: [room.id],
      sources: [fromPp47("22")],
    });
  }
  return findings;
}

const round = (value: number) => Math.round(value * 100) / 100;

function changeFindings(plan: FloorPlan, source: FloorPlan, after: RuleRooms, before: RuleRooms): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const facts = plan.buildingFacts ?? {};
  const walls = wallChanges(source, plan);
  const openings = openingChanges(source, plan);
  const wallsBefore = new Map(source.walls.map((wall) => [wall.id, wall]));
  const wallsAfter = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const kindOf = (wall: Wall | undefined) => wall?.kind ?? "unknown";

  // Bearing walls.
  const bearing = (text: string, wall: Wall, ruleId = "moscow.508.9.3") =>
    findings.push({
      ruleId,
      level: "specialist",
      state: "problem",
      procedure: "specialist",
      title: tr`Затронута несущая стена: стена ${numberOf(source, wall)} исходного плана ${text}`,
      detail: tr`Не допускается нарушение прочности и устойчивости несущих конструкций и нагрузка на них сверх допустимой. Определить это по плану нельзя: нужно заключение специалиста.`,
      wallIds: [wall.id],
      sources: from508("9.3", "9.6"),
    });
  for (const wall of walls.removed) if (kindOf(wall) === "bearing") bearing(tr`удалена`, wall);
  for (const { before: wall } of walls.moved) if (kindOf(wall) === "bearing") bearing(tr`перенесена или изменена её длина`, wall);
  for (const { before: wall } of walls.thickened) if (kindOf(wall) === "bearing") bearing(tr`изменена толщина`, wall);
  for (const { before: wall, after: next } of walls.retyped) {
    if (kindOf(wall) === "bearing" && kindOf(next) !== "bearing") bearing(tr`больше не отмечена несущей`, wall);
  }
  const newBearing = walls.added.filter((wall) => kindOf(wall) === "bearing");
  if (newBearing.length) {
    findings.push({
      ruleId: "moscow.508.2.2.2",
      level: "specialist",
      state: "problem",
      procedure: "project",
      title: tr`Новая несущая стена: нужен проект (${wallList(plan, newBearing)})`,
      wallIds: newBearing.map((wall) => wall.id),
      sources: from508("2.2.2"),
    });
  }

  // Walls of no known type: no conclusion at all.
  const unknownBefore = [...walls.removed, ...walls.moved.map((item) => item.before), ...walls.thickened.map((item) => item.before)]
    .filter((wall) => kindOf(wall) === "unknown");
  const unknownNew = walls.added.filter((wall) => kindOf(wall) === "unknown");
  if (unknownBefore.length || unknownNew.length) {
    findings.push({
      ruleId: "moscow.walls.unknown",
      level: "undetermined",
      state: "problem",
      procedure: "unknown",
      title: tr`Изменены стены без указанного типа: ${changedWalls(source, plan, unknownBefore, unknownNew)}`,
      detail: tr`Пока тип не указан, вывода об этих изменениях нет: это может быть несущая стена.`,
      wallIds: [...unknownBefore, ...unknownNew].map((wall) => wall.id),
      sources: [],
    });
  }

  // Partitions.
  // These partitions may not be removable at all (пп. 9.5, 9.16, 9.18), so naming a
  // simplified procedure for them would mislead. The rules below speak for them instead.
  const hasStrongerRule = (wall: Wall) => {
    const beside = before.rooms.filter((room) => room.boundaryWallIds.includes(wall.id));
    if (beside.some((room) => room.kind === "shaft" || room.kind === "balcony")) return true;
    return facts.gasified !== false && beside.some((room) => room.kind === "kitchen") && beside.some(isLiving);
  };
  const oldPartitions = [...walls.removed, ...walls.moved.map((item) => item.before)]
    .filter((wall) => kindOf(wall) === "partition")
    .filter((wall) => !hasStrongerRule(wall));
  const newPartitions = walls.added
    .filter((wall) => kindOf(wall) === "partition")
    .filter((wall) => !after.rooms.some((room) => (room.kind === "balcony" || room.kind === "shaft") && room.boundaryWallIds.includes(wall.id)));
  if (oldPartitions.length || newPartitions.length) {
    const wallIds = [...oldPartitions, ...newPartitions].map((wall) => wall.id);
    const named = changedWalls(source, plan, oldPartitions, newPartitions);
    if (facts.woodenFloors) {
      findings.push({
        ruleId: "moscow.508.2.2.10",
        level: "specialist",
        state: "problem",
        procedure: "project",
        title: tr`Перегородки в доме с деревянными перекрытиями: нужен проект (${named})`,
        wallIds,
        sources: from508("2.2.10"),
      });
    } else {
      findings.push({
        ruleId: "moscow.508.19.6.1",
        level: "verified",
        state: "note",
        procedure: "simplified",
        title: tr`Перегородки: упрощённый порядок (${named})`,
        detail: tr`Согласование до работ не требуется, после работ подаётся запрос на акт. Иначе, если перегородка создаёт нагрузку более 150 кг/м² (п. 2.2.9)${facts.woodenFloors === undefined ? tr` или перекрытия деревянные (п. 2.2.10; это ещё не указано)` : ""}: тогда нужен проект.`,
        wallIds,
        sources: from508("19.6.1", "19.1", "2.2.9", "2.2.10"),
      });
    }
  }

  // The apartment's outer contour.
  if (!before.unresolved && !after.unresolved) {
    const outerChanged = [
      ...[...walls.removed, ...walls.moved.map((item) => item.before)].filter((wall) => isPerimeterWall(wall, before.rooms)),
      ...walls.added.filter((wall) => isPerimeterWall(wall, after.rooms)),
    ];
    if (outerChanged.length) {
      findings.push({
        ruleId: "moscow.508.2.2.5",
        level: "specialist",
        state: "problem",
        procedure: "project",
        title: tr`Изменён контур квартиры: затронуто стен ${outerChanged.length}`,
        detail: tr`Изменение границ обособленных помещений делается по проекту. Если затронута граница с соседним помещением или общее имущество, могут понадобиться согласие собственников и изменения в ЕГРН.`,
        wallIds: outerChanged.map((wall) => wall.id),
        sources: [...from508("2.2.5"), fromZhk(tr`ст. 25, ч. 2`), fromZhk(tr`ст. 26, ч. 2, п. 3`)],
      });
    }
  }

  // Openings.
  const hostOf = (opening: Opening, map: ReadonlyMap<string, Wall>) => map.get(opening.wallId);
  const changed = [
    ...openings.added.map((opening) => ({ opening, host: hostOf(opening, wallsAfter), rooms: after.rooms, change: "added" as const })),
    ...openings.moved.map(({ after: opening }) => ({ opening, host: hostOf(opening, wallsAfter), rooms: after.rooms, change: "moved" as const })),
    ...openings.removed.map((opening) => ({ opening, host: hostOf(opening, wallsBefore), rooms: before.rooms, change: "removed" as const })),
  ];
  const onPerimeter = changed.filter(({ opening, host, rooms }) => host && isPerimeterOpening(host, opening, rooms));
  /** «на стене 1» or «на стенах 1, 3», numbered as in the plan the opening is on. */
  const onWalls = (items: readonly (typeof changed)[number][]) => {
    const numbers = [...new Set(items.map(({ host, change }) => {
      if (!host) return 0;
      return numberOf(change === "removed" ? source : plan, host);
    }))].filter(Boolean).sort((a, b) => a - b);
    return numbers.length === 1 ? tr`стена ${numbers[0]}` : tr`стены ${numbers.join(", ")}`;
  };
  if (onPerimeter.length) {
    findings.push({
      ruleId: "moscow.508.3.1",
      level: "specialist",
      state: "problem",
      procedure: "project",
      title: tr`Изменён проём на границе квартиры: ${onPerimeter.length} (${onWalls(onPerimeter)})`,
      detail: tr`Создание, ликвидация и изменение формы окон и дверей в наружной стене делается по проекту и может затрагивать общее имущество. Если стена не наружная, а межквартирная, порядок определит специалист.`,
      openingIds: onPerimeter.map(({ opening }) => opening.id),
      sources: [...from508("3", "3.1"), fromZhk(tr`ст. 26, ч. 2, п. 3`)],
    });
  }
  const onBalconyWall = changed.filter(({ opening, host, rooms }) => {
    if (!host) return false;
    const [first, second] = roomsBeside(host, openingCentre(opening), rooms);
    return Boolean(first && second) && (first?.kind === "balcony" || second?.kind === "balcony");
  });
  if (onBalconyWall.length) {
    findings.push({
      ruleId: "moscow.508.2.2.14",
      level: "specialist",
      state: "problem",
      procedure: "project",
      title: tr`Проём к балкону или лоджии: нужен проект (${onWalls(onBalconyWall)})`,
      detail: tr`Это чтение верно, если работа не затрагивает архитектурный облик дома; иначе действует п. 3.9.`,
      openingIds: onBalconyWall.map(({ opening }) => opening.id),
      sources: from508("2.2.14", "3.9"),
    });
  }
  const inner = changed.filter((item) => !onPerimeter.includes(item) && !onBalconyWall.includes(item));
  const newInBearing = inner.filter(({ host, change }) => kindOf(host) === "bearing" && change !== "removed");
  if (newInBearing.length) {
    findings.push({
      ruleId: "moscow.508.2.2.4",
      level: "specialist",
      state: "problem",
      procedure: "project",
      title: tr`Проём в несущей стене: нужен проект (${onWalls(newInBearing)})`,
      detail: tr`В пилонах, диафрагмах, колоннах и местах связей между сборными элементами проём не допускается вовсе (п. 9.10); какая это конструкция, определит специалист.`,
      openingIds: newInBearing.map(({ opening }) => opening.id),
      sources: from508("2.2.4", "9.10"),
    });
  }
  const closedInBearing = inner.filter(({ host, change }) => kindOf(host) === "bearing" && change === "removed");
  if (closedInBearing.length) {
    findings.push({
      ruleId: "moscow.508.2.2.6",
      level: "undetermined",
      state: "problem",
      procedure: "unknown",
      title: tr`Заделан проём в несущей стене (${onWalls(closedInBearing)} исходного плана)`,
      detail: tr`Проектный проём заделывают в упрощённом порядке (п. 19.6.7), самовольно устроенный — по проекту (п. 2.2.6). Какой это проём, план не знает.`,
      openingIds: closedInBearing.map(({ opening }) => opening.id),
      sources: from508("2.2.6", "19.6.7"),
    });
  }
  const inPartition = inner.filter(({ host }) => kindOf(host) === "partition");
  if (inPartition.length) {
    findings.push({
      ruleId: "moscow.508.19.6.2",
      level: "verified",
      state: "note",
      procedure: "simplified",
      title: tr`Проёмы в перегородках: упрощённый порядок (${onWalls(inPartition)})`,
      openingIds: inPartition.map(({ opening }) => opening.id),
      sources: from508("19.6.2", "19.1"),
    });
  }
  const inUnknown = inner.filter(({ host }) => kindOf(host) === "unknown");
  if (inUnknown.length) {
    findings.push({
      ruleId: "moscow.openings.unknown",
      level: "undetermined",
      state: "problem",
      procedure: "unknown",
      title: tr`Изменён проём в стене без указанного типа (${onWalls(inUnknown)})`,
      detail: tr`Пока тип стены не указан, вывода нет: в несущей стене это работа по проекту.`,
      openingIds: inUnknown.map(({ opening }) => opening.id),
      sources: [],
    });
  }

  // Bathrooms, kitchens and what they stand on.
  if (before.unresolved || after.unresolved) {
    findings.push({
      ruleId: "moscow.rooms.compare",
      level: "undetermined",
      state: "problem",
      procedure: "unknown",
      title: tr`Санузлы и кухни не сравнивались с исходным планом: помещения не определены`,
      sources: [],
    });
    return findings;
  }
  const bathrooms = roomKindChanges(before.rooms, after.rooms, "bathroom");
  const kitchens = roomKindChanges(before.rooms, after.rooms, "kitchen");
  const changedBathrooms = [...bathrooms.created, ...bathrooms.resized.map((item) => item.after)];
  if (changedBathrooms.length) {
    findings.push({
      ruleId: "moscow.508.2.2.1",
      level: "specialist",
      state: "problem",
      procedure: "project",
      title: tr`Санузел устроен, перенесён или изменены его границы: нужен проект (${changedBathrooms.map((room) => room.name).join(", ")})`,
      roomIds: changedBathrooms.map((room) => room.id),
      sources: from508("2.2.1"),
    });
  }
  if (bathrooms.gone.length && !changedBathrooms.length) {
    findings.push({
      ruleId: "moscow.bathroom.gone",
      level: "specialist",
      state: "problem",
      procedure: "specialist",
      title: tr`Санузла больше нет на прежнем месте: ${bathrooms.gone.map((room) => room.name).join(", ")}`,
      detail: tr`Отдельного пункта об этом в прочитанных документах нет: инженерные сети и общее имущество оценит специалист.`,
      roomIds: bathrooms.gone.map((room) => room.id),
      sources: [],
    });
  }
  if (kitchens.created.length) {
    findings.push({
      ruleId: "moscow.508.2.2.11",
      level: "specialist",
      state: "problem",
      procedure: "project",
      title: tr`Кухня устроена или перенесена: нужен проект (${kitchens.created.map((room) => room.name).join(", ")})`,
      roomIds: kitchens.created.map((room) => room.id),
      sources: from508("2.2.11"),
    });
  }
  if (kitchens.resized.length || (kitchens.gone.length && !kitchens.created.length)) {
    findings.push({
      ruleId: "moscow.kitchen.changed",
      level: "undetermined",
      state: "note",
      procedure: "unknown",
      title: tr`Границы кухни изменены или кухни нет на прежнем месте`,
      detail: tr`Устройство и перенос кухни делаются по проекту (п. 2.2.11). Считается ли этим изменение границ, определит специалист.`,
      roomIds: [...kitchens.resized.map((item) => item.after.id), ...kitchens.gone.map((room) => room.id)],
      sources: from508("2.2.11"),
    });
  }

  // A kitchen and a living room merged into one.
  const merged = after.rooms.filter((room) => {
    const touches = (kinds: readonly RoomKind[]) =>
      before.rooms.some((old) => kinds.includes(old.kind) && overlapArea(old, room) >= MIN_MERGE_OVERLAP);
    return touches(["kitchen"]) && touches(LIVING_KINDS);
  });
  if (merged.length) {
    const roomIds = merged.map((room) => room.id);
    const names = merged.map((room) => room.name).join(", ");
    if (facts.gasified) {
      findings.push({
        ruleId: "moscow.508.9.16",
        level: "specialist",
        state: "problem",
        procedure: "forbidden",
        title: tr`Газифицированная кухня объединена с жилой комнатой: не допускается (${names})`,
        roomIds,
        sources: from508("9.16"),
      });
    } else if (facts.gasified === undefined) {
      findings.push({
        ruleId: "moscow.508.9.16",
        level: "undetermined",
        state: "problem",
        procedure: "unknown",
        title: tr`Кухня объединена с жилой комнатой, но неизвестно, есть ли газ (${names})`,
        detail: tr`Объединять газифицированное помещение с жилой комнатой нельзя. Ответьте на вопрос о газе.`,
        roomIds,
        sources: from508("9.16"),
      });
    } else {
      findings.push({
        ruleId: "moscow.508.9.16",
        level: "assumption",
        state: "note",
        title: tr`Кухня объединена с жилой комнатой, запрет для газа не применён (${names})`,
        detail: tr`Вы указали, что газа нет. Границы кухни всё равно могут потребовать проекта (п. 2.2.11).`,
        roomIds,
        sources: from508("9.16", "2.2.11"),
      });
    }
  }

  // Balconies: absorbed into a room, enlarged, new or gone.
  const balconies = roomKindChanges(before.rooms, after.rooms, "balcony");
  const absorbed = before.rooms.filter((room) => room.kind === "balcony").flatMap((balcony) =>
    after.rooms
      .filter((room) => room.kind !== "balcony" && overlapArea(balcony, room) >= balcony.area * SAME_ROOM_SHARE)
      .map((room) => ({ balcony, room })));
  if (absorbed.length) {
    findings.push({
      ruleId: "moscow.508.9.18",
      level: "specialist",
      state: "problem",
      procedure: "forbidden",
      title: tr`Балкон или лоджия объединены с помещением: не допускается (${absorbed.map(({ room }) => room.name).join(", ")})`,
      detail: tr`Запрет касается и включения их площади в общую площадь помещения.`,
      roomIds: absorbed.map(({ room }) => room.id),
      sources: from508("9.18"),
    });
  }
  const grown = [
    ...balconies.created,
    ...balconies.resized.filter((item) => item.after.area > item.before.area + AREA_TOLERANCE).map((item) => item.after),
  ];
  if (grown.length) {
    const names = grown.map((room) => room.name).join(", ");
    const roomIds = grown.map((room) => room.id);
    if (facts.floorLevel === "upper") {
      findings.push({
        ruleId: "moscow.508.9.13",
        level: "specialist",
        state: "problem",
        procedure: "forbidden",
        title: tr`Новый или увеличенный балкон на втором и выше этаже: не допускается (${names})`,
        roomIds,
        sources: from508("9.13"),
      });
    } else if (facts.floorLevel === "first") {
      findings.push({
        ruleId: "moscow.508.3.5",
        level: "specialist",
        state: "problem",
        procedure: "project",
        title: tr`Новый балкон или лоджия на первом этаже: нужен проект (${names})`,
        detail: tr`Без фундаментов и помещений под ними и без отопления.`,
        roomIds,
        sources: from508("3.5", "9.26"),
      });
    } else {
      findings.push({
        ruleId: "moscow.508.9.13",
        level: "undetermined",
        state: "problem",
        procedure: "unknown",
        title: tr`Новый или увеличенный балкон, но неизвестен этаж (${names})`,
        detail: tr`На втором и выше этаже это запрещено, на первом делается по проекту. Ответьте на вопрос об этаже.`,
        roomIds,
        sources: from508("9.13", "3.5"),
      });
    }
  }
  const goneBalconies = balconies.gone.filter((balcony) => !absorbed.some((item) => item.balcony === balcony));
  if (goneBalconies.length) {
    findings.push({
      ruleId: "moscow.balcony.gone",
      level: "specialist",
      state: "problem",
      procedure: "specialist",
      title: tr`Балкона или лоджии нет на прежнем месте: ${goneBalconies.map((room) => room.name).join(", ")}`,
      detail: tr`Отдельного пункта об этом нет; работа может затрагивать общее имущество и облик дома.`,
      roomIds: goneBalconies.map((room) => room.id),
      sources: from508("3.8", "3.9"),
    });
  }

  // Ventilation shafts and boxes.
  const shafts = roomKindChanges(before.rooms, after.rooms, "shaft");
  const touchedShafts = [...shafts.gone, ...shafts.resized.map((item) => item.before)];
  if (touchedShafts.length) {
    findings.push({
      ruleId: "moscow.508.9.5",
      level: "specialist",
      state: "problem",
      procedure: "forbidden",
      title: tr`Вентшахта или короб изменены или убраны: не допускается (${touchedShafts.map((room) => room.name).join(", ")})`,
      roomIds: touchedShafts.map((room) => room.id),
      sources: from508("9.5"),
    });
  }

  // What stands over what: the neighbours are assumed to live in the source layout.
  const movedWet = [...bathrooms.created, ...bathrooms.resized.map((item) => item.after), ...kitchens.created, ...kitchens.resized.map((item) => item.after)];
  const isNewLiving = (room: RuleRoom) =>
    isLiving(room) && !before.rooms.some((old) => isLiving(old) && sameShape(old, room));
  const stackSources = (upper: RuleRoom, lower: RuleRoom): RuleSource[] => {
    const sources: RuleSource[] = [];
    if (isLiving(lower)) sources.push(fromPp47("24"));
    if (upper.kind === "bathroom") sources.push(fromSp54("7.20"));
    if (upper.kind === "kitchen" && isLiving(lower)) sources.push(fromSp54("7.21"));
    if (facts.gasified && (upper.kind === "kitchen" || lower.kind === "kitchen")) sources.push(...from508("9.27"));
    return sources;
  };
  const reportStack = (upper: RuleRoom, lower: RuleRoom, where: "below" | "above") => {
    const mine = where === "below" ? upper : lower, theirs = where === "below" ? lower : upper;
    findings.push({
      ruleId: "moscow.stack",
      level: "assumption",
      state: "problem",
      procedure: "forbidden",
      title: tr`${mine.name} окажется ${where === "below" ? tr`над` : tr`под`} чужим помещением «${theirs.name}»`,
      detail: tr`Вы указали, что этажом ${where === "below" ? tr`ниже` : tr`выше`} такая же планировка, как исходная. Размещать санузел и кухню над жилыми комнатами, а санузел над кухней не допускается.`,
      roomIds: [mine.id],
      sources: stackSources(upper, lower),
    });
  };
  const liesOver = (upper: RuleRoom, lower: RuleRoom) =>
    upper.kind === "bathroom"
      ? isLiving(lower) || lower.kind === "kitchen"
      : upper.kind === "kitchen" && isLiving(lower);
  if (facts.below === "same-layout") {
    for (const room of movedWet) {
      for (const old of before.rooms) {
        if (liesOver(room, old) && overlapArea(room, old) >= MIN_STACK_OVERLAP) reportStack(room, old, "below");
      }
    }
  }
  if (facts.above === "same-layout") {
    const movedUnder = [...after.rooms.filter(isNewLiving), ...(kitchens.created)];
    for (const room of movedUnder) {
      for (const old of before.rooms) {
        if (liesOver(old, room) && overlapArea(room, old) >= MIN_STACK_OVERLAP) reportStack(old, room, "above");
      }
    }
  }
  const unknownNeighbour = (side: "below" | "above") => facts[side] === undefined || facts[side] === "other-layout";
  if (movedWet.length && (unknownNeighbour("below") || unknownNeighbour("above"))) {
    findings.push({
      ruleId: "moscow.stack.unknown",
      level: "undetermined",
      state: "problem",
      procedure: "unknown",
      title: tr`Неизвестно, что над и под новым санузлом или кухней`,
      detail: tr`Над жилыми комнатами их размещать нельзя. Ответьте на вопросы о соседях снизу и сверху: при такой же планировке это проверяется по исходному плану.`,
      roomIds: movedWet.map((room) => room.id),
      sources: [fromPp47("24"), fromSp54("7.20"), fromSp54("7.21")],
    });
  }
  return findings;
}

export const MOSCOW_PACK: RulePack = {
  id: "moscow",
  kind: "regulation",
  procedures: PROCEDURES,
  region: tr`Москва`,
  version: "2026-11-05",
  reviewed: false,
  documents: DOCUMENTS,
  notChecked: NOT_CHECKED,
  signoffs: MOSCOW_SIGNOFFS,
  check(plan) {
    const after = roomsOfPlan(plan);
    const findings = stateFindings(plan, after);
    let checkedChanges = false;
    if (plan.origin) {
      checkedChanges = true;
      const source = planFromOrigin(plan.origin);
      findings.push(...changeFindings(plan, source, after, roomsOfPlan(source)));
    }
    return { findings, missingFacts: missingFacts(plan, after.rooms), checkedChanges };
  },
};
