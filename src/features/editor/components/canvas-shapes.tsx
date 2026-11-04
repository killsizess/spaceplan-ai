"use client";

import type { RefObject } from "react";
import { Circle, Group, Line, Rect, Text } from "react-konva";
import type { Opening, Room, Wall } from "@/domain/floor-plan/types";
import type { Point } from "@/domain/geometry";
import { rectangleArea } from "@/domain/geometry";
import { doorSwingLocal } from "@/domain/floor-plan/door-swing";
import { wallKindOf } from "@/domain/floor-plan/wall-kind";
import { formatArea, formatLength } from "@/lib/format";
import { gridLines, snapToGrid as snap, wallSolidSegments } from "../canvas-geometry";

/** Background grid in screen pixels; a fragment, so it adds no Konva node of its own. */
export function PlanGrid({
  camera,
  scale,
  size,
}: {
  camera: Point;
  scale: number;
  size: { width: number; height: number };
}) {
  const { vertical, horizontal } = gridLines(camera, scale, size);
  return (
    <>
      {vertical.map(({ position, major }) => (
        <Line
          key={`x${position}`}
          points={[position, 0, position, size.height]}
          stroke={major ? "#e2e5df" : "#eceee9"}
          strokeWidth={1}
          listening={false}
        />
      ))}
      {horizontal.map(({ position, major }) => (
        <Line
          key={`y${position}`}
          points={[0, position, size.width, position]}
          stroke={major ? "#e2e5df" : "#eceee9"}
          strokeWidth={1}
          listening={false}
        />
      ))}
    </>
  );
}

/**
 * A manual rectangular room: selectable and draggable in the select tool. A drag
 * registers its cancel in `dragCancelRef` so the canvas can abort it on Escape or blur.
 */
