import { tr } from "@/lib/i18n";
import { planFromOrigin } from "@/domain/floor-plan/plan-origin";
import type { FloorPlan, ProfileRule, ProfileTarget, RoomKind, RuleProfile, Wall } from "@/domain/floor-plan/types";
import { formatArea, formatLength } from "@/lib/format";
import { openingChanges, roomKindChanges, wallChanges } from "./plan-changes";
import { hasOutsideWindow, overlapArea, roomHeight, roomsOfPlan } from "./rule-rooms";
import type { Procedure, ProcedureTexts, RegulationDocument, RuleFinding, RulePack, RuleSource } from "./types";

/**
 * The rules a developer wrote in their own words, for any country. The engine checks them
 * as written. It never says they match the law of that country: nothing was compared.
 */
export const OWNER_DOCUMENT = "owner-prompt";

const TARGET_LABELS: Readonly<Record<ProfileTarget, string>> = {
  "any-living": tr`Жилая комната`,
  living: tr`Гостиная`,
  bedroom: tr`Спальня`,
  kitchen: tr`Кухня`,
  bathroom: tr`Санузел`,
  hall: tr`Прихожая`,
  other: tr`Комната`,
  balcony: tr`Балкон, лоджия`,
  shaft: tr`Вентшахта, короб`,
};

export const matchesTarget = (kind: RoomKind, target: ProfileTarget): boolean =>
  target === "any-living" ? kind === "living" || kind === "bedroom" : kind === target;

/** What the app understood from a phrase, in its own words, for the developer to check. */
export function describeProfileRule(rule: ProfileRule): string {
  switch (rule.type) {
    case "room-min-area": return tr`${TARGET_LABELS[rule.target]}: площадь не меньше ${formatArea(rule.value)}`;
    case "room-max-area": return tr`${TARGET_LABELS[rule.target]}: площадь не больше ${formatArea(rule.value)}`;
    case "room-count": {
      const label = TARGET_LABELS[rule.target];
      if (rule.min !== undefined && rule.min === rule.max) return tr`${label}: ровно ${rule.min}`;
      if (rule.min !== undefined) return tr`${label}: не меньше ${rule.min}`;
      return tr`${label}: не больше ${rule.max}`;
    }
    case "min-height": return tr`Высота помещений не ниже ${formatLength(rule.value)} м`;
    case "window-required": return tr`${TARGET_LABELS[rule.target]}: должно быть окно наружу`;
    case "no-merge": return tr`Нельзя объединять: ${TARGET_LABELS[rule.target].toLowerCase()} и ${TARGET_LABELS[rule.other].toLowerCase()}`;
    case "keep-bearing": return tr`Несущие стены не меняются`;
    case "keep-room": return tr`${TARGET_LABELS[rule.target]}: остаётся на месте`;
    case "project-required": return tr`Изменения делаются только по проекту`;
  }
}

const PROCEDURES: ProcedureTexts = {
  forbidden: { label: tr`Не допускается`, meaning: tr`Это запрещают правила застройщика.`, sources: [] },
  specialist: { label: tr`Нужен специалист`, meaning: tr`Ответ зависит от конструкций дома, а на плане их состояния не видно.`, sources: [] },
  project: { label: tr`Нужен проект`, meaning: tr`Правила застройщика требуют для этого проект.`, sources: [] },
  simplified: { label: tr`Упрощённый порядок`, meaning: tr`Правила застройщика называют для этого упрощённый порядок.`, sources: [] },
  unknown: { label: tr`Нет данных`, meaning: tr`В правилах застройщика на это нет ответа.`, sources: [] },
};

const MIN_OVERLAP = 1;
const AREA_TOLERANCE = 0.005;

