"use client";

import { Group, Line, Text } from "react-konva";
import type { DimensionLabel, RoomDimensionLayout } from "../room-dimensions";
import { readableRoomInk } from "@/lib/color-contrast";
import { CANVAS_FONT } from "../canvas-geometry";

function Label({ label, color, outline }: { label: DimensionLabel; color: string; outline: boolean }) {
  return (
    <Text
      {...label}
      fontFamily={CANVAS_FONT}
      align="center"
      verticalAlign="middle"
      wrap="none"
      fill={color}
      stroke={outline ? "#ffffff" : undefined}
      strokeWidth={outline ? label.fontSize * 0.18 : 0}
      fillAfterStrokeEnabled
      listening={false}
    />
  );
}

export function WallRoomDimensions({
  layout,
  selected,
  background,
  translucent = false,
}: {
  layout: RoomDimensionLayout;
  selected: boolean;
  background: string;
  translucent?: boolean;
}) {
  const color = translucent ? "#41513e" : readableRoomInk(background, selected ? "#426b50" : "#788078");
  if (layout.kind === "compact") {
    return <Group listening={false}><Label label={layout.label} color={color} outline={translucent} /></Group>;
  }
  return (
    <Group listening={false}>
      {layout.segments.map((points, index) => (
        <Line
          key={index}
          points={points}
          stroke={color}
          strokeWidth={layout.strokeWidth}
          listening={false}
        />
      ))}
      <Label label={layout.horizontalLabel} color={color} outline={translucent} />
      <Label label={layout.verticalLabel} color={color} outline={translucent} />
      <Label label={layout.caption} color={color} outline={translucent} />
    </Group>
  );
}
