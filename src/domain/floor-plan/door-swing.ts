import { tr } from "@/lib/i18n";
import { wallLength, type Point } from "@/domain/geometry";
import type { DoorSwing, Opening, Wall } from "./types";

/** Missing parameters retain the original start-hinged, left-opening symbol. */
export const DEFAULT_DOOR_SWING: Readonly<DoorSwing> = Object.freeze({
  hinge: "start",
  side: "left",
});

export interface DoorSwingGeometry {
  hinge: Point;
  closedEnd: Point;
  openEnd: Point;
  /** Quarter circle from the closed end to the fully open end. */
  arc: Point[];
  /** Exact bounds of the hinge, leaf and swept quarter circle. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const EPSILON = 1e-9;
const ARC_SEGMENTS = 32;

function checkedSwing(opening: Opening): DoorSwing {
  if (
    ![opening.offset, opening.width, opening.height, opening.sillHeight].every(
      Number.isFinite,
    ) ||
    opening.offset < 0 ||
    opening.width <= 0 ||
    opening.height <= 0 ||
    opening.sillHeight < 0
  ) {
    throw new Error(tr`Некорректные размеры двери.`);
  }
  const swing = opening.door ?? DEFAULT_DOOR_SWING;
  if (
    (swing.hinge !== "start" && swing.hinge !== "end") ||
    (swing.side !== "left" && swing.side !== "right")
  ) {
    throw new Error(tr`Некорректное направление открывания двери.`);
  }
  return swing;
}

/**
 * Each coordinate follows hinge + a*cos(t) + b*sin(t), 0 <= t <= PI/2.
 * Equal-sign coefficients have one interior extremum; opposite signs are
 * monotone. Include the hinge because bounds describe the entire swept sector.
 */
function coordinateBounds(origin: number, a: number, b: number): [number, number] {
  let min = Math.min(origin, origin + a, origin + b);
  let max = Math.max(origin, origin + a, origin + b);
  if (a > 0 && b > 0) max = origin + Math.hypot(a, b);
  if (a < 0 && b < 0) min = origin - Math.hypot(a, b);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(tr`Размер двери выходит за допустимые пределы.`);
  }
  return [min, max];
}

function geometry(
  hinge: Point,
  closed: Point,
  opened: Point,
): DoorSwingGeometry {
  const closedEnd = { x: hinge.x + closed.x, y: hinge.y + closed.y };
  const openEnd = { x: hinge.x + opened.x, y: hinge.y + opened.y };
  const [minX, maxX] = coordinateBounds(hinge.x, closed.x, opened.x);
  const [minY, maxY] = coordinateBounds(hinge.y, closed.y, opened.y);
  const arc = Array.from({ length: ARC_SEGMENTS + 1 }, (_, index) => {
    // Exact endpoints avoid cos(PI/2) noise drifting off the leaf.
    if (index === 0) return { ...closedEnd };
    if (index === ARC_SEGMENTS) return { ...openEnd };
    const angle = (index / ARC_SEGMENTS) * (Math.PI / 2);
    return {
      x: hinge.x + closed.x * Math.cos(angle) + opened.x * Math.sin(angle),
      y: hinge.y + closed.y * Math.cos(angle) + opened.y * Math.sin(angle),
    };
  });
  return { hinge, closedEnd, openEnd, arc, bounds: { minX, minY, maxX, maxY } };
}

/**
 * Coordinates relative to the opening start, in metres. Positive local X
 * follows the wall axis; positive local Y follows plan Y. Left is negative Y.
 */
export function doorSwingLocal(opening: Opening): DoorSwingGeometry | null {
  if (opening.kind === "window" || opening.doorless) return null;
  const swing = checkedSwing(opening);
  const hingeAtEnd = swing.hinge === "end";
  return geometry(
    { x: hingeAtEnd ? opening.width : 0, y: 0 },
    { x: hingeAtEnd ? -opening.width : opening.width, y: 0 },
    { x: 0, y: swing.side === "left" ? -opening.width : opening.width },
  );
}

/**
 * Plan coordinates for any wall direction. The opening offset remains measured
 * from wall.start even when a wall is reversed. Does not alter either object.
 */
export function doorSwingWorld(
  wall: Wall,
  opening: Opening,
): DoorSwingGeometry | null {
  if (opening.kind === "window" || opening.doorless) return null;
  const length = wallLength(wall.start, wall.end);
  if (
    ![wall.thickness, wall.height].every(Number.isFinite) ||
    wall.thickness <= 0 ||
    wall.height <= 0 ||
    opening.wallId !== wall.id
  ) {
    throw new Error(tr`Некорректная стена двери.`);
  }
  const local = doorSwingLocal(opening);
  if (!local) return null;
  if (
    opening.offset + opening.width > length + EPSILON ||
    opening.sillHeight + opening.height > wall.height + EPSILON
  ) {
    throw new Error(tr`Дверь выходит за границы стены.`);
  }
  const ux = (wall.end.x - wall.start.x) / length;
  const uy = (wall.end.y - wall.start.y) / length;
  const rotate = (point: Point): Point => ({
    x: point.x * ux - point.y * uy,
    y: point.x * uy + point.y * ux,
  });
  const hingeOffset = opening.offset + local.hinge.x;
  return geometry(
    {
      x: wall.start.x + hingeOffset * ux,
      y: wall.start.y + hingeOffset * uy,
    },
    rotate({
      x: local.closedEnd.x - local.hinge.x,
      y: local.closedEnd.y - local.hinge.y,
    }),
    rotate({
      x: local.openEnd.x - local.hinge.x,
      y: local.openEnd.y - local.hinge.y,
    }),
  );
}
