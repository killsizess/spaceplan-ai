import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { planFromOrigin } from "@/domain/floor-plan/plan-origin";
import { countsInTotal, type FloorPlan, type Opening, type Wall, type WallKind } from "@/domain/floor-plan/types";
import { citation, packForPlan, rulesForPlan } from "@/domain/rules/engine";
import { FLOOR_ANSWERS, FLOOR_LABEL, factLines, NEIGHBOUR_ANSWERS, NEIGHBOUR_LABELS, UNKNOWN_ANSWER, YES_NO_QUESTIONS, type FactLine } from "@/domain/rules/facts";
import { PROCEDURE_ORDER } from "@/domain/rules/moscow";
import { openingChanges, wallChanges } from "@/domain/rules/plan-changes";
import { isPerimeterWall, roomsOfPlan, type RuleRoom } from "@/domain/rules/rule-rooms";
import type { ConfidenceLevel, Procedure, RuleFinding, RuleReport } from "@/domain/rules/types";
import { sha256 } from "@/lib/sha256";
import { buildPlanReport, type ReportFinding } from "../report/plan-report";

/**
 * Proof answers "why is the conclusion about this decision what it is". X-Ray looks at an
 * apartment; Proof looks at one decision and lays out the chain: what changes, which rule
 * speaks to it, what the rule rests on, and what would change the answer.
 *
 * Nothing here is written by a model and nothing is stored. What a conclusion depends on is
 * not declared by hand either: it is found by running the same rules again with another
 * answer and seeing what moves, so it cannot drift away from the rules themselves.
 */
export interface ProofReason {
  ruleId: string;
  title: string;
  detail?: string;
  level: ConfidenceLevel;
  procedure?: Procedure;
  /** Empty for a statement about missing data, which no document backs. */
  citation: string;
  /** The inputs that move this reason when they change, as «Тип стены 5: перегородка». */
  dependsOn: string[];
  /** This reason names the procedure the whole answer ended on. */
  decisive: boolean;
}

export interface ProofDecision {
  id: string;
  text: string;
  /** The heaviest procedure the rules name for it; null when they name none. */
  procedure: Procedure | null;
  /** In the words of the rule base in force, which may be a developer's own. */
  label: string | null;
  reasons: ProofReason[];
}

/** An input that, given another value, changes the answer. */
export interface ProofAlternative {
  subject: string;
  current: string;
  answer: string;
  procedure: Procedure | null;
  label: string;
  /** What the rules say then that they do not say now. */
  because: string[];
}

export interface ProofRoomChange {
  name: string;
  before: number | null;
  after: number | null;
}

export type ProofStatus = "checked" | "no-rules" | "no-decision";

export interface PlanProof {
  planName: string;
  question: string;
  /** The plan the decision is measured against. */
  sourceName: string | null;
  generatedAt: string;
  appVersion: string;
  status: ProofStatus;
  answer: { procedure: Procedure | null; label: string; meaning: string; citation: string };
  /** Set while the rule base has not been confirmed by a specialist. */
  draftNote: string | null;
  decisions: ProofDecision[];
  /** What the rules say about the variant as a whole rather than about one step. */
  general: ProofReason[];
  /** What the rules checked and found to hold. */
  passed: ProofReason[];
  alternatives: ProofAlternative[];
  /** The owner's statements the conclusion stands on, none of which were verified. */
  wallTypes: FactLine[];
  facts: FactLine[];
  area: { before: number | null; after: number | null };
  roomChanges: ProofRoomChange[];
  /** Requirements, geometry and areas: what follows from the plan itself, with or without rules. */
  checks: ReportFinding[];
  limits: string[];
  /** Depends on the geometry, the answers, the rules' text and the source; not on the name. */
  fingerprint: string;
  rules: { version: string; region: string } | null;
}

