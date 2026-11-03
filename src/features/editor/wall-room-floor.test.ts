import { describe, expect, it } from "vitest";
import {
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
  type BufferGeometry,
} from "three";
import { createWallRoomFloorGeometry } from "./wall-room-floor";
import { FLOOR_THICKNESS } from "@/domain/floor-plan/spatial";

function upperSurfaceArea(geometry: BufferGeometry) {
  const positions = geometry.getAttribute("position");
  const indices = geometry.getIndex();
  const count = indices?.count ?? positions.count;
  let area = 0;
  for (let offset = 0; offset < count; offset += 3) {
    const points = [0, 1, 2].map((step) => {
      const index = indices ? indices.getX(offset + step) : offset + step;
      return new Vector3().fromBufferAttribute(positions, index);
    });
    if (points.some((point) => Math.abs(point.y) > 1e-7)) continue;
    area +=
      points[1]
        .clone()
        .sub(points[0])
        .cross(points[2].clone().sub(points[0]))
        .length() / 2;
  }
  return area;
}

describe("derived room floor rendering geometry", () => {
  it("keeps concave floors at plan X/Z and below elevation zero", () => {
    const geometry = createWallRoomFloorGeometry({
      outer: [
        { x: 1, y: 2 },
        { x: 5, y: 2 },
        { x: 5, y: 4 },
        { x: 3, y: 4 },
        { x: 3, y: 6 },
        { x: 1, y: 6 },
      ],
      holes: [],
    });
    try {
      geometry.computeBoundingBox();
      expect(geometry.boundingBox?.min.x).toBeCloseTo(1);
      expect(geometry.boundingBox?.max.x).toBeCloseTo(5);
      expect(geometry.boundingBox?.min.z).toBeCloseTo(2);
      expect(geometry.boundingBox?.max.z).toBeCloseTo(6);
      expect(geometry.boundingBox?.min.y).toBeCloseTo(-FLOOR_THICKNESS);
      expect(geometry.boundingBox?.max.y).toBeCloseTo(0);
      expect(upperSurfaceArea(geometry)).toBeCloseTo(12);
    } finally {
      geometry.dispose();
    }
  });

  it("preserves a column opening visually and in floor raycasting", () => {
    const geometry = createWallRoomFloorGeometry({
      outer: [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 4 },
        { x: 0, y: 4 },
      ],
      holes: [
        [
          { x: 2, y: 1 },
          { x: 4, y: 1 },
          { x: 4, y: 3 },
          { x: 2, y: 3 },
        ],
      ],
    });
    const material = new MeshBasicMaterial();
    const mesh = new Mesh(geometry, material);
    mesh.updateMatrixWorld();
    const raycaster = new Raycaster();
    try {
      expect(upperSurfaceArea(geometry)).toBeCloseTo(20);
      raycaster.set(new Vector3(1, 2, 2), new Vector3(0, -1, 0));
      expect(raycaster.intersectObject(mesh)).not.toHaveLength(0);
      raycaster.set(new Vector3(3, 2, 2), new Vector3(0, -1, 0));
      expect(raycaster.intersectObject(mesh)).toHaveLength(0);
    } finally {
      geometry.dispose();
      material.dispose();
    }
  });
});
