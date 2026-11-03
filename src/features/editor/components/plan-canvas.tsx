"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KonvaEventObject, Node as KonvaNode } from "konva/lib/Node";
import {
  Stage,
  Layer,
  Group,
  Circle,
  Arrow,
  Image as KonvaImage,
} from "react-konva";
import type { Room, Wall, Opening, Underlay } from "@/domain/floor-plan/types";
import type { Point } from "@/domain/geometry";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import type { WallConnectionDiagnostic } from "@/domain/floor-plan/wall-diagnostics";
import type { WallIntersectionDiagnostic } from "@/domain/floor-plan/wall-intersections";
import type { DoorWallCollision } from "@/domain/floor-plan/door-collisions";
import type { DoorPairCollision } from "@/domain/floor-plan/door-pair-collisions";
import {
  previewWallNode,
  rebaseOpenings,
  type WallEndpoint,
} from "@/domain/floor-plan/wall-nodes";
import {
  previewWallMove,
  previewWallOffset,
  wallMoveContext,
  type WallMoveContext,
} from "@/domain/floor-plan/move-wall";
import { formatLength } from "@/lib/format";
import { BASE_SCALE, clampZoom, fitViewport } from "../viewport";
import type { EditorTool } from "../editor-tools";
import { useUnderlayImage } from "../use-underlay-image";
import {
  CalibrationOverlay,
  ManualRoomShape,
  PlanGrid,
  RoomDraftOverlay,
  WallCandidateOverlay,
  WallDraftOverlay,
  WallShape,
} from "./canvas-shapes";
import type { WallCandidate } from "@/domain/floor-plan/wall-candidates";
import { WallRoomShape } from "./wall-room-shape";
import { WallRoomDimensions } from "./wall-room-dimensions";
import { WallConnectionMarkers } from "./wall-connection-markers";
import { WallIntersectionMarkers } from "./wall-intersection-markers";
import { DoorCollisionMarkers, DoorPairCollisionMarkers } from "./door-collision-markers";
import { getRoomDimensionLayout } from "../room-dimensions";
import {
  findWallAt,
  moveHandleOffset,
  planBounds,
  snapToGrid as snap,
  snapWallPoint,
  underlayPixelAt,
} from "../canvas-geometry";

type Draft = { x: number; y: number; width: number; height: number };
type Segment = { start: Point; end: Point };
type WallNodeDrag = {
  wallId: string;
  endpoint: WallEndpoint;
  expectedPoint: Point;
  point: Point;
  walls: readonly Wall[];
};
type WallNodePreview = {
  wallId: string;
  endpoint: WallEndpoint;
  point: Point;
  walls: readonly Wall[];
};
type WallMoveMode = "offset" | "move";
type WallMoveDrag = {
  wallId: string;
  context: WallMoveContext;
  /** "offset" keeps other walls' directions; "move" carries attached walls rigidly. */
  mode: WallMoveMode;
  /** Unit direction the handle follows. */
  direction: Point;
  /** Handle position when the gesture started, in plan metres. */
  origin: Point;
  expected: { start: Point; end: Point };
  /** Signed distance along `direction`, on the 0.1 m grid. */
  distance: number;
  walls: readonly Wall[];
};
type WallMovePreview = { wallId: string; origin: Point; delta: Point; walls: readonly Wall[] };

