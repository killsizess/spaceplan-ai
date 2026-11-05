import { tr } from "@/lib/i18n";
import { createExamplePlan } from "./operations";
import type { FloorPlan, Opening, Wall } from "./types";

/** A separate sample; existing projects and the original room-only example stay intact. */
export function createSpatialExamplePlan(): FloorPlan {
  const wall = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thickness = 0.12,
  ): Wall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thickness,
    height: 2.7,
  });
  const walls = [
    wall("outer-top", 0, 0, 10, 0, 0.2),
    wall("outer-bottom", 0, 8, 10, 8, 0.2),
    wall("outer-left", 0, 0, 0, 8, 0.2),
    wall("outer-right", 10, 0, 10, 8, 0.2),
    wall("partition-v5", 5, 0, 5, 4),
    wall("partition-v8", 8, 0, 8, 8),
    wall("partition-h4", 0, 4, 8, 4),
    wall("partition-v4", 4, 4, 4, 8),
    wall("partition-h5", 8, 5, 10, 5),
  ];
  const door = (id: string, wallId: string, offset: number): Opening => ({
    id,
    wallId,
    offset,
    kind: "door",
    width: 0.9,
    height: 2.1,
    sillHeight: 0,
  });
  const window = (
    id: string,
    wallId: string,
    offset: number,
    width: number,
  ): Opening => ({
    id,
    wallId,
    offset,
    width,
    kind: "window",
    height: 1.2,
    sillHeight: 0.9,
  });
  return {
    ...createExamplePlan(),
    id: "spatial-example",
    name: tr`Квартира · 3D-пример`,
    walls,
    openings: [
      door("door-bedroom", "partition-h4", 1.6),
      door("door-study", "partition-h4", 5.4),
      door("door-kitchen-hall", "partition-v8", 2),
      door("door-bathroom", "partition-v8", 6.3),
      door("door-living", "partition-v5", 1.5),
      door("door-study-bedroom", "partition-v4", 1.6),
      door("door-entry", "outer-right", 3.5),
      window("window-living", "outer-top", 1.7, 1.6),
      window("window-kitchen", "outer-top", 6, 1.2),
      window("window-bedroom", "outer-left", 5.2, 1.6),
      window("window-study", "outer-bottom", 5.1, 1.6),
      window("window-hall", "outer-right", 1.5, 1.2),
    ],
  };
}
