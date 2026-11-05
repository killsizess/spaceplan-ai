import { tr } from "@/lib/i18n";
import { assertPoint } from "@/domain/geometry";
import { floorPlanSchema } from "./schema";
import type { FloorPlan } from "./types";
import { analyzeWallIntersections, type WallIntersectionDiagnostic } from "./wall-intersections";
import { sameWallNode } from "./wall-nodes";

const EPSILON = 1e-9;
const STALE_INTERSECTION = tr`Пересечение изменилось. Выберите его заново.`;

/** Splits both live walls and transfers openings as a single validated edit. */
export function connectWallIntersection(
  plan: FloorPlan,
  diagnostic: WallIntersectionDiagnostic,
  newWallIds: readonly [string, string],
): FloorPlan {
  assertPoint(diagnostic.point);
  if (
    diagnostic.wallIds.length !== 2 ||
    diagnostic.wallIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 100) ||
    diagnostic.wallIds[0] === diagnostic.wallIds[1]
  ) throw new Error(tr`Некорректная пара пересекающихся стен.`);
  if (
    newWallIds.length !== 2 ||
    newWallIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 100)
  ) throw new Error(tr`Идентификаторы новых стен должны содержать от 1 до 100 символов.`);
  const existingIds = new Set([...plan.rooms, ...plan.walls, ...plan.openings].map((item) => item.id));
  if (newWallIds[0] === newWallIds[1] || newWallIds.some((id) => existingIds.has(id))) {
    throw new Error(tr`Идентификатор объекта уже существует.`);
  }
  if (plan.walls.length > 998) throw new Error(tr`Нельзя разделить стены: в плане будет больше 1000 стен.`);

  const pair = diagnostic.wallIds.map((id) => plan.walls.find((wall) => wall.id === id));
  if (!pair[0] || !pair[1]) throw new Error(STALE_INTERSECTION);
  const current = analyzeWallIntersections([pair[0], pair[1]]).intersections[0];
  if (
    !current ||
    current.wallIds[0] !== diagnostic.wallIds[0] || current.wallIds[1] !== diagnostic.wallIds[1] ||
    !sameWallNode(current.point, diagnostic.point)
  ) throw new Error(STALE_INTERSECTION);

  // Resolve against the live axes so sub-nanometre snapshot drift never rounds
  // the committed node. Both walls retain their orientation and original IDs.
  const point = current.point;
  for (const wall of plan.walls) {
    if (diagnostic.wallIds.includes(wall.id)) continue;
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dy);
    const t = ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / (length * length);
    if (
      t * length > EPSILON && (1 - t) * length > EPSILON &&
      Math.hypot(point.x - wall.start.x - t * dx, point.y - wall.start.y - t * dy) <= EPSILON
    ) {
      throw new Error(tr`В этой точке пересекаются больше двух стен. Сначала измените положение лишней стены.`);
    }
  }
  const splits = pair.map((wall, index) => {
    if (!wall) throw new Error(STALE_INTERSECTION);
    return {
      wall,
      downstreamId: newWallIds[index],
      distance: Math.hypot(point.x - wall.start.x, point.y - wall.start.y),
    };
  });
  const openings = plan.openings.map((opening) => {
    const split = splits.find((item) => item.wall.id === opening.wallId);
    if (!split) return opening;
    if (opening.offset + opening.width <= split.distance + EPSILON) return opening;
    if (opening.offset >= split.distance - EPSILON) {
      return {
        ...opening,
        wallId: split.downstreamId,
        offset: Math.max(0, opening.offset - split.distance),
      };
    }
    throw new Error(tr`Точка пересечения попадает внутрь проёма. Переместите стену или проём.`);
  });
  const walls = plan.walls.map((wall) => splits.some((split) => split.wall.id === wall.id)
    ? { ...wall, end: { ...point } }
    : wall,
  );
  for (const split of splits) {
    walls.push({ ...split.wall, id: split.downstreamId, start: { ...point } });
  }
  const parsed = floorPlanSchema.safeParse({ ...plan, walls, openings });
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom");
    throw new Error(issue?.message ?? tr`Проверьте размеры, координаты и свойства стен.`);
  }
  return parsed.data;
}