export function ManualRoomShape({
  room,
  scale,
  selected,
  interactive,
  translucent,
  showDimensions,
  dragCancelRef,
  onSelect,
  onMove,
}: {
  room: Room;
  scale: number;
  selected: boolean;
  interactive: boolean;
  translucent: boolean;
  showDimensions: boolean;
  dragCancelRef: RefObject<(() => void) | null>;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const showLabel = room.width * scale > 65 && room.height * scale > 60;
  return (
    <Group
      x={room.x}
      y={room.y}
      draggable={interactive}
      listening={interactive}
      onPointerDown={(event) => {
        if (event.evt.button !== 1) {
          event.cancelBubble = true;
          onSelect(room.id);
        }
      }}
      onDragStart={(event) => {
        const node = event.target;
        dragCancelRef.current = () => {
          dragCancelRef.current = null;
          node.stopDrag();
          node.position({ x: room.x, y: room.y });
        };
        if ("buttons" in event.evt && !(event.evt.buttons & 1))
          dragCancelRef.current();
      }}
      onDragEnd={(event) => {
        if (!dragCancelRef.current) return;
        dragCancelRef.current = null;
        const x = snap(event.target.x()),
          y = snap(event.target.y());
        // Restore controlled position first; validation may reject the new location.
        event.target.position({ x: room.x, y: room.y });
        onMove(room.id, x, y);
      }}
    >
      <Rect
        width={room.width}
        height={room.height}
        fill={translucent ? `${room.color}75` : room.color}
        stroke={selected ? "#426b50" : "#525b52"}
        strokeWidth={selected ? 0.085 : 0.065}
      />
      {selected && (
        <Rect
          x={0.1}
          y={0.1}
          width={Math.max(0, room.width - 0.2)}
          height={Math.max(0, room.height - 0.2)}
          stroke="#7c9b7f"
          strokeWidth={1 / scale}
          dash={[4 / scale, 4 / scale]}
          listening={false}
        />
      )}
      {showLabel && (
        <Group listening={false}>
          <Text
            x={0.12}
            y={room.height / 2 - 18 / scale}
            width={room.width - 0.24}
            text={room.name}
            fontFamily="Arial"
            fontSize={Math.min(13, (room.width * scale) / 8) / scale}
            fill="#354239"
            align="center"
            ellipsis
            wrap="none"
          />
          <Text
            x={0}
            y={room.height / 2 + 4 / scale}
            width={room.width}
            text={formatArea(rectangleArea(room.width, room.height))}
            fontFamily="Arial"
            fontSize={12 / scale}
            fill="#788078"
            align="center"
          />
        </Group>
      )}
      {showDimensions &&
        room.width * scale > 55 &&
        room.height * scale > 55 && (
          <Group listening={false}>
            <Text
              x={0}
              y={9 / scale}
              width={room.width}
              text={`${formatLength(room.width)} м`}
              fontSize={10 / scale}
              fontFamily="Arial"
              fill="#838a81"
              align="center"
            />
            <Text
              x={9 / scale}
              y={room.height / 2 + 20 / scale}
              text={`${formatLength(room.height)} м`}
              fontSize={10 / scale}
              fontFamily="Arial"
              fill="#838a81"
              rotation={-90}
            />
          </Group>
        )}
      {selected &&
        [
          [0, 0],
          [room.width, 0],
          [0, room.height],
          [room.width, room.height],
        ].map(([x, y], index) => (
          <Circle
            key={index}
            x={x}
            y={y}
            radius={3.5 / scale}
            fill="#fff"
            stroke="#426b50"
            strokeWidth={1.5 / scale}
            listening={false}
          />
        ))}
    </Group>
  );
}

/** A wall in its local frame (x along the wall) with door and window symbols. */
export function WallShape({
  wall,
  openings,
  scale,
  selectedId,
  interactive,
  showDimensions,
  onSelect,
}: {
  wall: Wall;
  /** Openings on this wall. */
  openings: readonly Opening[];
  scale: number;
  selectedId: string | null;
  interactive: boolean;
  showDimensions: boolean;
  onSelect: (id: string) => void;
}) {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const angle = (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
  const color = selectedId === wall.id ? WALL_SELECTED_COLOR : WALL_KIND_COLORS[wallKindOf(wall)];
  const wallOpenings = [...openings].sort((a, b) => a.offset - b.offset);
  const segments = wallSolidSegments(length, wallOpenings);
  return (
    <Group
      x={wall.start.x}
      y={wall.start.y}
      rotation={angle}
      listening={interactive}
      onPointerDown={(event) => {
        if (event.evt.button !== 1) {
          event.cancelBubble = true;
          onSelect(wall.id);
        }
      }}
    >
      <Rect
        x={0}
        y={-Math.max(wall.thickness, 14 / scale) / 2}
        width={length}
        height={Math.max(wall.thickness, 14 / scale)}
        fill="rgba(0,0,0,0)"
      />
      {segments.map((segment, index) => (
        <Rect
          key={index}
          x={segment.start}
          y={-wall.thickness / 2}
          width={segment.end - segment.start}
          height={wall.thickness}
          fill={color}
        />
      ))}
      {showDimensions && length * scale > 55 && (
        <Text
          x={0}
          y={-wall.thickness / 2 - 19 / scale}
          width={length}
          text={`${formatLength(length)} м`}
          align="center"
          fontSize={11 / scale}
          fontFamily="Arial"
          fill={color}
          listening={false}
        />
      )}
      {wallOpenings.map((opening) => {
        const selectedOpening = selectedId === opening.id;
        const stroke = selectedOpening
          ? "#1b7750"
          : opening.kind === "window"
            ? "#5b91a0"
            : "#65756a";
        // A drag preview may push an opening past the wall start before
        // the move is rejected; the local symbol never uses the offset.
        const swing = doorSwingLocal(opening.offset < 0 ? { ...opening, offset: 0 } : opening);
        return (
          <Group
            key={opening.id}
            x={opening.offset}
            onPointerDown={(event) => {
              if (event.evt.button !== 1) {
                event.cancelBubble = true;
                onSelect(opening.id);
              }
            }}
          >
            <Rect
              y={-Math.max(wall.thickness, 18 / scale) / 2}
              width={opening.width}
              height={Math.max(wall.thickness, 18 / scale)}
              fill={selectedOpening ? "#dcebe470" : "rgba(0,0,0,0)"}
            />
            {swing ? (
              <>
                <Line
                  points={[swing.hinge.x, swing.hinge.y, swing.openEnd.x, swing.openEnd.y]}
                  stroke={stroke}
                  strokeWidth={2 / scale}
                  hitStrokeWidth={12 / scale}
                />
                <Line
                  points={swing.arc.flatMap((point) => [point.x, point.y])}
                  stroke={stroke}
                  strokeWidth={1.2 / scale}
                  dash={[4 / scale, 3 / scale]}
                  hitStrokeWidth={10 / scale}
                />
              </>
            ) : (
              <>
                <Rect
                  y={-wall.thickness / 2}
                  width={opening.width}
                  height={wall.thickness}
                  fill="#eaf4f2"
                  stroke={stroke}
                  strokeWidth={1.5 / scale}
                />
                <Line
                  points={[0, 0, opening.width, 0]}
                  stroke={stroke}
                  strokeWidth={1.5 / scale}
                />
              </>
            )}
            {selectedOpening && (
              <Line
                points={[
                  0,
                  wall.thickness / 2 + 5 / scale,
                  opening.width,
                  wall.thickness / 2 + 5 / scale,
                ]}
                stroke={stroke}
                strokeWidth={2 / scale}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}

type Segment = { start: Point; end: Point };

/** A wall's type is visible on the plan: bearing heavy and dark, unknown in warning amber. */
export const WALL_KIND_COLORS = { bearing: "#10231c", partition: "#7d8c83", unknown: "#b9770e" } as const;
export const WALL_SELECTED_COLOR = "#1a7353";

/**
 * Suggested walls: translucent footprints with a dashed outline. Selected ones are
 * orange, excluded ones faint grey; a click (select tool) switches one on or off.
 */
export function WallCandidateOverlay({
  candidates,
  selected,
  scale,
  interactive,
  onToggle,
}: {
  candidates: readonly (Segment & { thickness: number })[];
  selected: readonly boolean[];
  scale: number;
  interactive: boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <Group listening={interactive}>
      {candidates.map((candidate, index) => {
        const length = Math.hypot(candidate.end.x - candidate.start.x, candidate.end.y - candidate.start.y);
        const angle = (Math.atan2(candidate.end.y - candidate.start.y, candidate.end.x - candidate.start.x) * 180) / Math.PI;
        const on = selected[index] !== false;
        return (
          <Rect
            key={index}
            x={candidate.start.x}
            y={candidate.start.y}
            rotation={angle}
            offsetY={candidate.thickness / 2}
            width={length}
            height={candidate.thickness}
            fill={on ? "rgba(201, 105, 75, 0.28)" : "rgba(140, 146, 136, 0.08)"}
            stroke={on ? "#c9694b" : "#a3aa9c"}
            strokeWidth={(on ? 1.5 : 1) / scale}
            dash={[5 / scale, 3 / scale]}
            // Thin walls stay easy to hit at any zoom.
            hitStrokeWidth={12 / scale}
            onPointerDown={(event) => {
              if (event.evt.button !== 0) return;
              event.cancelBubble = true;
              onToggle(index);
            }}
          />
        );
      })}
    </Group>
  );
}

/**
 * Suggested doors and windows: a dashed outline over the opening, blue when sure, amber
 * when «неуверенно», faint when switched off. A click (select tool) switches one on or off.
 */
export function OpeningCandidateOverlay({
  candidates,
  selected,
  scale,
  interactive,
  onToggle,
}: {
  candidates: readonly { from: Point; to: Point; thickness: number; kind: "door" | "window"; confident: boolean }[];
  selected: readonly boolean[];
  scale: number;
  interactive: boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <Group listening={interactive}>
      {candidates.map((candidate, index) => {
        const length = Math.hypot(candidate.to.x - candidate.from.x, candidate.to.y - candidate.from.y);
        const angle = (Math.atan2(candidate.to.y - candidate.from.y, candidate.to.x - candidate.from.x) * 180) / Math.PI;
        const on = selected[index] !== false;
        const color = candidate.confident ? "#2f6fdb" : "#d98a00";
        const mid = { x: (candidate.from.x + candidate.to.x) / 2, y: (candidate.from.y + candidate.to.y) / 2 };
        return (
          <Group key={index}>
            <Rect
              x={candidate.from.x}
              y={candidate.from.y}
              rotation={angle}
              offsetY={candidate.thickness / 2 + 0.04}
              width={length}
              height={candidate.thickness + 0.08}
              fill={on ? (candidate.confident ? "rgba(47, 111, 219, 0.25)" : "rgba(217, 138, 0, 0.25)") : "rgba(140, 146, 136, 0.08)"}
              stroke={on ? color : "#a3aa9c"}
              strokeWidth={(on ? 1.8 : 1) / scale}
              dash={[4 / scale, 3 / scale]}
              hitStrokeWidth={14 / scale}
              onPointerDown={(event) => {
                if (event.evt.button !== 0) return;
                event.cancelBubble = true;
                onToggle(index);
              }}
            />
            <Text
              x={mid.x - 12 / scale}
              y={mid.y - 22 / scale}
              width={24 / scale}
              align="center"
              text={`${candidate.kind === "door" ? "Д" : "О"}${candidate.confident ? "" : "?"}`}
              fontSize={12 / scale}
              fontStyle="bold"
              fill={on ? color : "#a3aa9c"}
              listening={false}
            />
          </Group>
        );
      })}
    </Group>
  );
}

/** The wall being drawn, with its length. */
export function WallDraftOverlay({ draft, scale }: { draft: Segment; scale: number }) {
  return (
    <Group listening={false}>
      <Line
        points={[draft.start.x, draft.start.y, draft.end.x, draft.end.y]}
        stroke="#426b50"
        strokeWidth={Math.max(0.15, 2 / scale)}
        opacity={0.6}
      />
      {[draft.start, draft.end].map((point, index) => (
        <Circle
          key={index}
          {...point}
          radius={4 / scale}
          fill="#fff"
          stroke="#426b50"
          strokeWidth={1.5 / scale}
        />
      ))}
      <Text
        x={(draft.start.x + draft.end.x) / 2 + 10 / scale}
        y={(draft.start.y + draft.end.y) / 2 - 24 / scale}
        text={`${formatLength(Math.hypot(draft.end.x - draft.start.x, draft.end.y - draft.start.y))} м`}
        fontSize={12 / scale}
        fontFamily="Arial"
        fill="#426b50"
      />
    </Group>
  );
}

/** The calibration segment between the first point and the pointer. */
export function CalibrationOverlay({ segment, scale }: { segment: Segment; scale: number }) {
  return (
    <Group listening={false}>
      <Line
        points={[segment.start.x, segment.start.y, segment.end.x, segment.end.y]}
        stroke="#bd652b"
        strokeWidth={2 / scale}
        dash={[6 / scale, 4 / scale]}
      />
      {[segment.start, segment.end].map((point, index) => (
        <Circle
          key={index}
          {...point}
          radius={5 / scale}
          fill="#fff"
          stroke="#bd652b"
          strokeWidth={2 / scale}
        />
      ))}
      <Text
        x={segment.end.x + 10 / scale}
        y={segment.end.y - 20 / scale}
        text="Укажите вторую точку"
        fontSize={12 / scale}
        fontFamily="Arial"
        fill="#9c4c1f"
      />
    </Group>
  );
}

/** The manual room rectangle being drawn, with its size. */
export function RoomDraftOverlay({
  draft,
  scale,
}: {
  draft: { x: number; y: number; width: number; height: number };
  scale: number;
}) {
  return (
    <Group listening={false}>
      <Rect
        {...draft}
        fill="#dfe8df"
        opacity={0.65}
        stroke="#426b50"
        strokeWidth={2 / scale}
        dash={[6 / scale, 4 / scale]}
      />
      <Text
        x={draft.x}
        y={draft.y - 24 / scale}
        text={`${formatLength(draft.width)} × ${formatLength(draft.height)} м`}
        fontSize={12 / scale}
        fontFamily="Arial"
        fill="#426b50"
      />
    </Group>
  );
}
