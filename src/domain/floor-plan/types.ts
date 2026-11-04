import type { Point } from "@/domain/geometry";

export type RoomKind =
  "living" | "bedroom" | "kitchen" | "bathroom" | "hall" | "other";
export type RoomMode = "manual" | "walls";
export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * Structural role of a wall, set by the user and never inferred from geometry or
 * from a drawing. An absent value means "unknown": walls of older projects and walls
 * suggested from a PDF keep no guessed role.
 */
export type WallKind = "bearing" | "partition" | "unknown";
export interface Wall {
  id: string;
  start: Point;
  end: Point;
  thickness: number;
  height: number;
  /** v7. */
  kind?: WallKind;
}
export interface DoorSwing {
  hinge: "start" | "end";
  side: "left" | "right";
}
export interface Opening {
  id: string;
  wallId: string;
  kind: "door" | "window";
  offset: number;
  width: number;
  height: number;
  sillHeight: number;
  /** Relative to the supporting wall's start-to-end direction. Omission means start/left. */
  door?: DoorSwing;
}
export interface Underlay {
  name: string;
  dataUrl: string;
  pixelWidth: number;
  pixelHeight: number;
  x: number;
  y: number;
  metersPerPixel: number;
  opacity: number;
  visible: boolean;
  calibrated: boolean;
}
export interface WallRoomLabel {
  id: string;
  name: string;
  kind: RoomKind;
  color: string;
  /** Last known interior point; never a generated view identifier. */
  anchor: Point;
  /** Physical walls supporting the outer and hole contours. Deleted IDs are retained. */
  boundaryWallIds: string[];
}
/**
 * A requirement the user sets for the layout; checked deterministically against
 * the wall rooms. These are the user's own targets, not building regulations.
 */
export type PlanRequirement =
  /** `labelId` narrows a room requirement to the one room bound to those saved parameters. */
  | { id: string; type: "room-min-area"; kind: RoomKind; minArea: number; labelId?: string }
  | { id: string; type: "room-max-area"; kind: RoomKind; maxArea: number; labelId?: string }
  /** The wall must keep the axis and thickness it had when the requirement was added. */
  | { id: string; type: "wall-fixed"; wallId: string; start: Point; end: Point; thickness: number }
  | { id: string; type: "room-not-walkthrough"; kind: RoomKind; labelId?: string }
  | { id: string; type: "rooms-connected"; kind: RoomKind; otherKind: RoomKind; byDoor: boolean }
  /**
   * v7. The walls that were marked bearing when the requirement was added keep their axis,
   * thickness and bearing mark. Walls marked bearing later are not part of it.
   */
  | { id: string; type: "bearing-walls-kept"; walls: FixedWallGeometry[] };

export interface FixedWallGeometry {
  wallId: string;
  start: Point;
  end: Point;
  thickness: number;
}

/** Geometry of a plan at one moment; enough to compare plans, without the underlay image. */
export interface PlanSnapshot {
  roomMode: RoomMode;
  rooms: Room[];
  walls: Wall[];
  openings: Opening[];
  wallRoomLabels: WallRoomLabel[];
  requirements: PlanRequirement[];
}

/**
 * v7. Where a variant came from: the source project's ID and name and a snapshot of its
 * geometry taken when the variant was made, so a comparison still works after the source
 * was changed or deleted.
 */
export interface PlanOrigin {
  planId: string;
  planName: string;
  /** ISO date and time the variant was created. */
  createdAt: string;
  snapshot: PlanSnapshot;
}

export interface FloorPlan {
  schemaVersion: 7;
  unit: "m";
  id: string;
  name: string;
  roomMode: RoomMode;
  rooms: Room[];
  walls: Wall[];
  openings: Opening[];
  wallRoomLabels: WallRoomLabel[];
  /** User requirements for the layout (v6). */
  requirements: PlanRequirement[];
  underlay?: Underlay;
  /** v7. Present on variants created from another project. */
  origin?: PlanOrigin;
}
