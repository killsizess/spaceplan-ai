import type { Point } from "@/domain/geometry";
import { floorPlanSchema, underlaySchema } from "./schema";
import type { FloorPlan, Opening, RoomMode, Underlay, Wall } from "./types";
import { previewWallUpdate, rebaseOpenings, type WallEndpoint } from "./wall-nodes";

function validatedPlan(plan: FloorPlan): FloorPlan {
  const parsed = floorPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom");
    throw new Error(
      issue?.message ?? "Проверьте размеры, координаты и свойства объекта.",
    );
  }
  return parsed.data;
}

function assertNewId(plan: FloorPlan, id: string): void {
  if (
    [...plan.rooms, ...plan.walls, ...plan.openings, ...plan.wallRoomLabels].some(
      (item) => item.id === id,
    )
  ) {
    throw new Error("Идентификатор объекта уже существует.");
  }
}

/** The inactive manual rooms remain available when switching calculation modes. */
export function setRoomMode(plan: FloorPlan, roomMode: RoomMode): FloorPlan {
  if (plan.roomMode === roomMode) return plan;
  return validatedPlan({ ...plan, roomMode });
}

export function addWall(plan: FloorPlan, wall: Wall): FloorPlan {
  assertNewId(plan, wall.id);
  return validatedPlan({ ...plan, walls: [...plan.walls, wall] });
}

export const MAX_PLAN_WALLS = 1000;

/** Adds accepted wall suggestions as one change: all of them or none. */
export function addWalls(plan: FloorPlan, walls: readonly Wall[]): FloorPlan {
  if (!walls.length) return plan;
  if (plan.walls.length + walls.length > MAX_PLAN_WALLS) {
    throw new Error(`В плане может быть не больше ${MAX_PLAN_WALLS} стен.`);
  }
  if (new Set(walls.map((wall) => wall.id)).size !== walls.length) {
    throw new Error("Идентификатор объекта уже существует.");
  }
  for (const wall of walls) assertNewId(plan, wall.id);
  return validatedPlan({ ...plan, walls: [...plan.walls, ...walls] });
}

/**
 * Moves shared endpoints together and validates all affected walls/openings
 * atomically. Openings stay anchored to the end of their wall that did not move.
 */
export function updateWall(
  plan: FloorPlan,
  wall: Wall,
  connectEndpoints = true,
): FloorPlan {
  const walls = previewWallUpdate(plan.walls, wall, connectEndpoints);
  if (walls === plan.walls) return plan;
  return validatedPlan({
    ...plan,
    walls: [...walls],
    openings: [...rebaseOpenings(plan.walls, walls, plan.openings)],
  });
}

export function moveWallNode(
  plan: FloorPlan,
  wallId: string,
  endpoint: WallEndpoint,
  point: Point,
  connectEndpoints = true,
): FloorPlan {
  if (endpoint !== "start" && endpoint !== "end")
    throw new Error("Некорректная вершина стены.");
  const wall = plan.walls.find((item) => item.id === wallId);
  if (!wall) throw new Error("Стена не найдена.");
  return updateWall(plan, { ...wall, [endpoint]: point }, connectEndpoints);
}

export function addOpening(plan: FloorPlan, opening: Opening): FloorPlan {
  assertNewId(plan, opening.id);
  return validatedPlan({ ...plan, openings: [...plan.openings, opening] });
}

export function updateOpening(plan: FloorPlan, opening: Opening): FloorPlan {
  if (!plan.openings.some((item) => item.id === opening.id))
    throw new Error("Проём не найден.");
  return validatedPlan({
    ...plan,
    openings: plan.openings.map((item) =>
      item.id === opening.id ? opening : item,
    ),
  });
}

/** Removing a wall removes its openings in the same undoable transaction. */
export function deleteObject(plan: FloorPlan, id: string): FloorPlan {
  if (
    ![...plan.rooms, ...plan.walls, ...plan.openings].some(
      (item) => item.id === id,
    )
  )
    return plan;
  return {
    ...plan,
    rooms: plan.rooms.filter((room) => room.id !== id),
    walls: plan.walls.filter((wall) => wall.id !== id),
    openings: plan.openings.filter(
      (opening) => opening.id !== id && opening.wallId !== id,
    ),
  };
}

export function setUnderlay(
  plan: FloorPlan,
  underlay: Underlay | null,
): FloorPlan {
  if (underlay === null) {
    if (!plan.underlay) return plan;
    const next = { ...plan };
    delete next.underlay;
    return next;
  }
  return validatedPlan({ ...plan, underlay });
}

/** Pixel anchors use the raster's native coordinates, independent of zoom. */
export function calibrateUnderlay(
  underlay: Underlay,
  startPixel: Point,
  endPixel: Point,
  knownMeters: number,
): Underlay {
  const valid = underlaySchema.safeParse(underlay);
  if (!valid.success) throw new Error("Некорректная подложка.");
  for (const point of [startPixel, endPixel]) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > underlay.pixelWidth ||
      point.y > underlay.pixelHeight
    ) {
      throw new Error("Обе точки масштаба должны находиться на подложке.");
    }
  }
  const pixelDistance = Math.hypot(
    endPixel.x - startPixel.x,
    endPixel.y - startPixel.y,
  );
  if (pixelDistance < 1)
    throw new Error(
      "Отметьте две разные точки на расстоянии не меньше одного пикселя.",
    );
  if (!Number.isFinite(knownMeters) || knownMeters <= 0 || knownMeters > 2000) {
    throw new Error("Известная длина должна быть больше 0 и не больше 2000 м.");
  }
  const metersPerPixel = knownMeters / pixelDistance;
  const result = underlaySchema.safeParse({
    ...valid.data,
    x: underlay.x + startPixel.x * (underlay.metersPerPixel - metersPerPixel),
    y: underlay.y + startPixel.y * (underlay.metersPerPixel - metersPerPixel),
    metersPerPixel,
    calibrated: true,
  });
  if (!result.success)
    throw new Error(
      "Этот масштаб выводит подложку за пределы ±1000 м. Уменьшите известную длину.",
    );
  return result.data;
}
