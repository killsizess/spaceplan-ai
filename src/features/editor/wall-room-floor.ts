import { ExtrudeGeometry, Path, Shape, Vector2 } from "three";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { FLOOR_THICKNESS } from "@/domain/floor-plan/spatial";

/** Plan X/Y becomes scene X/Z; the slab's top stays at elevation zero. */
export function createWallRoomFloorGeometry(
  room: Pick<WallRoom, "outer" | "holes">,
): ExtrudeGeometry {
  const points = (ring: WallRoom["outer"]) =>
    ring.map((point) => new Vector2(point.x, point.y));
  const shape = new Shape(points(room.outer));
  shape.closePath();
  shape.holes = room.holes.map((ring) => {
    const hole = new Path(points(ring));
    hole.closePath();
    return hole;
  });
  const geometry = new ExtrudeGeometry(shape, {
    depth: FLOOR_THICKNESS,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.rotateX(Math.PI / 2);
  return geometry;
}
