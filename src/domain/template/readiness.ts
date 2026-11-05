import type { ApartmentTemplate, ConfirmedOpening, ConfirmedWall, FloorPlan, Wall } from "@/domain/floor-plan/types";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import { openingCenter } from "@/domain/accuracy/recognition-accuracy";
import { packForPlan } from "@/domain/rules/engine";
import { tr } from "@/lib/i18n";
import { baseWallOf, entranceDoorIds, fixedRoomIds, labelledRooms } from "./locks";

export const emptyTemplate = (): ApartmentTemplate => ({ fixed: [], buyerWalls: [], buyerRooms: [] });

/** What the developer confirms: the walls and openings as they stand now. */
export function confirmationOf(plan: FloorPlan, at: string): NonNullable<ApartmentTemplate["confirmed"]> {
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  return {
    at,
    walls: plan.walls.map(({ id, start, end, thickness }) => ({ id, start, end, thickness })),
    openings: plan.openings.flatMap((opening) => {
      const host = walls.get(opening.wallId);
      return host ? [{ id: opening.id, kind: opening.kind, center: openingCenter(host, opening.offset, opening.width), width: opening.width }] : [];
    }),
  };
}

const MILLIMETRE = 0.001;
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) <= MILLIMETRE;
const sameWall = (wall: Wall, confirmed: ConfirmedWall) =>
  Math.abs(wall.thickness - confirmed.thickness) <= MILLIMETRE &&
  ((close(wall.start, confirmed.start) && close(wall.end, confirmed.end)) || (close(wall.start, confirmed.end) && close(wall.end, confirmed.start)));

/**
 * Walls that differ from what was confirmed: new, moved, re-sized, or gone. A piece of a
 * confirmed wall split by a joint is still confirmed.
 */
export function unconfirmedWalls(plan: FloorPlan, template: ApartmentTemplate): { changed: Wall[]; removed: ConfirmedWall[] } {
  const confirmed = template.confirmed;
  if (!confirmed) return { changed: plan.walls, removed: [] };
  const asPlan = { walls: confirmed.walls.map((wall) => ({ ...wall, height: 1 })) };
  const changed = plan.walls.filter((wall) => {
    const match = confirmed.walls.find((item) => item.id === wall.id);
    if (match) return !sameWall(wall, match);
    return !baseWallOf(asPlan, wall);
  });
  const present = (item: ConfirmedWall) =>
    plan.walls.some((wall) => wall.id === item.id) ||
    plan.walls.some((wall) => baseWallOf({ walls: [{ ...item, height: 1 }] }, wall));
  return { changed, removed: confirmed.walls.filter((item) => !present(item)) };
}

export type IssueSeverity = "blocker" | "warning";

export interface TemplateIssue {
  id: string;
  severity: IssueSeverity;
  title: string;
  /** What to do about it. */
  fix: string;
  /** Walls, openings or rooms to show on the plan. */
  targets: string[];
}

export interface TemplateReadiness {
  /** No blockers: the template can be offered to a buyer. */
  ready: boolean;
  issues: TemplateIssue[];
  counts: { walls: number; unknownWalls: number; buyerWalls: number; buyerRooms: number; fixed: number };
}

const number = (plan: FloorPlan, id: string) => plan.walls.findIndex((wall) => wall.id === id) + 1;
const list = (plan: FloorPlan, walls: readonly { id: string }[]) => {
  const numbers = walls.map((wall) => number(plan, wall.id)).filter(Boolean);
  const shown = numbers.slice(0, 12).join(", ");
  return numbers.length > 12 ? tr`${shown} и ещё ${numbers.length - 12}` : shown;
};

/**
 * Whether a template can go to a buyer, and what to fix if not. A blocker makes the buyer's
 * conclusions unreliable or the buyer's choices undefined; a warning leaves them thinner.
 */