const WALL_KIND_NAMES: Readonly<Record<WallKind, string>> = {
  bearing: tr`несущая`,
  partition: tr`перегородка`,
  unknown: tr`тип не указан`,
};
const kindOf = (wall: Wall): WallKind => wall.kind ?? "unknown";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A checksum of what a conclusion depends on, so a printed copy can be matched to a plan.
 * It is not an electronic signature: it says "the same plan", not "who wrote this".
 */
export function planFingerprint(plan: FloorPlan): string {
  const hex = sha256(canonical({
    roomMode: plan.roomMode,
    rooms: plan.rooms,
    walls: plan.walls,
    openings: plan.openings,
    wallRoomLabels: plan.wallRoomLabels,
    requirements: plan.requirements,
    buildingFacts: plan.buildingFacts,
    ruleProfile: plan.ruleProfile,
    source: plan.origin?.snapshot,
  }));
  return (hex.slice(0, 16).match(/.{4}/g) ?? []).join(" ");
}

const openingName = (opening: Opening) =>
  opening.kind === "window" ? tr`окно` : opening.doorless ? tr`проём без двери` : tr`дверь`;

interface Draft {
  id: string;
  text: string;
  wallIds: string[];
  openingIds: string[];
}

function draftDecisions(source: FloorPlan, plan: FloorPlan, roomsBefore: readonly RuleRoom[]): Draft[] {
  const walls = wallChanges(source, plan);
  const openings = openingChanges(source, plan);
  const number = (owner: FloorPlan, id: string) => owner.walls.findIndex((wall) => wall.id === id) + 1;
  const removed = new Set(walls.removed.map((wall) => wall.id));
  const added = new Set(walls.added.map((wall) => wall.id));
  const between = (wall: Wall) => {
    const names = roomsBefore.filter((room) => room.boundaryWallIds.includes(wall.id)).map((room) => `«${room.name}»`);
    if (!names.length) return "";
    // Rooms along an outer wall stand side by side, not on its two sides.
    if (names.length === 1 || isPerimeterWall(wall, roomsBefore)) return `, ${names.length > 1 ? tr`помещения` : tr`помещение`} ${names.join(", ")}`;
    return tr` между ${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}`;
  };
  const drafts: Draft[] = [];
  for (const wall of walls.removed) {
    const own = openings.removed.filter((item) => item.wallId === wall.id);
    drafts.push({
      id: `wall:${wall.id}`,
      text: tr`Убрать стену ${number(source, wall.id)} (${WALL_KIND_NAMES[kindOf(wall)]})${between(wall)}`,
      wallIds: [wall.id],
      openingIds: own.map((item) => item.id),
    });
  }
  for (const wall of walls.added) {
    const own = openings.added.filter((item) => item.wallId === wall.id);
    drafts.push({
      id: `wall:${wall.id}`,
      text: tr`Поставить новую стену ${number(plan, wall.id)} (${WALL_KIND_NAMES[kindOf(wall)]})${own.length ? tr`: ${own.map(openingName).join(", ")} в ней` : ""}`,
      wallIds: [wall.id],
      openingIds: own.map((item) => item.id),
    });
  }
  for (const { before } of walls.moved) {
    drafts.push({
      id: `wall:${before.id}`,
      text: tr`Перенести стену ${number(source, before.id)} или изменить её длину (${WALL_KIND_NAMES[kindOf(before)]})`,
      wallIds: [before.id],
      openingIds: [],
    });
  }
  for (const { before, after } of walls.thickened) {
    drafts.push({
      id: `wall:${before.id}`,
      text: tr`Изменить толщину стены ${number(source, before.id)}: ${lengthText(before.thickness)} → ${lengthText(after.thickness)}`,
      wallIds: [before.id],
      openingIds: [],
    });
  }
  for (const { before, after } of walls.retyped) {
    drafts.push({
      id: `wall:${before.id}`,
      text: tr`Сменить тип стены ${number(source, before.id)}: ${WALL_KIND_NAMES[kindOf(before)]} → ${WALL_KIND_NAMES[kindOf(after)]}`,
      wallIds: [before.id],
      openingIds: [],
    });
  }
  const single = (verb: string, opening: Opening, owner: FloorPlan) => drafts.push({
    id: `opening:${opening.id}`,
    text: tr`${verb} ${openingName(opening)} в стене ${number(owner, opening.wallId)}`,
    wallIds: [],
    openingIds: [opening.id],
  });
  for (const opening of openings.removed) if (!removed.has(opening.wallId)) single(tr`Убрать`, opening, source);
  for (const opening of openings.added) if (!added.has(opening.wallId)) single(tr`Сделать`, opening, plan);
  for (const { after } of openings.moved) single(tr`Перенести`, after, plan);
  return drafts;
}

