"use client";

import { Circle, Group, Line } from "react-konva";
import type { WallConnectionDiagnostic } from "@/domain/floor-plan/wall-diagnostics";

export function WallConnectionMarkers({
  diagnostics,
  scale,
}: {
  diagnostics: readonly WallConnectionDiagnostic[];
  scale: number;
}) {
  const radius = 5.5 / scale;
  const strokeWidth = 1.4 / scale;
  const drawnSegments = new Set<string>();

  return (
    <Group listening={false}>
      {diagnostics.map((diagnostic) => {
        const junction = diagnostic.kind === "junction";
        const color = junction ? "#a56a19" : "#c57932";
        const target = diagnostic.target;
        const segmentKey = target
          ? [
              `${diagnostic.point.x},${diagnostic.point.y}`,
              `${target.point.x},${target.point.y}`,
            ].sort().join("|")
          : "";
        const showTarget =
          !junction &&
          target &&
          diagnostic.distance !== undefined &&
          diagnostic.distance > 1e-9 &&
          diagnostic.distance <= 0.3 + 1e-9 &&
          !drawnSegments.has(segmentKey);
        if (showTarget) drawnSegments.add(segmentKey);

        return (
          <Group key={diagnostic.id} listening={false}>
            {showTarget && (
              <>
                <Line
                  points={[
                    diagnostic.point.x,
                    diagnostic.point.y,
                    target.point.x,
                    target.point.y,
                  ]}
                  stroke="#fffaf3"
                  strokeWidth={3.8 / scale}
                  listening={false}
                />
                <Line
                  points={[
                    diagnostic.point.x,
                    diagnostic.point.y,
                    target.point.x,
                    target.point.y,
                  ]}
                  stroke={color}
                  strokeWidth={1.2 / scale}
                  dash={[3 / scale, 3 / scale]}
                  listening={false}
                />
                <Circle
                  {...target.point}
                  radius={2.5 / scale}
                  fill="#fffaf3"
                  stroke={color}
                  strokeWidth={1 / scale}
                  listening={false}
                />
              </>
            )}
            {junction ? (
              <Line
                points={[
                  diagnostic.point.x,
                  diagnostic.point.y - radius,
                  diagnostic.point.x + radius,
                  diagnostic.point.y,
                  diagnostic.point.x,
                  diagnostic.point.y + radius,
                  diagnostic.point.x - radius,
                  diagnostic.point.y,
                ]}
                closed
                fill="#fff6e5"
                stroke={color}
                strokeWidth={strokeWidth}
                listening={false}
              />
            ) : (
              <Circle
                {...diagnostic.point}
                radius={radius}
                fill="#fffaf3"
                stroke={color}
                strokeWidth={strokeWidth}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}
