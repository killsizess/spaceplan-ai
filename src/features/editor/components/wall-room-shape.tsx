"use client";

import { Group, Shape, Text } from "react-konva";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { formatArea } from "@/lib/format";
import { readableRoomInk } from "@/lib/color-contrast";
import { CANVAS_FONT } from "../canvas-geometry";

export function WallRoomShape({
  room,
  scale,
  selected,
  flagged = false,
  listening,
  translucent,
  onSelect,
}: {
  room: WallRoom;
  scale: number;
  selected: boolean;
  /** The room breaks a user requirement. */
  flagged?: boolean;
  listening: boolean;
  translucent: boolean;
  onSelect: (id: string) => void;
}) {
  const showLabel =
    (room.bounds.maxX - room.bounds.minX) * scale > 100 &&
    (room.bounds.maxY - room.bounds.minY) * scale > 65;
  return (
    <Group listening={listening}>
      <Shape
        fill={translucent ? `${room.color}75` : room.color}
        fillRule="evenodd"
        stroke={selected ? "#426b50" : flagged ? "#c9694b" : "#91a18b"}
        strokeWidth={(selected ? 2 : flagged ? 2.2 : 0.8) / scale}
        dash={flagged && !selected ? [7 / scale, 4 / scale] : undefined}
        sceneFunc={(context, shape) => {
          context.beginPath();
          for (const ring of [room.outer, ...room.holes]) {
            if (!ring.length) continue;
            context.moveTo(ring[0].x, ring[0].y);
            for (const point of ring.slice(1)) context.lineTo(point.x, point.y);
            context.closePath();
          }
          context.fillStrokeShape(shape);
        }}
        onPointerDown={(event) => {
          if (event.evt.button !== 0) return;
          event.cancelBubble = true;
          onSelect(room.id);
        }}
      />
      {showLabel && (
        <Group x={room.labelPoint.x} y={room.labelPoint.y} listening={false}>
          <Text
            x={-80 / scale}
            y={-17 / scale}
            width={160 / scale}
            text={room.name}
            fontFamily={CANVAS_FONT}
            fontSize={12 / scale}
            align="center"
            ellipsis
            wrap="none"
            fill={translucent ? "#41513e" : readableRoomInk(room.color, "#41513e")}
            stroke={translucent ? "#ffffff" : undefined}
            strokeWidth={translucent ? 2 / scale : 0}
            fillAfterStrokeEnabled
          />
          <Text
            x={-80 / scale}
            y={2 / scale}
            width={160 / scale}
            text={formatArea(room.area)}
            fontFamily={CANVAS_FONT}
            fontSize={11 / scale}
            align="center"
            fill={translucent ? "#41513e" : readableRoomInk(room.color, "#788078")}
            stroke={translucent ? "#ffffff" : undefined}
            strokeWidth={translucent ? 2 / scale : 0}
            fillAfterStrokeEnabled
          />
        </Group>
      )}
    </Group>
  );
}