const findingKey = (finding: RuleFinding) =>
  [finding.ruleId, ...(finding.wallIds ?? []), "|", ...(finding.roomIds ?? []), "|", ...(finding.openingIds ?? [])].join(",");
const findingMark = (finding: RuleFinding) => `${finding.procedure ?? ""}|${finding.state}`;

interface Experiment {
  subject: string;
  current: string;
  answer: string;
  plan: FloorPlan;
}

function withWallKind(plan: FloorPlan, wallId: string, kind: WallKind): FloorPlan {
  const set = (walls: readonly Wall[]) => walls.map((wall) => (wall.id === wallId ? { ...wall, kind } : wall));
  return {
    ...plan,
    walls: set(plan.walls),
    ...(plan.origin ? { origin: { ...plan.origin, snapshot: { ...plan.origin.snapshot, walls: set(plan.origin.snapshot.walls) } } } : {}),
  };
}

/** Walls first: a wrong wall type is the most serious mistake a conclusion can rest on. */
const MAX_WALL_EXPERIMENTS = 12;

function experimentsFor(plan: FloorPlan, source: FloorPlan): Experiment[] {
  const experiments: Experiment[] = [];
  const walls = wallChanges(source, plan);
  const touched = [...walls.removed, ...walls.moved.map((item) => item.before), ...walls.thickened.map((item) => item.before)];
  for (const wall of touched.slice(0, MAX_WALL_EXPERIMENTS)) {
    for (const kind of ["bearing", "partition"] as const) {
      if (kindOf(wall) === kind) continue;
      experiments.push({
        subject: tr`Тип стены ${source.walls.findIndex((item) => item.id === wall.id) + 1}`,
        current: WALL_KIND_NAMES[kindOf(wall)],
        answer: WALL_KIND_NAMES[kind],
        plan: withWallKind(plan, wall.id, kind),
      });
    }
  }
  // Only a regulation asks about the building; a developer's own rules speak for themselves.
  if (packForPlan(plan)?.kind !== "regulation") return experiments;
  const facts = plan.buildingFacts ?? {};
  const ask = (subject: string, current: string, answer: string, change: Partial<NonNullable<FloorPlan["buildingFacts"]>>) =>
    experiments.push({ subject, current, answer, plan: { ...plan, buildingFacts: { ...facts, ...change } } });
  for (const { key, label } of YES_NO_QUESTIONS) {
    const value = facts[key];
    const current = value === undefined ? UNKNOWN_ANSWER : value ? tr`Да` : tr`Нет`;
    for (const next of [true, false]) if (value !== next) ask(label, current, next ? tr`Да` : tr`Нет`, { [key]: next });
  }
  for (const level of ["first", "upper"] as const) {
    if (facts.floorLevel === level) continue;
    ask(FLOOR_LABEL, facts.floorLevel ? FLOOR_ANSWERS[facts.floorLevel] : UNKNOWN_ANSWER, FLOOR_ANSWERS[level], { floorLevel: level });
  }
  for (const side of ["below", "above"] as const) {
    const value = facts[side];
    for (const next of ["same-layout", "other-layout", "no-dwelling"] as const) {
      if (value === next) continue;
      ask(NEIGHBOUR_LABELS[side], value ? NEIGHBOUR_ANSWERS[value] : UNKNOWN_ANSWER, NEIGHBOUR_ANSWERS[next], { [side]: next });
    }
  }
  return experiments;
}