function statesFindings(plan: FloorPlan, profile: RuleProfile): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const { rooms, unresolved } = roomsOfPlan(plan);
  const walled = plan.roomMode === "walls";
  const sourceOf = (rule: ProfileRule): RuleSource[] => [{ document: OWNER_DOCUMENT, point: `«${rule.phrase}»` }];
  const finding = (rule: ProfileRule, state: RuleFinding["state"], title: string, extra: Partial<RuleFinding> = {}): RuleFinding => ({
    ruleId: `profile.${rule.type}`,
    level: "verified",
    state,
    title,
    sources: sourceOf(rule),
    ...extra,
  });
  const notChecked = (rule: ProfileRule, why: string): RuleFinding => ({
    ruleId: `profile.${rule.type}`,
    level: "undetermined",
    state: "note",
    title: tr`Не проверено: ${describeProfileRule(rule)}`,
    detail: why,
    sources: sourceOf(rule),
  });
  for (const rule of profile.rules) {
    if (rule.type === "keep-bearing" || rule.type === "no-merge" || rule.type === "keep-room" || rule.type === "project-required") continue;
    if (unresolved) {
      findings.push(notChecked(rule, unresolved));
      continue;
    }
    if (rule.type === "room-count") {
      const count = rooms.filter((room) => matchesTarget(room.kind, rule.target)).length;
      const fits = (rule.min === undefined || count >= rule.min) && (rule.max === undefined || count <= rule.max);
      findings.push(finding(rule, fits ? "ok" : "problem", tr`${describeProfileRule(rule)}: сейчас ${count}`));
      continue;
    }
    if (rule.type === "room-min-area" || rule.type === "room-max-area") {
      const matching = rooms.filter((room) => matchesTarget(room.kind, rule.target));
      if (!matching.length) {
        findings.push(notChecked(rule, tr`На плане нет такого помещения.`));
        continue;
      }
      const wrong = matching.filter((room) => rule.type === "room-min-area" ? room.area < rule.value - AREA_TOLERANCE : room.area > rule.value + AREA_TOLERANCE);
      for (const room of wrong) {
        const word = rule.type === "room-min-area" ? tr`минимуме` : tr`максимуме`;
        findings.push(finding(rule, "problem", tr`${room.name}: ${formatArea(Math.round(room.area * 100) / 100)} при ${word} ${formatArea(rule.value)}`, { roomIds: [room.id] }));
      }
      if (!wrong.length) findings.push(finding(rule, "ok", tr`Выполнено: ${describeProfileRule(rule)}`));
      continue;
    }
    // Windows and heights need walls to be known.
    if (!walled) {
      findings.push(notChecked(rule, tr`Помещения заданы вручную, стены и окна неизвестны.`));
      continue;
    }
    if (rule.type === "window-required") {
      const matching = rooms.filter((room) => matchesTarget(room.kind, rule.target));
      if (!matching.length) {
        findings.push(notChecked(rule, tr`На плане нет такого помещения.`));
        continue;
      }
      const dark = matching.filter((room) => !hasOutsideWindow(plan, room, rooms));
      for (const room of dark) findings.push(finding(rule, "problem", tr`${room.name}: нет окна наружу`, { roomIds: [room.id] }));
      if (!dark.length) findings.push(finding(rule, "ok", tr`Выполнено: ${describeProfileRule(rule)}`));
      continue;
    }
    const low = rooms.filter((room) => room.kind !== "shaft" && roomHeight(plan, room) < rule.value - 1e-9);
    for (const room of low) {
      findings.push(finding(rule, "problem", tr`${room.name}: высота ${formatLength(Math.round(roomHeight(plan, room) * 100) / 100)} м при минимуме ${formatLength(rule.value)} м`, { roomIds: [room.id] }));
    }
    if (!low.length) findings.push(finding(rule, "ok", tr`Выполнено: ${describeProfileRule(rule)}`));
  }
  for (const phrase of profile.notUnderstood) {
    findings.push({
      ruleId: "profile.not-understood",
      level: "undetermined",
      state: "note",
      title: tr`Не понято и не проверяется: «${phrase}»`,
      sources: [],
    });
  }
  return findings;
}

