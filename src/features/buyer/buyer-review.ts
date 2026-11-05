import type { BuildingFacts, FloorPlan, Wall } from "@/domain/floor-plan/types";
import { evaluateRequirements, findRequirementConflicts } from "@/domain/floor-plan/plan-requirements";
import { findRoomAdjacency } from "@/domain/floor-plan/room-adjacency";
import { rulesForPlan } from "@/domain/rules/engine";
import {
  FLOOR_ANSWERS, FLOOR_LABEL, NEIGHBOUR_ANSWERS, NEIGHBOUR_LABELS, UNKNOWN_ANSWER, YES_NO_QUESTIONS,
} from "@/domain/rules/facts";
import { PROCEDURE_ORDER } from "@/domain/rules/moscow";
import type { ConfidenceLevel, FactKey, Procedure } from "@/domain/rules/types";
import { buyerBase } from "@/domain/template/buyer-guard";
import { fixedRoomIds, labelledRooms } from "@/domain/template/locks";
import { unconfirmedWalls } from "@/domain/template/readiness";
import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { conflictText, describeRequirement } from "../editor/requirement-text";
import { detectViewRooms } from "../editor/view-rooms";
import { buildPlanProof, type PlanProof, type ProofReason } from "../proof/plan-proof";
import { REPORT_LEVELS } from "../report/plan-report";

/**
 * The check a buyer sees after each change: every change of their copy against the
 * template, with a verdict, how sure that verdict is, and the rule behind it with its
 * source and status. Built on Proof, so the reasons and what they rest on are the same
 * ones Proof shows; nothing here is a second engine.
 */
export type Tone = "danger" | "warn" | "ok" | "unknown";

export interface BuyerChange {
  /** `wall:<id>`, `opening:<id>` or `room:<labelId>`: what undoing it takes. */
  id: string;
  text: string;
  procedure: Procedure | null;
  /** The procedure in words, or «Не определено» when no rule speaks to it. */
  verdict: string;
  level: ConfidenceLevel;
  levelLabel: string;
  /** Document and point, or a sentence saying no rule of the base covers this. */
  rule: string;
  ruleStatus: string;
  reasons: ProofReason[];
  tone: Tone;
  wallIds: string[];
  openingIds: string[];
}

export type Answer = { label: string; value: BuildingFacts[FactKey] };

export interface BuyerQuestion {
  id: string;
  /** Who can answer: the buyer here, the developer, or a specialist. */
  to: "buyer" | "developer" | "specialist";
  text: string;
  /** What depends on the answer, so nobody is asked for nothing. */
  why: string[];
  answer?: { key: FactKey; options: Answer[] };
}

export interface BuyerConflict {
  text: string;
  fix: string;
}

export interface BuyerReview {
  templateName: string;
  proof: PlanProof;
  changes: BuyerChange[];
  questions: BuyerQuestion[];
  conflicts: BuyerConflict[];
  /** Everything the conclusions rest on that nobody has confirmed. */
  unconfirmed: string[];
  /** The lowest confidence over all changes; null with no changes. */
  lowestLevel: ConfidenceLevel | null;
}

const LEVEL_ORDER: readonly ConfidenceLevel[] = ["undetermined", "specialist", "assumption", "verified"];
const TONES: Readonly<Record<Procedure, Tone>> = { forbidden: "danger", specialist: "warn", project: "warn", simplified: "ok", unknown: "unknown" };

/** The reason that decides a change: the heaviest procedure, else a problem, else the first. */
function decisive(reasons: readonly ProofReason[]): ProofReason | undefined {
  const rank = (reason: ProofReason) => (reason.procedure ? PROCEDURE_ORDER.indexOf(reason.procedure) : PROCEDURE_ORDER.length);
  return [...reasons].sort((a, b) => rank(a) - rank(b))[0];
}

function answersOf(key: FactKey): Answer[] {
  if (key === "floorLevel") return [{ label: FLOOR_ANSWERS.first, value: "first" }, { label: FLOOR_ANSWERS.upper, value: "upper" }];
  if (key === "below" || key === "above") {
    return (["same-layout", "other-layout", "no-dwelling"] as const).map((value) => ({ label: NEIGHBOUR_ANSWERS[value], value }));
  }
  return [{ label: tr`Да`, value: true }, { label: tr`Нет`, value: false }];
}

export function factLabel(key: FactKey): string {
  if (key === "floorLevel") return FLOOR_LABEL;
  if (key === "below" || key === "above") return NEIGHBOUR_LABELS[key];
  return YES_NO_QUESTIONS.find((question) => question.key === key)?.label ?? key;
}

