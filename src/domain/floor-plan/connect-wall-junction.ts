import { assertPoint, wallLength } from "@/domain/geometry";
import { floorPlanSchema } from "./schema";
import type { FloorPlan } from "./types";
import {
  analyzeWallConnections,
  type WallConnectionDiagnostic,
} from "./wall-diagnostics";
import { rebaseOpenings, sameWallNode } from "./wall-nodes";

const EPSILON = 1e-9;
const STALE_CONNECTION =
  "Соединение изменилось. Выберите свободный конец заново.";

/**
 * Commits an explicitly chosen T-junction as one transaction. The target keeps
 * its orientation and first segment ID; openings retain their physical position
 * and ID. Openings of the joined wall stay anchored to its unmoved end. No
 * intermediate plan is exposed to validation, history or saving.
 */
export function connectWallJunction(
  plan: FloorPlan,
  diagnostic: WallConnectionDiagnostic,
  newWallId: string,
): FloorPlan {
  if (
    (diagnostic.kind !== "near-wall" && diagnostic.kind !== "junction") ||
    !diagnostic.target ||
    diagnostic.target.endpoint !== undefined
  ) {
    throw new Error("Т-соединение возможно только с серединой стены.");
  }
  if (
    (diagnostic.endpoint !== "start" && diagnostic.endpoint !== "end") ||
    diagnostic.wallId === diagnostic.target.wallId ||
    !Number.isFinite(diagnostic.distance) ||
    diagnostic.distance < 0 ||
    diagnostic.distance > 0.3
  ) {
    throw new Error("Некорректное Т-соединение стен.");
  }
  assertPoint(diagnostic.point);
  assertPoint(diagnostic.target.point);
  if (typeof newWallId !== "string" || newWallId.length < 1 || newWallId.length > 100) {
    throw new Error("Идентификатор новой стены должен содержать от 1 до 100 символов.");
  }
  if ([...plan.rooms, ...plan.walls, ...plan.openings].some((item) => item.id === newWallId)) {
    throw new Error("Идентификатор объекта уже существует.");
  }
  if (plan.walls.length >= 1000) {
    throw new Error("Нельзя разделить стену: в плане уже 1000 стен.");
  }

  const source = plan.walls.find((wall) => wall.id === diagnostic.wallId);
  const target = plan.walls.find((wall) => wall.id === diagnostic.target.wallId);
  if (!source || !target || !sameWallNode(source[diagnostic.endpoint], diagnostic.point)) {
    throw new Error(STALE_CONNECTION);
  }
  const current = analyzeWallConnections(plan.walls).find((item) =>
    item.wallId === source.id && item.endpoint === diagnostic.endpoint,
  );
  if (
    !current ||
    current.kind !== diagnostic.kind ||
    (current.kind !== "near-wall" && current.kind !== "junction") ||
    current.target.endpoint !== undefined ||
    current.target.wallId !== target.id ||
    !sameWallNode(current.target.point, diagnostic.target.point)
  ) {
    throw new Error(STALE_CONNECTION);
  }

  // Use the live projection, not the rounded distance or the snapshot point.
  const point = current.target.point;
  const length = wallLength(target.start, target.end);
  const splitDistance = Math.hypot(point.x - target.start.x, point.y - target.start.y);
  if (
    splitDistance <= EPSILON ||
    Math.hypot(target.end.x - point.x, target.end.y - point.y) <= EPSILON
  ) {
    throw new Error("Точка соединения слишком близко к концу стены.");
  }
  const other = source[diagnostic.endpoint === "start" ? "end" : "start"];
  const perpendicularDistance = Math.abs(
    (target.end.x - target.start.x) * (other.y - point.y) -
    (target.end.y - target.start.y) * (other.x - point.x),
  ) / length;
  if (perpendicularDistance <= EPSILON) {
    throw new Error("Т-соединение невозможно: стены лежат на одной прямой.");
  }

  const openings = plan.openings.map((opening) => {
    if (opening.wallId !== target.id) return opening;
    if (opening.offset + opening.width <= splitDistance + EPSILON) return opening;
    if (opening.offset >= splitDistance - EPSILON) {
      return {
        ...opening,
        wallId: newWallId,
        // Only sub-nanometre boundary roundoff may be clamped to zero.
        offset: Math.max(0, opening.offset - splitDistance),
      };
    }
    throw new Error("Точка соединения попадает внутрь проёма. Переместите конец стены или проём.");
  });
  const walls = plan.walls.map((wall) => {
    if (wall.id === source.id) return { ...wall, [diagnostic.endpoint]: { ...point } };
    if (wall.id === target.id) return { ...wall, end: { ...point } };
    return wall;
  });
  walls.push({ ...target, id: newWallId, start: { ...point } });

  const parsed = floorPlanSchema.safeParse({
    ...plan,
    walls,
    // The target keeps its start, so only the joined source wall can rebase.
    openings: [...rebaseOpenings(plan.walls, walls, openings)],
  });
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom");
    throw new Error(issue?.message ?? "Проверьте размеры, координаты и свойства стен.");
  }
  return parsed.data;
}