/** Screen gap between a wall face and its move handle, on the wall's normal side. */
const MOVE_HANDLE_GAP = 20;
/** Screen distance the handle keeps from wall ends, T-junctions and openings. */
const MOVE_HANDLE_CLEARANCE = 26;
interface Props {
  rooms: Room[];
  wallRooms?: readonly WallRoom[];
  /** Rooms that break a user requirement; outlined as a warning. */
  flaggedRoomIds?: readonly string[];
  /** Walls suggested from a PDF, shown until accepted or dismissed. */
  wallCandidates?: readonly WallCandidate[];
  /** Which suggestions will be added; a click on one switches it. */
  wallCandidateSelection?: readonly boolean[];
  onToggleWallCandidate?: (index: number) => void;
  walls: Wall[];
  openings: Opening[];
  underlay?: Underlay;
  selectedRoomId: string | null;
  tool: EditorTool;
  zoom: number;
  showGrid: boolean;
  showDimensions: boolean;
  connectionDiagnostics: readonly WallConnectionDiagnostic[];
  showConnections: boolean;
  intersections: readonly WallIntersectionDiagnostic[];
  showIntersections: boolean;
  doorCollisions: readonly DoorWallCollision[];
  doorPairCollisions: readonly DoorPairCollision[];
  showDoorCollisions: boolean;
  focusConnection?: { point: Point; request: number };
  fitViewKey: number;
  onSelect: (id: string | null) => void;
  onCreateRoom: (rect: Draft) => void;
  onMoveRoom: (id: string, x: number, y: number) => void;
  onCreateWall: (start: Point, end: Point) => void;
  onMoveWallNode: (
    wallId: string,
    endpoint: WallEndpoint,
    point: Point,
    expectedPoint: Point,
  ) => void;
  /** Whole-wall moves keep other walls' directions when the plan allows it. */
  keepDirections?: boolean;
  onMoveWall: (
    wallId: string,
    delta: Point,
    expected: { start: Point; end: Point },
  ) => void;
  onOffsetWall: (
    wallId: string,
    distance: number,
    expected: { start: Point; end: Point },
  ) => void;
  onPlaceOpening: (
    wallId: string,
    offset: number,
    kind: "door" | "window",
  ) => void;
  onCalibration: (startPixel: Point, endPixel: Point) => void;
  onMoveUnderlay: (x: number, y: number) => void;
  onImageError: (message: string) => void;
  onZoomChange: (zoom: number) => void;
}