function answerText(key: FactKey, value: BuildingFacts[FactKey]): string {
  if (value === undefined) return UNKNOWN_ANSWER;
  return answersOf(key).find((answer) => answer.value === value)?.label ?? String(value);
}

export function buildBuyerReview(plan: FloorPlan, meta: { generatedAt: string; appVersion: string }): BuyerReview | null {
  const base = buyerBase(plan);
  const template = plan.template;
  if (!base || !template || !plan.purchase) return null;
  const proof = buildPlanProof(plan, meta);
  const rules = rulesForPlan(plan);
  const number = (owner: FloorPlan, id: string) => owner.walls.findIndex((wall) => wall.id === id) + 1;

  const changes = proof.decisions.map((decision): BuyerChange => {
    const reason = decisive(decision.reasons);
    const wallId = decision.id.startsWith("wall:") ? decision.id.slice(5) : null;
    const openingId = decision.id.startsWith("opening:") ? decision.id.slice(8) : null;
    const level = reason?.level ?? "undetermined";
    return {
      id: decision.id,
      text: decision.text,
      procedure: decision.procedure,
      verdict: decision.label ?? tr`Не определено`,
      level,
      levelLabel: REPORT_LEVELS[level].label,
      rule: reason?.citation || (reason ? tr`Без документа: вывод о нехватке данных` : tr`Ни одно правило базы не говорит об этом изменении`),
      ruleStatus: reason?.ruleStatus || (rules ? tr`без правила` : tr`нормы не выбраны`),
      reasons: decision.reasons,
      tone: decision.procedure ? TONES[decision.procedure] : "unknown",
      wallIds: wallId ? [wallId] : [],
      openingIds: openingId ? [openingId] : [],
    };
  });

  // Questions, only where something depends on the answer.
  const questions: BuyerQuestion[] = [];
  const changeTexts = (test: (reason: ProofReason) => boolean) =>
    changes.filter((change) => change.reasons.some(test)).map((change) => change.text);
  for (const key of rules?.missingFacts ?? []) {
    const label = factLabel(key);
    const current = `${label}: ${UNKNOWN_ANSWER}`;
    const outcomes = proof.alternatives.filter((item) => item.subject === label).map((item) => tr`если «${item.answer}»: ${item.label}`);
    const why = [...changeTexts((reason) => reason.dependsOn.includes(current)), ...outcomes];
    questions.push({ id: `fact:${key}`, to: "buyer", text: tr`${label}?`, why: why.length ? why : [tr`Без ответа часть выводов остаётся без данных.`], answer: { key, options: answersOf(key) } });
  }
  if (!template.confirmed) {
    questions.push({ id: "confirm-walls", to: "developer", text: tr`Подтвердите стены и проёмы шаблона по чертежу.`, why: changes.length ? changes.map((change) => change.text) : [tr`Все размеры и площади взяты с неподтверждённого плана.`] });
  } else {
    const rooms = labelledRooms(base);
    for (const wall of unconfirmedWalls(base, template).changed) {
      const around = rooms.filter((room) => room.boundaryWallIds.includes(wall.id)).map((room) => room.id);
      const why = changes.filter((change) => change.wallIds.includes(wall.id)).map((change) => change.text);
      const findings = (rules?.findings ?? []).filter((finding) => finding.roomIds?.some((id) => around.includes(id))).map((finding) => finding.title);
      if (!why.length && !findings.length) continue;
      questions.push({
        id: `wall:${wall.id}`,
        to: "developer",
        text: tr`Подтвердите стену ${number(base, wall.id)}: длина ${lengthText(wallLength(wall))}, толщина ${lengthText(wall.thickness)}.`,
        why: [...why, ...findings],
      });
    }
  }
  if (plan.underlay && !plan.underlay.calibrated) {
    questions.push({ id: "scale", to: "developer", text: tr`Подтвердите масштаб чертежа.`, why: [tr`От него зависят все размеры и площади.`] });
  }
  const specialist = new Map<string, string[]>();
  for (const change of changes) {
    for (const reason of change.reasons) if (reason.level === "specialist") specialist.set(reason.title, [...(specialist.get(reason.title) ?? []), change.text]);
  }
  for (const reason of proof.general) if (reason.level === "specialist" && !specialist.has(reason.title)) specialist.set(reason.title, []);
  for (const [title, why] of specialist) questions.push({ id: `specialist:${title}`, to: "specialist", text: title, why });

  // Requirements that cannot all hold, and requirements a fixed room keeps from holding.
  const conflicts: BuyerConflict[] = [];
  const labelName = (id: string) => plan.wallRoomLabels.find((label) => label.id === id)?.name;
  const wallName = (id: string) => tr`Стена ${number(plan, id)}`;
  const describe = (id: string) => {
    const requirement = plan.requirements.find((item) => item.id === id);
    return requirement ? `«${describeRequirement(requirement, wallName, labelName)}»` : "";
  };
  for (const conflict of findRequirementConflicts(plan.requirements)) {
    conflicts.push({ text: conflictText(conflict), fix: tr`Измените одно из требований: ${conflict.ids.map(describe).filter(Boolean).join(tr` или `)}.` });
  }
  const detection = detectViewRooms(plan);
  if (!detection.unresolved && plan.requirements.length) {
    const adjacency = findRoomAdjacency(detection.rooms, plan.walls, plan.openings);
    const results = evaluateRequirements(plan, detection.rooms, adjacency);
    const fixed = fixedRoomIds(template);
    const rooms = labelledRooms(plan);
    plan.requirements.forEach((requirement, index) => {
      if (results[index]?.status !== "violated" || !("kind" in requirement)) return;
      const locked = rooms.filter((room) => room.labelId && fixed.has(room.labelId) &&
        ("labelId" in requirement && requirement.labelId ? room.labelId === requirement.labelId : room.kind === requirement.kind));
      if (!locked.length) return;
      conflicts.push({
        text: tr`${describe(requirement.id)} не выполняется, а «${locked.map((room) => room.name).join(", ")}» застройщик зафиксировал.`,
        fix: tr`Измените требование: эту комнату менять нельзя.`,
      });
    });
  }

  // What the conclusions rest on that nobody has confirmed.
  const unconfirmed: string[] = [];
  if (rules?.kind === "regulation" && rules.findings.some((finding) => finding.status === "draft")) {
    unconfirmed.push(tr`Правила — черновик: специалист их не сверял, поэтому выводы не выше «Предположения».`);
  }
  for (const key of rules?.missingFacts ?? []) unconfirmed.push(tr`${factLabel(key)}: ответа нет.`);
  const templateFacts = plan.purchase.templateFacts ?? {};
  for (const key of ["gasified", "woodenFloors", "heritage", "emergency", "floorLevel", "below", "above"] as FactKey[]) {
    const now = plan.buildingFacts?.[key];
    if (now !== undefined && now !== templateFacts[key]) {
      unconfirmed.push(tr`${factLabel(key)}: «${answerText(key, now)}» — ответ покупателя, застройщик его не подтверждал.`);
    }
  }
  const unknown = base.walls.filter((wall) => (wall.kind ?? "unknown") === "unknown");
  if (unknown.length) unconfirmed.push(tr`Тип не указан у стен шаблона: ${unknown.map((wall) => number(base, wall.id)).join(", ")}.`);
  if (!template.confirmed) unconfirmed.push(tr`Стены и проёмы шаблона застройщик не подтвердил.`);
  if (plan.underlay && !plan.underlay.calibrated) unconfirmed.push(tr`Масштаб чертежа не подтверждён.`);
  if (!rules) unconfirmed.push(tr`Нормы не выбраны: проверены только геометрия и требования.`);

  const levels = changes.map((change) => change.level);
  return {
    templateName: plan.purchase.templateName,
    proof,
    changes,
    questions,
    conflicts,
    unconfirmed,
    lowestLevel: levels.length ? LEVEL_ORDER.find((level) => levels.includes(level)) ?? null : null,
  };
}

const wallLength = (wall: Pick<Wall, "start" | "end">) => Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

/** Colours for the plan: each changed wall by its verdict, and walls the buyer took away. */
export function buyerHighlights(plan: FloorPlan, review: BuyerReview) {
  const base = buyerBase(plan);
  const walls = new Map<string, Tone>();
  const removed: { wall: Wall; tone: Tone }[] = [];
  for (const change of review.changes) {
    for (const id of change.wallIds) {
      if (plan.walls.some((wall) => wall.id === id)) walls.set(id, change.tone);
      else {
        const wall = base?.walls.find((item) => item.id === id);
        if (wall) removed.push({ wall, tone: change.tone });
      }
    }
    for (const id of change.openingIds) {
      const host = plan.openings.find((opening) => opening.id === id)?.wallId;
      if (host && !walls.has(host)) walls.set(host, change.tone);
    }
  }
  return { walls, removed };
}
