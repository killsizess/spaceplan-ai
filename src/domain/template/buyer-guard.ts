import { planFromOrigin } from "@/domain/floor-plan/plan-origin";
import type { FloorPlan, Wall } from "@/domain/floor-plan/types";
import type { ResolvedWallRoom } from "@/domain/floor-plan/wall-room-labels";
import { openingChanges, wallChanges } from "@/domain/rules/plan-changes";
import { pointInRoom, sameShape } from "@/domain/rules/rule-rooms";
import { tr } from "@/lib/i18n";
import { baseWallOf, entranceDoorIds, fixedRoomIds, labelledRooms, wallLock } from "./locks";

/**
 * What a buyer may change is decided by comparing the result with the template, not by
 * watching which button was pressed: a drag, a form, a joint or a pasted file all end in a
 * plan, and the plan is what is checked. Nothing is refused silently: each refusal says why.
 */
export interface BuyerProblem {
  /** Which thing is wrong, so that only problems a change introduces are refused. */
  key: string;
  message: string;
}

/** The template as the buyer received it, with the answers and rules that apply now. */
export function buyerBase(plan: FloorPlan): FloorPlan | null {
  if (!plan.purchase || !plan.origin) return null;
  return { ...planFromOrigin(plan.origin), buildingFacts: plan.buildingFacts, ruleProfile: plan.ruleProfile, template: plan.template };
}

const SAMPLES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** A new wall stands inside the given rooms along its whole length, apart from its ends. */
function insideRooms(wall: Wall, rooms: readonly ResolvedWallRoom[]): boolean {
  return SAMPLES.every((share) => {
    const point = { x: wall.start.x + (wall.end.x - wall.start.x) * share, y: wall.start.y + (wall.end.y - wall.start.y) * share };
    return rooms.some((room) => pointInRoom(point, room));
  });
}