/** Runs the rules on each changed input: what moves is what the conclusion depends on. */
function dependencies(rules: RuleReport, experiments: readonly Experiment[]) {
  const baseline = new Map(rules.findings.map((finding) => [findingKey(finding), findingMark(finding)]));
  const dependsOn = new Map<string, Set<string>>();
  const alternatives: ProofAlternative[] = [];
  for (const experiment of experiments) {
    const other = rulesForPlan(experiment.plan);
    if (!other) continue;
    const marks = new Map(other.findings.map((finding) => [findingKey(finding), findingMark(finding)]));
    for (const finding of rules.findings) {
      const key = findingKey(finding);
      if (marks.get(key) === findingMark(finding)) continue;
      dependsOn.set(key, (dependsOn.get(key) ?? new Set()).add(`${experiment.subject}: ${experiment.current}`));
    }
    if (other.overall === rules.overall) continue;
    const fresh = other.findings.filter((finding) => baseline.get(findingKey(finding)) !== findingMark(finding));
    const named = (list: readonly RuleFinding[]) => list.filter((finding) => finding.procedure && finding.procedure === other.overall);
    // Either something new speaks, or what remains once the heavier reason has gone.
    const speaking = [named(fresh), named(other.findings), fresh.filter((finding) => finding.state === "problem")]
      .find((list) => list.length) ?? [];
    alternatives.push({
      subject: experiment.subject,
      current: experiment.current,
      answer: experiment.answer,
      procedure: other.overall,
      label: other.overall ? other.procedures[other.overall].label : tr`Порядок работ не назван`,
      because: [...new Set(speaking.map((finding) => finding.title))],
    });
  }
  return { dependsOn, alternatives };
}

const heaviest = (reasons: readonly ProofReason[]): Procedure | null =>
  PROCEDURE_ORDER.find((procedure) => reasons.some((reason) => reason.procedure === procedure)) ?? null;

function roomChanges(before: readonly RuleRoom[], after: readonly RuleRoom[]): ProofRoomChange[] {
  const names = [...new Set([...before, ...after].map((room) => room.name))];
  const areaOf = (rooms: readonly RuleRoom[], name: string) => rooms.find((room) => room.name === name)?.area ?? null;
  return names
    .map((name) => ({ name, before: areaOf(before, name), after: areaOf(after, name) }))
    .filter((row) => row.before === null || row.after === null || Math.abs(row.before - row.after) > 0.005);
}

const totalOf = (rooms: readonly RuleRoom[], unresolved?: string) =>
  unresolved ? null : rooms.filter((room) => countsInTotal(room.kind)).reduce((sum, room) => sum + room.area, 0);

