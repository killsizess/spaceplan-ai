"use client";

import { Circle, Group, Line } from "react-konva";
import type { WallIntersectionDiagnostic } from "@/domain/floor-plan/wall-intersections";

export function WallIntersectionMarkers({
  intersections,
  scale,
}: {
  intersections: readonly WallIntersectionDiagnostic[];
  scale: number;
}) {
  const points = new Map(intersections.map(({ point }) => [`${point.x},${point.y}`, point]));
  const arm = 3.2 / scale;
  return (
    <Group listening={false}>
      {[...points].map(([key, point]) => (
        <Group key={key} {...point} listening={false}>
          <Circle radius={7 / scale} fill="#fffaf3" stroke="#ad7134" strokeWidth={1.2 / scale} listening={false} />
          <Line points={[-arm, -arm, arm, arm]} stroke="#ad7134" strokeWidth={1.3 / scale} listening={false} />
          <Line points={[-arm, arm, arm, -arm]} stroke="#ad7134" strokeWidth={1.3 / scale} listening={false} />
        </Group>
      ))}
    </Group>
  );
}