export default function PlanCanvas({
  rooms,
  wallRooms = [],
  flaggedRoomIds = [],
  wallCandidates = [],
  wallCandidateSelection = [],
  onToggleWallCandidate,
  walls,
  openings,
  underlay,
  selectedRoomId,
  tool,
  zoom,
  showGrid,
  showDimensions,
  connectionDiagnostics,
  showConnections,
  intersections,
  showIntersections,
  doorCollisions,
  doorPairCollisions = [],
  showDoorCollisions,
  focusConnection,
  fitViewKey,
  onSelect,
  onCreateRoom,
  onMoveRoom,
  onCreateWall,
  onMoveWallNode,
  keepDirections = true,
  onMoveWall,
  onOffsetWall,
  onPlaceOpening,
  onCalibration,
  onMoveUnderlay,
  onImageError,
  onZoomChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef(planBounds(rooms, walls, underlay, openings));
  const dragCancelRef = useRef<(() => void) | null>(null);
  const wallNodeDragRef = useRef<WallNodeDrag | null>(null);
  const wallMoveDragRef = useRef<WallMoveDrag | null>(null);
  const focusedRequestRef = useRef<number | null>(null);
  const activeFocusRequestRef = useRef<number | undefined>(focusConnection?.request);
  const gestureRef = useRef<{
    start: Point;
    last: Point;
    mode: "room" | "pan" | "wall";
  } | null>(null);
  const calibrationRef = useRef<Point | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Point>({ x: 80, y: 80 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [wallDraft, setWallDraft] = useState<Segment | null>(null);
  const [wallNodePreview, setWallNodePreview] = useState<WallNodePreview | null>(null);
  const [wallMovePreview, setWallMovePreview] = useState<WallMovePreview | null>(null);
  const [calibration, setCalibration] = useState<Segment | null>(null);
  const visibleImage = useUnderlayImage(underlay, onImageError);
  const scale = BASE_SCALE * zoom;
  const imageSource = underlay?.dataUrl;
  const preview = wallNodePreview ?? wallMovePreview;
  const displayedWalls = preview?.walls ?? walls;
  // The preview places openings by the same rule as the committed command.
  const displayedOpenings = preview
    ? rebaseOpenings(walls, preview.walls, openings)
    : openings;
  const displayedConnections =
    showConnections && !preview ? connectionDiagnostics : [];
  const displayedIntersections =
    showIntersections && !preview ? intersections : [];
  const displayedDoorCollisions =
    showDoorCollisions && !preview ? doorCollisions : [];
  const displayedDoorPairCollisions =
    showDoorCollisions && !preview ? doorPairCollisions : [];
  const focusRequest = focusConnection?.request;
  const focusX = focusConnection?.point.x;
  const focusY = focusConnection?.point.y;
  const internalDimensions = showDimensions && !preview
    ? wallRooms.flatMap((room) => {
        const layout = getRoomDimensionLayout(room, scale);
        return layout ? [{ room, layout }] : [];
      })
    : [];
  const selectedWall = displayedWalls.find((wall) => wall.id === selectedRoomId);
  // What a whole-wall move drags along is derived once per plan state, not per frame.
  const moveContext = useMemo(() => {
    if (tool !== "select" || !selectedRoomId || !walls.some((wall) => wall.id === selectedRoomId)) return null;
    try {
      return wallMoveContext(walls, selectedRoomId);
    } catch {
      return null;
    }
  }, [tool, walls, selectedRoomId]);
  // Junctions and openings keep their offsets during a rigid move, so the committed
  // plan gives the handle one stable place along the wall for the whole gesture.
  const moveHandleObstacles = useMemo((): readonly (readonly [number, number])[] => {
    if (!moveContext) return [];
    return [
      ...moveContext.topology.contacts
        .filter((contact) => contact.wallId === moveContext.wallId)
        .map((contact) => [contact.offset, contact.offset] as const),
      ...openings
        .filter((opening) => opening.wallId === moveContext.wallId)
        .map((opening) => [opening.offset, opening.offset + opening.width] as const),
    ];
  }, [moveContext, openings]);
  const moveHandleAt = (wall: Wall): Point => {
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dy);
    const along = moveHandleOffset(length, moveHandleObstacles, MOVE_HANDLE_CLEARANCE / scale);
    const gap = wall.thickness / 2 + MOVE_HANDLE_GAP / scale;
    return {
      x: wall.start.x + (dx / length) * along - (dy / length) * gap,
      y: wall.start.y + (dy / length) * along + (dx / length) * gap,
    };
  };
  const moveMode: WallMoveMode = keepDirections && moveContext && !moveContext.offsetBlocked ? "offset" : "move";
  const moveDirection = moveContext ? (moveMode === "offset" ? moveContext.normal : moveContext.direction) : null;
  // During a gesture the handle follows the pointer projection, not the moving
  // wall: an offset may lengthen the wall and shift its middle.
  const moveHandle =
    tool === "select" && selectedWall && moveContext?.wallId === selectedWall.id && !wallNodePreview
      ? wallMovePreview
        ? { x: wallMovePreview.origin.x + wallMovePreview.delta.x, y: wallMovePreview.origin.y + wallMovePreview.delta.y }
        : moveHandleAt(selectedWall)
      : null;
  const wallNodeRef = useCallback((node: KonvaNode | null) => {
    // Ref detachment precedes Konva destruction, which otherwise emits dragend.
    if (!node) dragCancelRef.current?.();
  }, []);
  const wallMoveHandleRef = useCallback((node: KonvaNode | null) => {
    // Only a running move belongs to this handle; a node drag hides it on purpose.
    if (!node && wallMoveDragRef.current) dragCancelRef.current?.();
  }, []);

  useEffect(() => {
    boundsRef.current = planBounds(rooms, walls, underlay, openings);
  }, [rooms, walls, underlay, openings]);
  useEffect(() => {
    if (!hostRef.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    activeFocusRequestRef.current = focusRequest;
  }, [focusRequest]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!size.width || !size.height) return;
      // Returning from 3D must keep the requested zoom. A queued initial fit
      // would otherwise change it before focus centers with its captured scale.
      if (activeFocusRequestRef.current !== undefined) return;
      const fitted = fitViewport(boundsRef.current, size.width, size.height);
      onZoomChange(fitted.zoom);
      setCamera({ x: fitted.x, y: fitted.y });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitViewKey, size, onZoomChange]);
  useEffect(() => {
    if (
      focusRequest === undefined ||
      focusedRequestRef.current === focusRequest ||
      focusX === undefined ||
      focusY === undefined ||
      !Number.isFinite(focusX) ||
      !Number.isFinite(focusY) ||
      !size.width ||
      !size.height
    ) return;
    const frame = requestAnimationFrame(() => {
      focusedRequestRef.current = focusRequest;
      setCamera({
        x: size.width / 2 - focusX * scale,
        y: size.height / 2 - focusY * scale,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, focusX, focusY, size, scale]);
  useLayoutEffect(() => {
    const cancel = () => {
      dragCancelRef.current?.();
      gestureRef.current = null;
      calibrationRef.current = null;
      setDraft(null);
      setWallDraft(null);
      setWallNodePreview(null);
      setWallMovePreview(null);
      setCalibration(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    const windowBlur = (event: FocusEvent) => {
      // Capture also sees controls losing focus after pointerdown on the canvas.
      // Only leaving the window should cancel the gesture started by that click.
      if (event.target === window) cancel();
    };
    window.addEventListener("blur", windowBlur, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("blur", windowBlur, true);
      window.removeEventListener("keydown", escape, true);
      cancel();
    };
  }, [tool, imageSource, fitViewKey, walls, selectedRoomId, zoom, focusRequest]);

  const pointer = (event: KonvaEventObject<PointerEvent>): Point | null =>
    event.target.getStage()?.getPointerPosition() ?? null;
  const world = (p: Point): Point => ({
    x: (p.x - camera.x) / scale,
    y: (p.y - camera.y) / scale,
  });
  const gridPoint = (p: Point): Point => ({
    x: snap(world(p).x),
    y: snap(world(p).y),
  });
  const cancel = () => {
    dragCancelRef.current?.();
    gestureRef.current = null;
    calibrationRef.current = null;
    setDraft(null);
    setWallDraft(null);
    setWallNodePreview(null);
    setWallMovePreview(null);
    setCalibration(null);
  };
  const start = (event: KonvaEventObject<PointerEvent>) => {
    const p = pointer(event);
    if (!p) return;
    if (tool === "pan" || event.evt.button === 1) {
      event.evt.preventDefault();
      gestureRef.current = { start: p, last: p, mode: "pan" };
    } else if (tool === "room" && event.evt.button === 0) {
      gestureRef.current = { start: gridPoint(p), last: p, mode: "room" };
      setDraft({ ...gridPoint(p), width: 0, height: 0 });
    } else if (tool === "wall" && event.evt.button === 0) {
      const point = snapWallPoint(world(p), walls, scale);
      gestureRef.current = { start: point, last: point, mode: "wall" };
      setWallDraft({ start: point, end: point });
    } else if (
      (tool === "door" || tool === "window") &&
      event.evt.button === 0
    ) {
      const target = findWallAt(world(p), walls, scale);
      if (target) onPlaceOpening(target.wall.id, target.offset, tool);
    } else if (
      tool === "calibrate" &&
      event.evt.button === 0 &&
      underlay?.visible &&
      visibleImage
    ) {
      const point = underlayPixelAt(world(p), underlay);
      if (!point) return;
      const first = calibrationRef.current;
      if (first) {
        if (Math.hypot(point.x - first.x, point.y - first.y) < 1) return;
        cancel();
        onCalibration(first, point);
      } else {
        calibrationRef.current = point;
        setCalibration({ start: world(p), end: world(p) });
      }
    } else if (event.target === event.target.getStage()) onSelect(null);
  };
  const move = (event: KonvaEventObject<PointerEvent>) => {
    const gesture = gestureRef.current,
      p = pointer(event);
    if (!p) return;
    if (tool === "calibrate" && calibrationRef.current && underlay?.visible) {
      const first = calibrationRef.current;
      if (underlayPixelAt(world(p), underlay))
        setCalibration({
          start: {
            x: underlay.x + first.x * underlay.metersPerPixel,
            y: underlay.y + first.y * underlay.metersPerPixel,
          },
          end: world(p),
        });
    }
    if (!gesture) return;
    if (gesture.mode === "pan") {
      const dx = p.x - gesture.last.x,
        dy = p.y - gesture.last.y;
      setCamera((previous) => ({ x: previous.x + dx, y: previous.y + dy }));
      gesture.last = p;
    } else if (gesture.mode === "wall") {
      const end = snapWallPoint(world(p), walls, scale);
      gesture.last = end;
      setWallDraft({ start: gesture.start, end });
    } else {
      const end = gridPoint(p);
      gesture.last = end;
      setDraft({
        x: Math.min(end.x, gesture.start.x),
        y: Math.min(end.y, gesture.start.y),
        width: snap(Math.abs(end.x - gesture.start.x)),
        height: snap(Math.abs(end.y - gesture.start.y)),
      });
    }
  };
  const finish = (event: KonvaEventObject<PointerEvent>) => {
    if (
      gestureRef.current?.mode === "room" &&
      draft &&
      draft.width >= 0.5 &&
      draft.height >= 0.5
    )
      onCreateRoom(draft);
    if (gestureRef.current?.mode === "wall") {
      const first = gestureRef.current.start;
      const p = pointer(event);
      const end = p
        ? snapWallPoint(world(p), walls, scale)
        : gestureRef.current.last;
      if (Math.hypot(end.x - first.x, end.y - first.y) >= 0.1 - 1e-9)
        onCreateWall(first, end);
    }
    gestureRef.current = null;
    setDraft(null);
    setWallDraft(null);
  };
  const startWallNodeDrag = (event: KonvaEventObject<DragEvent>) => {
    const endpoint = event.target.name();
    const wall = walls.find((item) => item.id === selectedRoomId);
    if (!wall || (endpoint !== "start" && endpoint !== "end")) {
      event.target.stopDrag();
      return;
    }
    dragCancelRef.current?.();
    const expectedPoint = wall[endpoint];
    const drag: WallNodeDrag = {
      wallId: wall.id,
      endpoint,
      expectedPoint,
      point: expectedPoint,
      walls,
    };
    wallNodeDragRef.current = drag;
    const node = event.target;
    dragCancelRef.current = () => {
      dragCancelRef.current = null;
      wallNodeDragRef.current = null;
      node.stopDrag();
      node.position(expectedPoint);
      setWallNodePreview(null);
    };
    if ("buttons" in event.evt && !(event.evt.buttons & 1)) {
      dragCancelRef.current();
      return;
    }
    setWallNodePreview(drag);
  };
  const moveWallNodeDrag = (event: KonvaEventObject<DragEvent>) => {
    const drag = wallNodeDragRef.current;
    if (!drag) return;
    const point = snapWallPoint(
      event.target.position(),
      drag.walls,
      scale,
      drag.expectedPoint,
    );
    event.target.position(point);
    wallNodeDragRef.current = { ...drag, point };
    let preview = drag.walls;
    try {
      preview = previewWallNode(drag.walls, drag.wallId, drag.endpoint, point);
    } catch {
      // Out-of-range coordinates are rejected by the committed operation.
    }
    setWallNodePreview({ ...drag, point, walls: preview });
  };
  const finishWallNodeDrag = (event: KonvaEventObject<DragEvent>) => {
    const drag = wallNodeDragRef.current;
    if (!drag || !dragCancelRef.current) return;
    dragCancelRef.current = null;
    wallNodeDragRef.current = null;
    // Restore first: validation may reject the entire shared-node move.
    event.target.position(drag.expectedPoint);
    setWallNodePreview(null);
    onMoveWallNode(drag.wallId, drag.endpoint, drag.point, drag.expectedPoint);
  };
  const startWallMoveDrag = (event: KonvaEventObject<DragEvent>) => {
    const wall = walls.find((item) => item.id === selectedRoomId);
    if (!wall || !moveContext || !moveDirection || moveContext.wallId !== wall.id) {
      event.target.stopDrag();
      return;
    }
    dragCancelRef.current?.();
    const origin = moveHandleAt(wall);
    const drag: WallMoveDrag = {
      wallId: wall.id,
      context: moveContext,
      mode: moveMode,
      direction: moveDirection,
      origin,
      expected: { start: wall.start, end: wall.end },
      distance: 0,
      walls,
    };
    wallMoveDragRef.current = drag;
    const node = event.target;
    dragCancelRef.current = () => {
      dragCancelRef.current = null;
      wallMoveDragRef.current = null;
      node.stopDrag();
      node.position(origin);
      setWallMovePreview(null);
    };
    if ("buttons" in event.evt && !(event.evt.buttons & 1)) {
      dragCancelRef.current();
      return;
    }
    setWallMovePreview({ wallId: wall.id, origin, delta: { x: 0, y: 0 }, walls });
  };
  const moveWallMoveDrag = (event: KonvaEventObject<DragEvent>) => {
    const drag = wallMoveDragRef.current;
    if (!drag) return;
    // Only the gesture direction of the chosen mode; distance on the 0.1 m grid.
    const { direction } = drag;
    const position = event.target.position();
    const distance = snap(
      (position.x - drag.origin.x) * direction.x + (position.y - drag.origin.y) * direction.y,
    ) + 0;
    const delta = { x: direction.x * distance + 0, y: direction.y * distance + 0 };
    event.target.position({ x: drag.origin.x + delta.x, y: drag.origin.y + delta.y });
    wallMoveDragRef.current = { ...drag, distance };
    let moved = drag.walls;
    try {
      moved = drag.mode === "offset"
        ? previewWallOffset(drag.walls, drag.context, distance)
        : previewWallMove(drag.walls, drag.context, delta);
    } catch {
      // Invalid input is rejected by the committed operation.
    }
    setWallMovePreview({ wallId: drag.wallId, origin: drag.origin, delta, walls: moved });
  };
  const finishWallMoveDrag = (event: KonvaEventObject<DragEvent>) => {
    const drag = wallMoveDragRef.current;
    if (!drag || !dragCancelRef.current) return;
    dragCancelRef.current = null;
    wallMoveDragRef.current = null;
    // Restore first: the command may reject a move that would detach a junction.
    event.target.position(drag.origin);
    setWallMovePreview(null);
    if (drag.distance === 0) return;
    if (drag.mode === "offset") onOffsetWall(drag.wallId, drag.distance, drag.expected);
    else {
      onMoveWall(drag.wallId, { x: drag.direction.x * drag.distance + 0, y: drag.direction.y * drag.distance + 0 }, drag.expected);
    }
  };
  return (
    <div
      className={`plan-canvas cursor-${tool}`}
      ref={hostRef}
      data-testid="plan-canvas"
      data-camera-x={camera.x}
      data-camera-y={camera.y}
      data-scale={scale}
      data-tool={tool}
      data-underlay-loaded={Boolean(visibleImage)}
      data-wall-room-count={wallRooms.length}
      data-wall-candidates={wallCandidates.length}
      data-wall-candidates-selected={wallCandidates.filter((_, index) => wallCandidateSelection[index] !== false).length}
      data-wall-candidate-points={JSON.stringify(wallCandidates.map((candidate) => [
        (candidate.start.x + candidate.end.x) / 2,
        (candidate.start.y + candidate.end.y) / 2,
      ]))}
      data-flagged-rooms={JSON.stringify(flaggedRoomIds.filter((id) => wallRooms.some((room) => room.id === id)))}
      data-wall-connections={JSON.stringify(displayedConnections)}
      data-wall-intersections={JSON.stringify(displayedIntersections)}
      data-door-collisions={JSON.stringify(displayedDoorCollisions)}
      data-door-pair-collisions={JSON.stringify(displayedDoorPairCollisions)}
      data-internal-dimensions={JSON.stringify(internalDimensions.map(({ room, layout }) => ({
        id: room.id, width: layout.width, depth: layout.depth, mode: layout.kind,
      })))}
      data-active-wall-node={
        wallNodePreview
          ? `${wallNodePreview.wallId}:${wallNodePreview.endpoint}`
          : ""
      }
      data-active-wall-move={wallMovePreview?.wallId ?? ""}
      data-wall-move-handle={moveHandle ? `${moveHandle.x},${moveHandle.y}` : ""}
      data-wall-move-direction={
        moveHandle && moveDirection ? `${moveDirection.x},${moveDirection.y}` : ""
      }
      data-wall-move-mode={moveHandle ? moveMode : ""}
      onPointerLeave={(event) => {
        // Konva suppresses hover exits while dragging; the host still receives them.
        if (event.pointerType !== "touch" || event.buttons !== 0) cancel();
      }}
      onPointerCancelCapture={cancel}
      onTouchCancelCapture={cancel}
      aria-label="Интерактивный план. Комнаты, стены и проёмы также доступны в списке слева."
    >
      {size.width > 0 && (
        <Stage
          width={size.width}
          height={size.height}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerLeave={(event) => {
            if (event.evt.pointerType !== "touch" || event.evt.buttons !== 0)
              cancel();
          }}
          onPointerCancel={cancel}
          onWheel={(event) => {
            event.evt.preventDefault();
            const p = event.target.getStage()?.getPointerPosition();
            if (!p) return;
            const nextZoom = clampZoom(
              zoom * (event.evt.deltaY > 0 ? 0.92 : 1.08),
            );
            const ratio = nextZoom / zoom;
            setCamera({
              x: p.x - (p.x - camera.x) * ratio,
              y: p.y - (p.y - camera.y) * ratio,
            });
            onZoomChange(nextZoom);
          }}
        >
          <Layer listening={false}>
            {showGrid && <PlanGrid camera={camera} scale={scale} size={size} />}
          </Layer>
          <Layer>
            <Group x={camera.x} y={camera.y} scaleX={scale} scaleY={scale}>
              {visibleImage && underlay && (
                <KonvaImage
                  image={visibleImage}
                  x={underlay.x}
                  y={underlay.y}
                  width={underlay.pixelWidth * underlay.metersPerPixel}
                  height={underlay.pixelHeight * underlay.metersPerPixel}
                  opacity={underlay.opacity}
                  draggable={tool === "underlay"}
                  listening={tool === "underlay"}
                  onPointerDown={(event) => {
                    if (event.evt.button !== 1) event.cancelBubble = true;
                  }}
                  onDragStart={(event) => {
                    const node = event.target;
                    dragCancelRef.current = () => {
                      dragCancelRef.current = null;
                      node.stopDrag();
                      node.position({ x: underlay.x, y: underlay.y });
                    };
                    if ("buttons" in event.evt && !(event.evt.buttons & 1))
                      dragCancelRef.current();
                  }}
                  onDragEnd={(event) => {
                    if (!dragCancelRef.current) return;
                    dragCancelRef.current = null;
                    const position = event.target.position();
                    event.target.position({ x: underlay.x, y: underlay.y });
                    onMoveUnderlay(snap(position.x), snap(position.y));
                  }}
                />
              )}
              {wallRooms.map((room) => (
                <WallRoomShape
                  key={room.id}
                  room={room}
                  scale={scale}
                  selected={selectedRoomId === room.id}
                  flagged={flaggedRoomIds.includes(room.id)}
                  listening={tool === "select"}
                  translucent={Boolean(visibleImage)}
                  onSelect={onSelect}
                />
              ))}
              {rooms.map((room) => (
                <ManualRoomShape
                  key={room.id}
                  room={room}
                  scale={scale}
                  selected={selectedRoomId === room.id}
                  interactive={tool === "select"}
                  translucent={Boolean(visibleImage)}
                  showDimensions={showDimensions}
                  dragCancelRef={dragCancelRef}
                  onSelect={onSelect}
                  onMove={onMoveRoom}
                />
              ))}
              {displayedWalls.map((wall) => (
                <WallShape
                  key={wall.id}
                  wall={wall}
                  openings={displayedOpenings.filter((opening) => opening.wallId === wall.id)}
                  scale={scale}
                  selectedId={selectedRoomId}
                  interactive={tool === "select"}
                  showDimensions={showDimensions}
                  onSelect={onSelect}
                />
              ))}
              {wallCandidates.length > 0 && (
                <WallCandidateOverlay
                  candidates={wallCandidates}
                  selected={wallCandidateSelection}
                  scale={scale}
                  interactive={tool === "select" && Boolean(onToggleWallCandidate)}
                  onToggle={(index) => onToggleWallCandidate?.(index)}
                />
              )}
              {internalDimensions.map(({ room, layout }) => (
                <WallRoomDimensions
                  key={room.id}
                  layout={layout}
                  selected={selectedRoomId === room.id}
                  background={room.color}
                  translucent={!!visibleImage}
                />
              ))}
              <WallConnectionMarkers
                diagnostics={displayedConnections}
                scale={scale}
              />
              <WallIntersectionMarkers
                intersections={displayedIntersections}
                scale={scale}
              />
              <DoorCollisionMarkers
                collisions={displayedDoorCollisions}
                scale={scale}
              />
              <DoorPairCollisionMarkers
                collisions={displayedDoorPairCollisions}
                scale={scale}
              />
              {tool === "select" && selectedWall &&
                (["start", "end"] as const).map((endpoint) => {
                  const point =
                    wallNodePreview?.wallId === selectedWall.id &&
                    wallNodePreview.endpoint === endpoint
                      ? wallNodePreview.point
                      : selectedWall[endpoint];
                  return (
                    <Circle
                      key={`${selectedWall.id}:${endpoint}`}
                      ref={wallNodeRef}
                      name={endpoint}
                      _useStrictMode
                      {...point}
                      radius={5 / scale}
                      fill="#fff"
                      stroke="#426b50"
                      strokeWidth={1.5 / scale}
                      hitStrokeWidth={16 / scale}
                      draggable
                      onPointerDown={(event) => {
                        if (event.evt.button === 0) event.cancelBubble = true;
                      }}
                      onDragStart={startWallNodeDrag}
                      onDragMove={moveWallNodeDrag}
                      onDragEnd={finishWallNodeDrag}
                    />
                  );
                })}
              {moveHandle && moveDirection && selectedWall && (
                <Group
                  key={`${selectedWall.id}:move`}
                  ref={wallMoveHandleRef}
                  name="move"
                  _useStrictMode
                  {...moveHandle}
                  draggable
                  onPointerDown={(event) => {
                    if (event.evt.button === 0) event.cancelBubble = true;
                  }}
                  onDragStart={startWallMoveDrag}
                  onDragMove={moveWallMoveDrag}
                  onDragEnd={finishWallMoveDrag}
                >
                  <Circle
                    radius={9 / scale}
                    fill="#fff"
                    stroke="#426b50"
                    strokeWidth={1.5 / scale}
                    hitStrokeWidth={18 / scale}
                  />
                  <Arrow
                    points={[
                      (-5.5 * moveDirection.x) / scale,
                      (-5.5 * moveDirection.y) / scale,
                      (5.5 * moveDirection.x) / scale,
                      (5.5 * moveDirection.y) / scale,
                    ]}
                    pointerAtBeginning
                    pointerLength={3 / scale}
                    pointerWidth={4.5 / scale}
                    stroke="#426b50"
                    fill="#426b50"
                    strokeWidth={1.4 / scale}
                    listening={false}
                  />
                </Group>
              )}
              {wallDraft && <WallDraftOverlay draft={wallDraft} scale={scale} />}
              {calibration && tool === "calibrate" && (
                <CalibrationOverlay segment={calibration} scale={scale} />
              )}
              {draft && <RoomDraftOverlay draft={draft} scale={scale} />}
            </Group>
          </Layer>
        </Stage>
      )}
      {internalDimensions.length > 0 && (
        <>
          <p className="plan-dimensions-key">
            Внутри — по граням; снаружи — по осям стен
          </p>
          <ul className="plan-dimensions-accessible" aria-label="Внутренние размеры помещений">
            {internalDimensions.map(({ room, layout }) => (
              <li key={room.id}>
                {room.name}: {formatLength(layout.width)} × {formatLength(layout.depth)} м внутри
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
