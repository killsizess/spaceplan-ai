"use client";

import { Circle, Group, Line } from "react-konva";
import type { DoorWallCollision } from "@/domain/floor-plan/door-collisions";
import type { DoorPairCollision } from "@/domain/floor-plan/door-pair-collisions";

/** Passive screen-sized marks leave wall and door hit targets unchanged. */
export function DoorCollisionMarkers({
  collisions,
  scale,
}: {
  collisions: readonly DoorWallCollision[];
  scale: number;
}) {
  const color = "#b65f2f";
  return (
    <Group listening={false}>
      {collisions.map((collision) => (
        <Group key={collision.id} {...collision.point} listening={false}>
          <Circle
            radius={8 / scale}
            fill="rgba(255, 228, 193, 0.22)"
            stroke={color}
            strokeWidth={1.5 / scale}
            listening={false}
          />
          <Line
            points={[0, -4 / scale, 0, 1 / scale]}
            stroke={color}
            strokeWidth={1.7 / scale}
            lineCap="round"
            listening={false}
          />
          <Circle y={4 / scale} radius={1 / scale} fill={color} listening={false} />
        </Group>
      ))}
    </Group>
  );
}

/** A double violet ring distinguishes two-door zones from wall intersections. */
export function DoorPairCollisionMarkers({
  collisions,
  scale,
}: {
  collisions: readonly DoorPairCollision[];
  scale: number;
}) {
  const color = "#7660a2";
  return (
    <Group listening={false}>
      {collisions.map((collision) => (
        <Group key={collision.id} {...collision.point} listening={false}>
          <Circle radius={8 / scale} fill="rgba(225, 215, 244, 0.24)" stroke={color} strokeWidth={1.5 / scale} listening={false} />
          <Circle radius={4 / scale} stroke={color} strokeWidth={1.2 / scale} listening={false} />
          <Circle radius={1 / scale} fill={color} listening={false} />
        </Group>
      ))}
    </Group>
  );
}
