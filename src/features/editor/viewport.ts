import type { Rectangle } from "@/domain/geometry";

export const BASE_SCALE = 60;
export const MIN_ZOOM = 0.001;
export const MAX_ZOOM = 2.5;
export const clampZoom = (value: number) =>
  Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

export function fitViewport(
  rooms: readonly Rectangle[],
  width: number,
  height: number,
) {
  if (!rooms.length)
    return {
      zoom: 1,
      x: Math.round(width * 0.24),
      y: Math.round(height * 0.22),
    };
  const minX = Math.min(...rooms.map((room) => room.x));
  const minY = Math.min(...rooms.map((room) => room.y));
  const maxX = Math.max(...rooms.map((room) => room.x + room.width));
  const maxY = Math.max(...rooms.map((room) => room.y + room.height));
  const zoom = clampZoom(
    Math.min(
      (width - Math.min(140, width * 0.3)) / (maxX - minX) / BASE_SCALE,
      (height - Math.min(160, height * 0.3)) / (maxY - minY) / BASE_SCALE,
      1.15,
    ),
  );
  return {
    zoom,
    x: width / 2 - ((minX + maxX) / 2) * BASE_SCALE * zoom,
    y: height / 2 - ((minY + maxY) / 2) * BASE_SCALE * zoom,
  };
}

export function scaleBarMeters(zoom: number): number {
  return (
    [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(
      (meters) => meters * BASE_SCALE * zoom >= 30,
    ) ?? 1000
  );
}
