import { gridSpacing, snapToGrid } from "@/lib/units";
import type { Opening, Underlay, Wall } from "@/domain/floor-plan/types";
import { doorSwingWorld } from "@/domain/floor-plan/door-swing";
import { sameWallNode } from "@/domain/floor-plan/wall-nodes";
import type { Point, Rectangle } from "@/domain/geometry";

export { snapToGrid };

export interface GridLine {
  /** Screen coordinate across the line's axis. */
  position: number;
  /** The line falls on a whole metre. */
  major: boolean;
}

/**
 * Background grid lines for the visible screen area. The step is 0.5 m, coarsened by
 * powers of ten so lines never come closer than 16 px when zoomed far out.
 */
export function gridLines(
  camera: Point,
  scale: number,
  size: { width: number; height: number },
): { vertical: GridLine[]; horizontal: GridLine[] } {
  const vertical: GridLine[] = [], horizontal: GridLine[] = [];
  if (!(size.width > 0) || !(scale > 0)) return { vertical, horizontal };
  // Half a metre with a line each metre, or a foot with a line each five feet.
  const { step: unit, major: every } = gridSpacing();
  const step = scale * unit * 10 ** Math.max(0, Math.ceil(Math.log10(16 / (scale * unit))));
  const axis = (origin: number, extent: number, out: GridLine[]) => {
    for (let position = ((origin % step) + step) % step; position < extent; position += step) {
      const majors = (position - origin) / scale / (unit * every);
      out.push({ position, major: Math.abs(majors - Math.round(majors)) < 0.01 });
    }
  };
  axis(camera.x, size.width, vertical);
  axis(camera.y, size.height, horizontal);
  return { vertical, horizontal };
}

/** Solid stretches of a wall between its openings, in metres from the wall start. */
export function wallSolidSegments(
  length: number,
  openings: readonly Pick<Opening, "offset" | "width">[],
): { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const opening of [...openings].sort((a, b) => a.offset - b.offset)) {
    if (opening.offset > cursor) segments.push({ start: cursor, end: opening.offset });
    cursor = Math.max(cursor, opening.offset + opening.width);
  }
  if (cursor < length) segments.push({ start: cursor, end: length });
  return segments;
}

/** Endpoint magnet uses a screen-space radius at every zoom level. */
export function snapWallPoint(
  point: Point,
  walls: readonly Wall[],
  scale: number,
  excludedNode?: Point,
): Point {
  let closest: Point | null = null;
  let distance = 10 / scale;
  for (const wall of walls) {
    for (const endpoint of [wall.start, wall.end]) {
      // Every coincident endpoint belongs to the moving node, not a snap target.
      if (excludedNode && sameWallNode(endpoint, excludedNode)) continue;
      const candidate = Math.hypot(point.x - endpoint.x, point.y - endpoint.y);
      if (candidate < distance) {
        closest = endpoint;
        distance = candidate;
      }
    }
  }
  return closest ?? { x: snapToGrid(point.x), y: snapToGrid(point.y) };
}

/**
 * Distance along a wall (from its start, metres) for the move handle: the point
 * closest to the middle that keeps `margin` from the wall ends and from every
 * obstacle interval (T-junctions as zero-width intervals, openings by extent).
 * Falls back to the middle when no such point exists.
 */
export function moveHandleOffset(
  length: number,
  obstacles: readonly (readonly [number, number])[],
  margin: number,
): number {
  const middle = length / 2;
  if (!(length > 0) || !(margin >= 0)) return middle;
  const blocked = [
    [-Infinity, margin] as const,
    [length - margin, Infinity] as const,
    ...obstacles.map(([from, to]) => [Math.min(from, to) - margin, Math.max(from, to) + margin] as const),
  ].sort((a, b) => a[0] - b[0]);
  let best: number | null = null;
  let cursor = -Infinity;
  for (const [from, to] of blocked) {
    if (from > cursor && Number.isFinite(cursor)) {
      const point = Math.min(Math.max(middle, cursor), from);
      if (best === null || Math.abs(point - middle) < Math.abs(best - middle)) best = point;
    }
    cursor = Math.max(cursor, to);
  }
  return best ?? middle;
}

/** Offset is the projected distance from the wall start, in metres. */
export function findWallAt(
  point: Point,
  walls: readonly Wall[],
  scale: number,
) {
  let nearest: { wall: Wall; offset: number; distance: number } | null = null;
  for (const wall of walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    const offset = Math.max(
      0,
      Math.min(
        length,
        ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) /
          length,
      ),
    );
    const distance = Math.hypot(
      point.x - wall.start.x - (dx * offset) / length,
      point.y - wall.start.y - (dy * offset) / length,
    );
    if (
      distance <= Math.max(12 / scale, wall.thickness / 2) &&
      (!nearest || distance < nearest.distance)
    ) {
      nearest = { wall, offset, distance };
    }
  }
  return nearest;
}

/** Calibration deliberately keeps subpixel precision and ignores the grid. */
export function underlayPixelAt(
  point: Point,
  underlay: Underlay,
): Point | null {
  const x = (point.x - underlay.x) / underlay.metersPerPixel;
  const y = (point.y - underlay.y) / underlay.metersPerPixel;
  if (x < 0 || y < 0 || x > underlay.pixelWidth || y > underlay.pixelHeight)
    return null;
  return { x, y };
}

export function planBounds(
  rooms: readonly Rectangle[],
  walls: readonly Wall[],
  underlay?: Underlay,
  openings: readonly Opening[] = [],
): Rectangle[] {
  const rectangles = [...rooms];
  for (const wall of walls) {
    rectangles.push({
      x: Math.min(wall.start.x, wall.end.x) - wall.thickness / 2,
      y: Math.min(wall.start.y, wall.end.y) - wall.thickness / 2,
      width: Math.abs(wall.end.x - wall.start.x) + wall.thickness,
      height: Math.abs(wall.end.y - wall.start.y) + wall.thickness,
    });
  }
  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  for (const opening of openings) {
    const wall = wallsById.get(opening.wallId);
    const swing = wall ? doorSwingWorld(wall, opening) : null;
    if (swing) rectangles.push({
      x: swing.bounds.minX, y: swing.bounds.minY,
      width: swing.bounds.maxX - swing.bounds.minX,
      height: swing.bounds.maxY - swing.bounds.minY,
    });
  }
  if (underlay?.visible) {
    rectangles.push({
      x: underlay.x,
      y: underlay.y,
      width: underlay.pixelWidth * underlay.metersPerPixel,
      height: underlay.pixelHeight * underlay.metersPerPixel,
    });
  }
  return rectangles;
}

/** The interface font on the plan too; the rest of the stack applies until it has loaded. */
export const CANVAS_FONT = '"Onest Variable", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
