import { assertRectangle, wallLength } from "@/domain/geometry";
import type { FloorPlan, Opening, Wall } from "./types";
import { doorSwingWorld } from "./door-swing";
import { detectWallRooms } from "./wall-rooms";

/** Rendered room floors occupy the interval [-FLOOR_THICKNESS, 0] in metres. */
export const FLOOR_THICKNESS = 0.06;
const EPSILON = 1e-9;

/** A box in a wall's local coordinates, measured from start towards end. */
export interface WallSolid {
  wallId: string;
  offset: number;
  length: number;
  bottom: number;
  height: number;
  thickness: number;
}

export interface SpatialBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

function assertWall(wall: Wall): number {
  const length = wallLength(wall.start, wall.end);
  if (
    !Number.isFinite(wall.thickness) ||
    wall.thickness <= 0 ||
    !Number.isFinite(wall.height) ||
    wall.height <= 0
  ) {
    throw new Error(
      "Толщина и высота стены должны быть положительными числами.",
    );
  }
  return length;
}

/**
 * Subtracts openings from a wall without triangulation or a rendering library.
 * Openings follow the model's rule: horizontal intervals may touch, but cannot
 * overlap, even if their vertical intervals do not intersect.
 */
export function buildWallSolids(
  wall: Wall,
  openings: readonly Opening[],
): WallSolid[] {
  const length = assertWall(wall);
  const wallOpenings = openings.filter((opening) => opening.wallId === wall.id);

  for (const opening of wallOpenings) {
    if (
      ![
        opening.offset,
        opening.width,
        opening.sillHeight,
        opening.height,
      ].every(Number.isFinite) ||
      opening.offset < 0 ||
      opening.sillHeight < 0 ||
      opening.width <= 0 ||
      opening.height <= 0
    ) {
      throw new Error("Некорректные размеры проёма.");
    }
    if (
      opening.offset + opening.width > length + EPSILON ||
      opening.sillHeight + opening.height > wall.height + EPSILON
    ) {
      throw new Error("Проём выходит за границы стены.");
    }
  }

  wallOpenings.sort((first, second) => first.offset - second.offset);
  const solids: WallSolid[] = [];
  const append = (
    offset: number,
    segmentLength: number,
    bottom: number,
    height: number,
  ) => {
    if (segmentLength <= EPSILON || height <= EPSILON) return;
    solids.push({
      wallId: wall.id,
      offset,
      length: segmentLength,
      bottom,
      height,
      thickness: wall.thickness,
    });
  };

  let cursor = 0;
  for (const opening of wallOpenings) {
    if (opening.offset < cursor - EPSILON) {
      throw new Error("Проёмы на одной стене не должны перекрываться.");
    }
    // Clamp floating-point boundary noise accepted by the model validation.
    const start = Math.max(cursor, opening.offset);
    const end = Math.min(length, opening.offset + opening.width);
    const top = Math.min(wall.height, opening.sillHeight + opening.height);
    append(cursor, start - cursor, 0, wall.height);
    append(start, end - start, 0, opening.sillHeight);
    append(start, end - start, top, wall.height - top);
    cursor = Math.max(cursor, end);
  }
  append(cursor, length - cursor, 0, wall.height);
  return solids;
}

/**
 * Bounds of floors, wall envelopes and swinging doors: plan x → scene X, plan y → scene Z,
 * elevation → scene Y. The raster underlay never changes the 3D camera bounds.
 */
export function spatialBounds(plan: FloorPlan): SpatialBounds {
  const rooms = plan.roomMode === "manual" ? plan.rooms : [];
  if (rooms.length === 0 && plan.walls.length === 0) {
    return { minX: -4, maxX: 4, minZ: -4, maxZ: 4, minY: 0, maxY: 2.7 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = 0;

  for (const room of rooms) {
    assertRectangle(room);
    minX = Math.min(minX, room.x);
    maxX = Math.max(maxX, room.x + room.width);
    minZ = Math.min(minZ, room.y);
    maxZ = Math.max(maxZ, room.y + room.height);
  }

  for (const wall of plan.walls) {
    const length = assertWall(wall);
    // Axis projections of the half-thickness normal to the wall centre line.
    const halfX =
      (Math.abs(wall.end.y - wall.start.y) / length) * (wall.thickness / 2);
    const halfZ =
      (Math.abs(wall.end.x - wall.start.x) / length) * (wall.thickness / 2);
    minX = Math.min(minX, wall.start.x - halfX, wall.end.x - halfX);
    maxX = Math.max(maxX, wall.start.x + halfX, wall.end.x + halfX);
    minZ = Math.min(minZ, wall.start.y - halfZ, wall.end.y - halfZ);
    maxZ = Math.max(maxZ, wall.start.y + halfZ, wall.end.y + halfZ);
    maxY = Math.max(maxY, wall.height);
  }

  const wallsById = new Map(plan.walls.map((wall) => [wall.id, wall]));
  for (const opening of plan.openings) {
    if (opening.kind !== "door") continue;
    const wall = wallsById.get(opening.wallId);
    if (!wall) throw new Error("Стена двери не найдена.");
    const swing = doorSwingWorld(wall, opening);
    if (!swing) continue;
    // Include the finite 3D leaf thickness as well as the nominal swept sector.
    const padding = Math.min(0.045, wall.thickness * 0.32, opening.width * 0.1) / 2;
    minX = Math.min(minX, swing.bounds.minX - padding);
    maxX = Math.max(maxX, swing.bounds.maxX + padding);
    minZ = Math.min(minZ, swing.bounds.minY - padding);
    maxZ = Math.max(maxZ, swing.bounds.maxY + padding);
  }

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    minY: (
      plan.roomMode === "walls"
        ? detectWallRooms(plan.walls).rooms.length > 0
        : rooms.length > 0
    )
      ? -FLOOR_THICKNESS
      : 0,
    maxY,
  };
}