export function templateReadiness(plan: FloorPlan, template: ApartmentTemplate = plan.template ?? emptyTemplate()): TemplateReadiness {
  const issues: TemplateIssue[] = [];
  const blocker = (id: string, title: string, fix: string, targets: string[] = []) => issues.push({ id, severity: "blocker", title, fix, targets });
  const warning = (id: string, title: string, fix: string, targets: string[] = []) => issues.push({ id, severity: "warning", title, fix, targets });

  // Rooms must be closed outlines of walls: rules, areas and the buyer's choices rest on them.
  let unassigned: string[] = [];
  if (plan.roomMode !== "walls") {
    blocker("rooms-manual", tr`Помещения заданы вручную, а не стенами`, tr`Включите «По стенам» на вкладке «Комнаты» и обведите стены: покупатель меняет стены, а не прямоугольники.`);
  } else if (!plan.walls.length) {
    blocker("no-walls", tr`На плане нет стен`, tr`Загрузите чертёж и примите найденные стены или нарисуйте их.`);
  } else {
    try {
      const resolution = resolveWallRoomLabels(plan);
      if (!resolution.rooms.length) {
        blocker("no-rooms", tr`Нет ни одного замкнутого помещения`, tr`Соедините концы стен, чтобы контуры комнат замкнулись: проверка плана покажет разрывы.`);
      }
      unassigned = resolution.unassigned.map((label) => label.name);
    } catch (error) {
      blocker("rooms-unresolved", tr`Помещения не определяются`, error instanceof Error ? error.message : tr`Проверьте соединения стен.`);
    }
  }
  if (unassigned.length) {
    blocker("rooms-open", tr`Комнаты без замкнутого контура: ${unassigned.join(", ")}`, tr`Контур этих комнат разомкнут или изменился. Замкните стены и привяжите параметры заново на вкладке «Комнаты».`);
  }
  const open = plan.walls.length ? analyzeWallConnections(plan.walls).filter((item) => item.kind !== "junction") : [];
  if (open.length) {
    warning("free-ends", tr`Свободных концов стен: ${open.length}`, tr`Контур может быть незамкнут. Проверьте их на вкладке «Стены» или в проверке плана.`, [...new Set(open.map((item) => item.wallId))]);
  }

  // Wall types: an unknown one may be bearing, so nothing about it can be concluded.
  const unknown = plan.walls.filter((wall) => (wall.kind ?? "unknown") === "unknown");
  if (unknown.length) {
    blocker("unknown-walls", tr`Тип не указан у стен: ${list(plan, unknown)}`, tr`Укажите для каждой стены «несущая» или «перегородка» по проектной документации. Пока тип неизвестен, вывода об изменении стены не будет.`, unknown.map((wall) => wall.id));
  }

  // The walls must be the ones on the drawing, as the developer checked them.
  if (!template.confirmed) {
    blocker("not-confirmed", tr`Стены и проёмы не подтверждены`, tr`Сверьте их с чертежом и нажмите «Подтвердить стены и проёмы».`);
  } else {
    const { changed, removed } = unconfirmedWalls(plan, template);
    if (changed.length || removed.length) {
      const changedText = changed.length ? tr`изменены или добавлены: ${list(plan, changed)}` : "";
      const removedText = removed.length ? tr`удалено: ${removed.length}` : "";
      blocker("changed-after-confirmation", tr`Стены изменены после подтверждения (${[changedText, removedText].filter(Boolean).join("; ")})`, tr`Сверьте изменения с чертежом и подтвердите стены заново.`, changed.map((wall) => wall.id));
    }
  }

  // Fixed elements: without them nothing protects wet zones, risers or the entrance.
  const rooms = labelledRooms(plan);
  const labels = new Set(plan.wallRoomLabels.map((label) => label.id));
  const openings = new Set(plan.openings.map((opening) => opening.id));
  const fixed = template.fixed.filter((item) => (item.kind === "entrance-door" ? openings.has(item.openingId) : labels.has(item.roomLabelId)));
  if (!fixed.length) {
    blocker("no-fixed", tr`Не отмечены фиксированные элементы`, tr`Отметьте мокрые зоны, комнаты со стояками и входную дверь: покупатель не сможет их менять.`);
  }
  const stale = template.fixed.length - fixed.length;
  if (stale) warning("fixed-stale", tr`Фиксированных элементов, которых больше нет на плане: ${stale}`, tr`Они не учитываются. Отметьте элементы заново.`);
  if (!entranceDoorIds({ ...template, fixed }).size) {
    warning("no-entrance", tr`Не отмечена входная дверь`, tr`Отметьте её: иначе покупатель сможет её перенести.`);
  }
  const fixedRooms = fixedRoomIds({ ...template, fixed });
  const wetRooms = rooms.filter((room) => (room.kind === "bathroom" || room.kind === "kitchen") && !(room.labelId && fixedRooms.has(room.labelId)));
  if (wetRooms.length) {
    warning("wet-not-fixed", tr`Мокрые зоны не зафиксированы: ${wetRooms.map((room) => room.name).join(", ")}`, tr`Если санузел или кухню переносить нельзя, отметьте их как фиксированные.`);
  }

  // What the buyer may change.
  const buyerWalls = template.buyerWalls.filter((id) => plan.walls.some((wall) => wall.id === id && wall.kind === "partition"));
  if (!buyerWalls.length) {
    warning("nothing-to-change", tr`Покупателю не разрешено менять ни одну стену`, tr`Отметьте перегородки, которые покупатель может переносить или убирать.`);
  }
  const notPartitions = template.buyerWalls.filter((id) => plan.walls.some((wall) => wall.id === id && wall.kind !== "partition"));
  if (notPartitions.length) {
    warning("buyer-not-partition", tr`Среди разрешённых покупателю стен есть не перегородки: ${notPartitions.length}`, tr`Покупатель всё равно не сможет их менять: менять можно только перегородки.`, notPartitions);
  }

  // Answers about the building and a rule base: without them conclusions are thin.
  if (!packForPlan(plan)) {
    warning("no-rules", tr`Не выбраны нормы`, tr`В X-Ray укажите, где квартира, или задайте правила своими словами: иначе покупатель увидит только геометрию.`);
  }
  return {
    ready: !issues.some((issue) => issue.severity === "blocker"),
    issues,
    counts: { walls: plan.walls.length, unknownWalls: unknown.length, buyerWalls: buyerWalls.length, buyerRooms: template.buyerRooms.length, fixed: fixed.length },
  };
}

/** Wet zones the developer can fix in one go: rooms used as kitchens and bathrooms. */
export function suggestedWetZones(plan: FloorPlan): string[] {
  return labelledRooms(plan).flatMap((room) => ((room.kind === "bathroom" || room.kind === "kitchen") && room.labelId ? [room.labelId] : []));
}

/** Partitions that do not bound a fixed room: what a buyer could reasonably be allowed. */
export function suggestedBuyerWalls(plan: FloorPlan, template: ApartmentTemplate): string[] {
  const fixed = fixedRoomIds(template);
  const rooms = labelledRooms(plan);
  return plan.walls
    .filter((wall) => wall.kind === "partition")
    .filter((wall) => !rooms.some((room) => room.labelId && fixed.has(room.labelId) && room.boundaryWallIds.includes(wall.id)))
    .map((wall) => wall.id);
}

export type { ConfirmedOpening };
