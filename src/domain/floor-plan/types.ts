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
export interface Wall {
  id: string;
  start: Point;
  end: Point;
  thickness: number;
  height: number;
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
  | { id: string; type: "rooms-connected"; kind: RoomKind; otherKind: RoomKind; byDoor: boolean };

export interface FloorPlan {
  schemaVersion: 6;
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
}