export function buyerProblems(plan: FloorPlan): BuyerProblem[] {
  const template = plan.template;
  const base = buyerBase(plan);
  if (!template || !base) return [];
  const problems: BuyerProblem[] = [];
  const baseRooms = labelledRooms(base);
  const lock = (wall: Wall) => wallLock(template, base, wall, baseRooms);
  const lockedWall = (wall: Wall | undefined, key: string) => {
    if (!wall) return;
    const state = lock(wall);
    if (state.locked) problems.push({ key, message: state.reason });
  };

  const walls = wallChanges(base, plan);
  for (const wall of walls.removed) lockedWall(wall, `wall:${wall.id}`);
  for (const { before } of [...walls.moved, ...walls.thickened]) lockedWall(before, `wall:${before.id}`);
  for (const { before } of walls.retyped) {
    problems.push({ key: `wall:${before.id}`, message: tr`Тип стены задаёт застройщик: покупатель его не меняет.` });
  }
  for (const wall of plan.walls) {
    const source = base.walls.find((item) => item.id === wall.id);
    if (source && Math.abs(source.height - wall.height) > 1e-9) lockedWall(source, `wall:${source.id}`);
  }
  const editableRooms = baseRooms.filter((room) => room.labelId && template.buyerRooms.includes(room.labelId));
  for (const wall of walls.added) {
    if (wall.kind !== "partition") {
      problems.push({ key: `new-wall:${wall.id}`, message: tr`Новая стена может быть только перегородкой: несущие стены покупатель не ставит.` });
    } else if (!insideRooms(wall, editableRooms)) {
      problems.push({ key: `new-wall:${wall.id}`, message: tr`Новую перегородку можно поставить только внутри помещений, которые застройщик разрешил менять.` });
    }
  }

  const entrance = entranceDoorIds(template);
  const hostIn = (owner: FloorPlan, wallId: string) => owner.walls.find((wall) => wall.id === wallId);
  const openings = openingChanges(base, plan);
  // A wall the buyer added has no source in the template and is theirs to change.
  const openingProblem = (key: string, id: string, host: Wall | undefined) => {
    if (entrance.has(id)) {
      problems.push({ key, message: tr`Входную дверь застройщик зафиксировал: её нельзя перенести, изменить или убрать.` });
      return;
    }
    const source = host && baseWallOf(base, host);
    const state = source && lock(source);
    if (state && state.locked) problems.push({ key, message: tr`Проём в стене, которую менять нельзя. ${state.reason}` });
  };
  for (const opening of openings.removed) openingProblem(`opening:${opening.id}`, opening.id, hostIn(base, opening.wallId));
  for (const { before, after } of openings.moved) {
    openingProblem(`opening:${before.id}`, before.id, hostIn(base, before.wallId));
    openingProblem(`opening:${before.id}`, before.id, hostIn(plan, after.wallId));
  }
  for (const opening of openings.added) {
    if (opening.kind === "window") {
      problems.push({ key: `opening:${opening.id}`, message: tr`Окна меняет только застройщик: они в наружных стенах и на фасаде.` });
      continue;
    }
    openingProblem(`opening:${opening.id}`, opening.id, hostIn(plan, opening.wallId));
  }

  // Fixed rooms stay exactly as they are; other rooms keep their parameters unless allowed.
  const planRooms = labelledRooms(plan);
  for (const id of fixedRoomIds(template)) {
    const before = baseRooms.find((room) => room.labelId === id);
    if (!before) continue;
    const after = planRooms.find((room) => room.labelId === id);
    if (!after || after.kind !== before.kind || after.name !== before.name || !sameShape(before, after)) {
      problems.push({ key: `room:${id}`, message: tr`«${before.name}» застройщик зафиксировал как мокрую зону или комнату со стояком: она остаётся как есть.` });
    }
  }
  const labels = new Map(plan.wallRoomLabels.map((label) => [label.id, label]));
  for (const label of base.wallRoomLabels) {
    if (template.buyerRooms.includes(label.id) || fixedRoomIds(template).has(label.id)) continue;
    const now = labels.get(label.id);
    if (!now || now.name !== label.name || now.kind !== label.kind) {
      problems.push({ key: `room:${label.id}`, message: tr`Застройщик не разрешил менять помещение «${label.name}».` });
    }
  }
  const baseLabels = new Set(base.wallRoomLabels.map((label) => label.id));
  for (const label of plan.wallRoomLabels) {
    if (baseLabels.has(label.id)) continue;
    if (!editableRooms.some((room) => pointInRoom(label.anchor, room))) {
      problems.push({ key: `new-room:${label.id}`, message: tr`Новое помещение можно выделить только из помещения, которое застройщик разрешил менять.` });
    }
  }
  return problems;
}

/** Parts of a plan only the developer sets, and what the buyer is told when trying. */
const DEVELOPER_FIELDS: readonly [keyof FloorPlan, () => string][] = [
  ["template", () => tr`Шаблон квартиры меняет только застройщик.`],
  ["purchase", () => tr`Шаблон квартиры меняет только застройщик.`],
  ["origin", () => tr`Шаблон квартиры меняет только застройщик.`],
  ["underlay", () => tr`Подложку задаёт застройщик.`],
  ["roomMode", () => tr`Способ расчёта помещений задаёт застройщик.`],
  ["ruleProfile", () => tr`Правила застройщика меняет только застройщик.`],
  ["rooms", () => tr`Помещения этого плана заданы стенами шаблона.`],
  ["recognition", () => tr`Эту часть плана задаёт застройщик.`],
];

/**
 * Null when a buyer's copy may change from `previous` to `next`; otherwise why not. Only
 * problems the change introduces count, so a template that already had one does not lock
 * the buyer out of everything.
 */
export function buyerChangeProblem(previous: FloorPlan, next: FloorPlan): string | null {
  if (!previous.purchase) return null;
  const same = (key: keyof FloorPlan) => JSON.stringify(previous[key] ?? null) === JSON.stringify(next[key] ?? null);
  const field = DEVELOPER_FIELDS.find(([key]) => !same(key));
  if (field) return field[1]();
  const known = new Set(buyerProblems(previous).map((problem) => problem.key));
  return buyerProblems(next).find((problem) => !known.has(problem.key))?.message ?? null;
}
