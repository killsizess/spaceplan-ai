import { assertPoint } from "@/domain/geometry";
import { moveWallNode } from "./construction";
import type { FloorPlan } from "./types";
import {
  analyzeWallConnections,
  type WallConnectionDiagnostic,
} from "./wall-diagnostics";
import { sameWallNode } from "./wall-nodes";

const STALE_CONNECTION =
  "Соединение изменилось. Выберите свободный конец заново.";

/**
 * Joins one free endpoint to the nearest endpoint from an explicit diagnostic
 * snapshot. Rechecking both coordinates and the current nearest candidate makes
 * a delayed command safe; mid-wall contacts never split or modify other walls.
 */
export function connectWallEndpoints(
  plan: FloorPlan,
  diagnostic: WallConnectionDiagnostic,
): FloorPlan {
  if (
    diagnostic.kind !== "near-endpoint" ||
    !diagnostic.target ||
    (diagnostic.target.endpoint !== "start" && diagnostic.target.endpoint !== "end")
  ) {
    throw new Error("Можно соединить только два близких конца стен.");
  }
  if (
    (diagnostic.endpoint !== "start" && diagnostic.endpoint !== "end") ||
    diagnostic.wallId === diagnostic.target.wallId ||
    !Number.isFinite(diagnostic.distance) ||
    diagnostic.distance < 0 ||
    diagnostic.distance > 0.3
  ) {
    throw new Error("Некорректное соединение концов стен.");
  }
  assertPoint(diagnostic.point);
  assertPoint(diagnostic.target.point);

  const source = plan.walls.find((wall) => wall.id === diagnostic.wallId);
  const target = plan.walls.find((wall) => wall.id === diagnostic.target.wallId);
  if (
    !source ||
    !target ||
    !sameWallNode(source[diagnostic.endpoint], diagnostic.point) ||
    !sameWallNode(target[diagnostic.target.endpoint], diagnostic.target.point)
  ) {
    throw new Error(STALE_CONNECTION);
  }

  const current = analyzeWallConnections(plan.walls).find((item) =>
    item.wallId === diagnostic.wallId && item.endpoint === diagnostic.endpoint,
  );
  if (
    !current ||
    current.kind !== "near-endpoint" ||
    current.target.wallId !== diagnostic.target.wallId ||
    current.target.endpoint !== diagnostic.target.endpoint ||
    !sameWallNode(current.target.point, diagnostic.target.point)
  ) {
    throw new Error(STALE_CONNECTION);
  }

  // Use the live exact endpoint, never a rounded distance or snapshot value.
  return moveWallNode(
    plan,
    source.id,
    diagnostic.endpoint,
    target[diagnostic.target.endpoint],
  );
}