export function buildPlanProof(
  plan: FloorPlan,
  meta: { generatedAt: string; appVersion: string; question?: string },
): PlanProof {
  const rules = rulesForPlan(plan);
  const report = buildPlanReport(plan, meta);
  const fingerprint = planFingerprint(plan);
  // A rule's finding is told in the chain; what is left is what the plan itself shows.
  const ruleTitles = new Set(rules?.findings.map((finding) => finding.title) ?? []);
  const checks = report.findings.filter((finding) => !ruleTitles.has(finding.title));
  const source = plan.origin ? { ...planFromOrigin(plan.origin), buildingFacts: plan.buildingFacts, ruleProfile: plan.ruleProfile } : null;
  const after = roomsOfPlan(plan);
  const before = source ? roomsOfPlan(source) : null;
  const drafts = source && before ? draftDecisions(source, plan, before.rooms) : [];
  const question = meta.question ?? plan.name;

  const { dependsOn, alternatives } = rules && source && drafts.length
    ? dependencies(rules, experimentsFor(plan, source))
    : { dependsOn: new Map<string, Set<string>>(), alternatives: [] };
  const reasonOf = (finding: RuleFinding): ProofReason => ({
    ruleId: finding.ruleId,
    title: finding.title,
    ...(finding.detail ? { detail: finding.detail } : {}),
    level: finding.level,
    ...(finding.procedure ? { procedure: finding.procedure } : {}),
    citation: rules ? citation(rules, finding) : "",
    dependsOn: [...(dependsOn.get(findingKey(finding)) ?? [])],
    decisive: Boolean(rules?.overall && finding.procedure === rules.overall),
  });

  const findings = rules?.findings ?? [];
  const tied = new Set<RuleFinding>();
  const decisions = drafts.map((draft): ProofDecision => {
    const own = findings.filter((finding) =>
      finding.wallIds?.some((id) => draft.wallIds.includes(id)) || finding.openingIds?.some((id) => draft.openingIds.includes(id)));
    own.forEach((finding) => tied.add(finding));
    const reasons = own.map(reasonOf);
    const procedure = heaviest(reasons);
    return { id: draft.id, text: draft.text, procedure, label: procedure && rules ? rules.procedures[procedure].label : null, reasons };
  });
  const free = findings.filter((finding) => !tied.has(finding));
  const general = free.filter((finding) => finding.state !== "ok").map(reasonOf);
  const passed = free.filter((finding) => finding.state === "ok").map(reasonOf);

  const wallTypes: FactLine[] = source
    ? (() => {
        const changes = wallChanges(source, plan);
        const owned = [...changes.removed, ...changes.moved.map((item) => item.before), ...changes.thickened.map((item) => item.before)];
        return owned.map((wall) => ({
          label: tr`Стена ${source.walls.findIndex((item) => item.id === wall.id) + 1}`,
          answer: WALL_KIND_NAMES[kindOf(wall)],
        }));
      })()
    : [];

  const status: ProofStatus = !drafts.length ? "no-decision" : rules ? "checked" : "no-rules";
  const overall = rules?.overall ?? null;
  const answer: PlanProof["answer"] = status === "no-decision"
    ? {
        procedure: null,
        label: tr`Решения нет`,
        meaning: source
          ? tr`В этом варианте нет изменений по сравнению с исходным планом, поэтому объяснять нечего.`
          : tr`Это исходный план, а не решение. Выберите стену в X-Ray или создайте вариант.`,
        citation: "",
      }
    : status === "no-rules"
      ? {
          procedure: null,
          label: tr`Нормы не проверялись`,
          meaning: tr`Для этого плана не выбрана база правил. Ответьте в X-Ray, где находится квартира, или задайте свои правила. Ниже только то, что следует из самого плана.`,
          citation: "",
        }
      : rules && overall
        ? {
            procedure: overall,
            label: rules.procedures[overall].label,
            meaning: rules.procedures[overall].meaning,
            citation: citation(rules, { sources: rules.procedures[overall].sources }),
          }
        : {
            procedure: null,
            label: tr`Порядок работ не назван`,
            meaning: tr`Правила этой базы не называют порядок работ для этих изменений. Это не значит, что они разрешены: значит только, что об этом здесь ничего не сказано.`,
            citation: "",
          };

  return {
    planName: plan.name,
    question,
    sourceName: plan.origin?.planName ?? null,
    generatedAt: meta.generatedAt,
    appVersion: meta.appVersion,
    status,
    answer,
    draftNote: rules?.kind === "regulation" && !rules.reviewed
      ? tr`Это черновик: база правил не сверена со специалистом, поэтому ни один вывод здесь не считается подтверждённым.`
      : null,
    decisions,
    general,
    passed,
    alternatives,
    wallTypes,
    facts: factLines(plan.buildingFacts),
    area: { before: before ? totalOf(before.rooms, before.unresolved) : null, after: totalOf(after.rooms, after.unresolved) },
    roomChanges: before ? roomChanges(before.rooms, after.rooms) : [],
    checks,
    limits: report.limits,
    fingerprint,
    rules: rules ? { version: rules.version, region: rules.region } : null,
  };
}
