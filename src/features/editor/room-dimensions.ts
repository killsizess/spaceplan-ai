import { tr } from "@/lib/i18n";
import { lengthText, sizeText } from "@/lib/units";
import type { Point } from "@/domain/geometry";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";

const EPSILON = 1e-7;
type RoomContour = Pick<WallRoom, "outer" | "holes" | "bounds" | "area">;

export interface DimensionLabel {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  rotation: number;
}

export type RoomDimensionLayout = {
  width: number;
  depth: number;
} & (
  | {
      kind: "lines";
      segments: number[][];
      horizontalLabel: DimensionLabel;
      verticalLabel: DimensionLabel;
      caption: DimensionLabel;
      strokeWidth: number;
    }
  | { kind: "compact"; label: DimensionLabel }
);

const close = (a: number, b: number) => Math.abs(a - b) <= EPSILON;
const same = (a: Point, b: Point) => close(a.x, b.x) && close(a.y, b.y);

/** Remove only redundant vertices on a straight edge, never a backtracking edge. */
function corners(outer: readonly Point[]): Point[] {
  const points = outer.slice();
  if (points.length > 1 && same(points[0], points[points.length - 1])) points.pop();
  let changed = true;
  while (changed && points.length > 4) {
    changed = false;
    for (let index = 0; index < points.length; index++) {
      const before = points[(index + points.length - 1) % points.length];
      const point = points[index];
      const after = points[(index + 1) % points.length];
      const vertical = close(before.x, point.x) && close(point.x, after.x);
      const horizontal = close(before.y, point.y) && close(point.y, after.y);
      const between =
        point.x >= Math.min(before.x, after.x) - EPSILON &&
        point.x <= Math.max(before.x, after.x) + EPSILON &&
        point.y >= Math.min(before.y, after.y) - EPSILON &&
        point.y <= Math.max(before.y, after.y) + EPSILON;
      if ((vertical || horizontal) && between) {
        points.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return points;
}

/** Only real rectangular interior contours can have one unambiguous width/depth pair. */
function rectangle(room: RoomContour): { width: number; depth: number } | null {
  if (
    room.holes.length ||
    room.outer.length < 4 ||
    room.outer.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  ) return null;
  const { minX, minY, maxX, maxY } = room.bounds;
  if (![minX, minY, maxX, maxY, room.area].every(Number.isFinite)) return null;
  const width = maxX - minX;
  const depth = maxY - minY;
  if (width <= EPSILON || depth <= EPSILON || room.area <= 0) return null;
  if (Math.abs(width * depth - room.area) > Math.max(EPSILON, width * depth * 1e-8)) return null;
  const points = corners(room.outer);
  if (points.length !== 4) return null;
  const visited = new Set<string>();
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const sideX = close(point.x, minX) ? 0 : close(point.x, maxX) ? 1 : -1;
    const sideY = close(point.y, minY) ? 0 : close(point.y, maxY) ? 1 : -1;
    if (sideX < 0 || sideY < 0 || same(point, next)) return null;
    // Diagonals, bow-ties and rotated rectangles cannot be labelled from their bounds.
    if (!close(point.x, next.x) && !close(point.y, next.y)) return null;
    visited.add(`${sideX}:${sideY}`);
  }
  return visited.size === 4 ? { width, depth } : null;
}

/** World-space overlay derived from the inner room face; rendering never changes model data. */
export function getRoomDimensionLayout(
  room: RoomContour,
  scale: number,
): RoomDimensionLayout | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const size = rectangle(room);
  if (!size) return null;
  const { width, depth } = size;
  const screenWidth = width * scale;
  const screenDepth = depth * scale;
  if (!Number.isFinite(screenWidth) || !Number.isFinite(screenDepth)) return null;
  if (screenWidth < 112 || screenDepth < 82) return null;
  const { minX, minY, maxX, maxY } = room.bounds;
  const centerX = minX + width / 2;
  const centerY = minY + depth / 2;
  const px = (value: number) => value / scale;
  const widthText = lengthText(width);
  const depthText = lengthText(depth);
  if (screenWidth < 160 || screenDepth < 120) {
    const text = tr`${sizeText(width, depth)} внутри`;
    // A conservative text width avoids wrapping/cutting a dimension at small zoom.
    if (text.length * 6 > screenWidth - 12) return null;
    return {
      kind: "compact",
      ...size,
      label: {
        x: minX + px(6),
        y: maxY - px(22),
        width: width - px(12),
        height: px(12),
        text,
        fontSize: px(10),
        rotation: 0,
      },
    };
  }
  const horizontalY = minY + px(22);
  const verticalX = maxX - px(22);
  const horizontalTextWidth = px(widthText.length * 6 + 10);
  const verticalTextWidth = px(depthText.length * 6 + 10);
  const horizontalGap = horizontalTextWidth / 2 + px(3);
  const verticalGap = verticalTextWidth / 2 + px(3);
  const segments = [
    [minX, horizontalY, centerX - horizontalGap, horizontalY],
    [centerX + horizontalGap, horizontalY, maxX, horizontalY],
    [verticalX, minY, verticalX, centerY - verticalGap],
    [verticalX, centerY + verticalGap, verticalX, maxY],
    [minX, minY + px(3), minX, horizontalY + px(5)],
    [maxX, minY + px(3), maxX, horizontalY + px(5)],
    [maxX - px(3), minY, verticalX - px(5), minY],
    [maxX - px(3), maxY, verticalX - px(5), maxY],
  ];
  // Short diagonal ticks make each inner face endpoint explicit at any zoom.
  for (const [x, y] of [
    [minX, horizontalY], [maxX, horizontalY],
    [verticalX, minY], [verticalX, maxY],
  ]) segments.push([x - px(3), y + px(3), x + px(3), y - px(3)]);
  return {
    kind: "lines",
    ...size,
    segments,
    horizontalLabel: {
      x: centerX - horizontalTextWidth / 2,
      y: horizontalY - px(6),
      width: horizontalTextWidth,
      height: px(12),
      text: widthText,
      fontSize: px(10),
      rotation: 0,
    },
    verticalLabel: {
      x: verticalX - px(6),
      y: centerY + verticalTextWidth / 2,
      width: verticalTextWidth,
      height: px(12),
      text: depthText,
      fontSize: px(10),
      rotation: -90,
    },
    caption: {
      x: minX + px(6),
      y: minY + px(5),
      width: px(46),
      height: px(11),
      text: tr`Внутри`,
      fontSize: px(9),
      rotation: 0,
    },
    strokeWidth: px(0.7),
  };
}
