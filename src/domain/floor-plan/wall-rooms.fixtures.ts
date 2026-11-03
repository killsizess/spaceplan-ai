import { createSpatialExamplePlan } from "./examples";
import type { Wall } from "./types";

/**
 * Reference wall layouts for room detection. They cover the cases that depend on
 * polygon clipping details: butt-ended corners, T-junctions, stubs, mixed thickness,
 * diagonal and off-grid walls, islands, holes and gaps. Changing an existing layout
 * invalidates its golden record; add new layouts instead.
 */
export interface WallRoomFixture {
  name: string;
  walls: Wall[];
}

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.2): Wall =>
  ({ id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, height: 2.7 });

/** Closed loop through the points, walls named `${prefix}1`, `${prefix}2`, … */
function loop(prefix: string, points: readonly (readonly [number, number])[], thickness = 0.2): Wall[] {
  return points.map(([x, y], index) => {
    const [nx, ny] = points[(index + 1) % points.length];
    return wall(`${prefix}${index + 1}`, x, y, nx, ny, thickness);
  });
}

export const WALL_ROOM_FIXTURES: readonly WallRoomFixture[] = [
  { name: "rectangle", walls: loop("r", [[0, 0], [5, 0], [5, 4], [0, 4]]) },
  { name: "l-shape", walls: loop("l", [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]]) },
  {
    name: "partitioned-apartment",
    walls: [
      ...loop("a", [[0, 0], [10, 0], [10, 6], [0, 6]]),
      wall("partition", 6, 0, 6, 6),
      wall("branch", 6, 3, 10, 3),
      wall("stub", 3, 6, 3, 4.5),
    ],
  },
  {
    name: "mixed-thickness",
    walls: [...loop("m", [[0, 0], [6, 0], [6, 4], [0, 4]], 0.3), wall("inner", 2.5, 0, 2.5, 4, 0.1)],
  },
  { name: "diagonal-corner", walls: loop("d", [[0, 0], [6, 0], [6, 3], [3, 6], [0, 6]]) },
  {
    name: "off-grid-skewed",
    walls: loop("o", [[0.37, 0.11], [5.123, 0.2], [5.2, 4.457], [0.3, 4.31]], 0.17),
  },
  {
    name: "free-standing-screen",
    walls: [...loop("s", [[0, 0], [8, 0], [8, 6], [0, 6]]), wall("screen", 2, 3, 5, 3)],
  },
  {
    name: "nested-box",
    walls: [...loop("n", [[0, 0], [8, 0], [8, 6], [0, 6]]), ...loop("box", [[3, 2], [4, 2], [4, 3], [3, 3]])],
  },
  {
    name: "open-gap",
    walls: [wall("g1", 0, 0, 5, 0), wall("g2", 5, 0, 5, 4), wall("g3", 5, 4, 0, 4), wall("g4", 0, 4, 0, 0.5)],
  },
  {
    name: "hairline-gap",
    walls: [wall("h1", 0, 0, 5, 0), wall("h2", 5, 0, 5, 4), wall("h3", 5, 4, 0, 4), wall("h4", 0, 4, 0, 0.05)],
  },
  { name: "spatial-example", walls: createSpatialExamplePlan().walls },
];