function changeFindings(plan: FloorPlan, source: FloorPlan, profile: RuleProfile): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const after = roomsOfPlan(plan);
  const before = roomsOfPlan(source);
  const walls = wallChanges(source, plan);
  const openings = openingChanges(source, plan);
  const changedWalls: Wall[] = [...walls.removed, ...walls.moved.map((item) => item.before), ...walls.thickened.map((item) => item.before), ...walls.added];
  const anyChange = changedWalls.length + openings.added.length + openings.removed.length + openings.moved.length > 0;
  const sourceOf = (rule: ProfileRule): RuleSource[] => [{ document: OWNER_DOCUMENT, point: `«${rule.phrase}»` }];
  const forbid = (rule: ProfileRule, title: string, extra: Partial<RuleFinding> = {}): RuleFinding => ({
    ruleId: `profile.${rule.type}`,
    level: "verified",
    state: "problem",
    procedure: "forbidden",
    title,
    sources: sourceOf(rule),
    ...extra,
  });
  const number = (wall: Wall) => source.walls.findIndex((item) => item.id === wall.id) + 1;

  const unknownWalls = changedWalls.filter((wall) => (wall.kind ?? "unknown") === "unknown");
  if (unknownWalls.length) {
    findings.push({
      ruleId: "profile.walls.unknown",
      level: "undetermined",
      state: "problem",
      procedure: "unknown",
      title: tr`Изменены стены без указанного типа: ${unknownWalls.length}`,
      detail: tr`Пока тип не указан, вывода об этих изменениях нет: это может быть несущая стена.`,
      wallIds: unknownWalls.map((wall) => wall.id),
      sources: [],
    });
  }
  const touchedBearing = [...walls.removed, ...walls.moved.map((item) => item.before), ...walls.thickened.map((item) => item.before)]
    .filter((wall) => wall.kind === "bearing");
  const keepBearing = profile.rules.find((rule) => rule.type === "keep-bearing");
  if (touchedBearing.length) {
    const title = tr`Затронута несущая стена: ${touchedBearing.map((wall) => tr`стена ${number(wall)}`).join(", ")} исходного плана`;
    findings.push(keepBearing
      ? forbid(keepBearing, title, { wallIds: touchedBearing.map((wall) => wall.id) })
      : { ruleId: "profile.bearing", level: "specialist", state: "problem", procedure: "specialist", title, detail: tr`В правилах застройщика об этом нет ни слова, а по плану это не оценить.`, wallIds: touchedBearing.map((wall) => wall.id), sources: [] });
  }
  if (!before.unresolved && !after.unresolved) {
    for (const rule of profile.rules) {
      if (rule.type === "no-merge") {
        const merged = after.rooms.filter((room) => {
          const touches = (target: ProfileTarget) => before.rooms.some((old) => matchesTarget(old.kind, target) && overlapArea(old, room) >= MIN_OVERLAP);
          return touches(rule.target) && touches(rule.other);
        });
        if (merged.length) {
          findings.push(forbid(rule, `${describeProfileRule(rule)} (${merged.map((room) => room.name).join(", ")})`, { roomIds: merged.map((room) => room.id) }));
        }
      }
      if (rule.type === "keep-room") {
        const kinds: RoomKind[] = rule.target === "any-living" ? ["living", "bedroom"] : [rule.target];
        const moved = kinds.flatMap((kind) => {
          const change = roomKindChanges(before.rooms, after.rooms, kind);
          return [...change.created, ...change.resized.map((item) => item.after), ...change.gone];
        });
        if (moved.length) {
          findings.push(forbid(rule, tr`Помещение должно остаться на месте: ${[...new Set(moved.map((room) => room.name))].join(", ")}`, { roomIds: moved.map((room) => room.id) }));
        }
      }
    }
  }
  const project = profile.rules.find((rule) => rule.type === "project-required");
  if (anyChange && project) {
    findings.push({
      ruleId: "profile.project-required",
      level: "verified",
      state: "problem",
      procedure: "project",
      title: tr`Изменения есть: по правилам застройщика нужен проект`,
      sources: sourceOf(project),
    });
  } else if (anyChange && !findings.some((item) => item.procedure)) {
    findings.push({
      ruleId: "profile.no-answer",
      level: "undetermined",
      state: "note",
      procedure: "unknown" satisfies Procedure,
      title: tr`Изменения есть, но в правилах застройщика о них ничего не сказано`,
      sources: [],
    });
  }
  return findings;
}

export function profilePack(profile: RuleProfile): RulePack {
  const document: RegulationDocument = {
    id: OWNER_DOCUMENT,
    short: tr`Правила застройщика`,
    title: tr`Правила, заданные застройщиком своими словами`,
    edition: tr`Текст из этого плана`,
    url: "",
    gaps: tr`Приложение не сверяло этот текст с нормами страны или региона.`,
  };
  return {
    id: "profile",
    kind: "owner",
    procedures: PROCEDURES,
    notUnderstood: profile.notUnderstood,
    region: tr`Правила застройщика`,
    version: "",
    reviewed: false,
    documents: [document],
    notChecked: [tr`Всё, чего нет в этом тексте. Нормы страны или региона приложение здесь не проверяет.`],
    check(plan) {
      const findings = statesFindings(plan, profile);
      let checkedChanges = false;
      if (plan.origin) {
        checkedChanges = true;
        findings.push(...changeFindings(plan, planFromOrigin(plan.origin), profile));
      }
      return { findings, missingFacts: [], checkedChanges };
    },
  };
}
