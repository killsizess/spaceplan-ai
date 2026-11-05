import type { Point } from "@/domain/geometry";

export type RoomKind =
  /** `balcony` and `shaft` are v9. */
  "living" | "bedroom" | "kitchen" | "bathroom" | "hall" | "other" | "balcony" | "shaft";
/** Balconies, loggias and shafts are drawn as rooms, but are not part of the total. */
export const countsInTotal = (kind: RoomKind): boolean => kind !== "balcony" && kind !== "shaft";
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
  /** v9. A door-way with no door in it. It connects rooms like a door and has no leaf. */
  doorless?: true;
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

/** What is under or over the apartment, as far as the owner knows. */
export type NeighbourFloor = "same-layout" | "other-layout" | "no-dwelling";

/**
 * v8. What only the owner can know about the apartment and its building. Every field is
 * optional, and an absent one means "not known": no rule treats it as a "no".
 */
export interface BuildingFacts {
  /** Which rule base applies. Without it no regional rules are checked. */
  region?: "moscow" | "other";
  /** The apartment has a gas stove or other gas appliances. */
  gasified?: boolean;
  woodenFloors?: boolean;
  /** Cultural heritage site, or a site identified as one. */
  heritage?: boolean;
  /** The building is officially declared unsafe. */
  emergency?: boolean;
  below?: NeighbourFloor;
  above?: NeighbourFloor;
  /** v9. Which floor the apartment is on, as far as the rules care. */
  floorLevel?: "first" | "upper";
}

/** What a rule in the developer's words is about: a room kind, or any living room. */
export type ProfileTarget = RoomKind | "any-living";

interface ProfileRuleBase {
  id: string;
  /** The developer's own words this rule came from. */
  phrase: string;
}

/** One rule understood from the developer's text. */
export type ProfileRule = ProfileRuleBase & (
  | { type: "room-min-area"; target: ProfileTarget; value: number }
  | { type: "room-max-area"; target: ProfileTarget; value: number }
  | { type: "room-count"; target: ProfileTarget; min?: number; max?: number }
  | { type: "min-height"; value: number }
  | { type: "window-required"; target: ProfileTarget }
  | { type: "no-merge"; target: ProfileTarget; other: ProfileTarget }
  | { type: "keep-bearing" }
  | { type: "keep-room"; target: ProfileTarget }
  | { type: "project-required" }
);

/**
 * v10. Rules for a place with no ready-made rule base, as the developer wrote them. The
 * text is kept with what was understood from it and what was not: nothing is silently
 * dropped, and a phrase that was not understood is not checked.
 */
export interface RuleProfile {
  prompt: string;
  rules: ProfileRule[];
  notUnderstood: string[];
}

/**
 * v11. What recognition proposed from a drawing, kept as it was proposed: everything it
 * offered, accepted or not. Set against the walls a person confirms, it measures how
 * well the drawing was read. Positions are in plan metres.
 */
export interface RecognitionRecord {
  source: "pdf" | "dxf";
  at: string;
  appVersion: string;
  walls?: { start: Point; end: Point; thickness: number }[];
  openings?: { kind: "door" | "window"; center: Point; width: number; confidence: "high" | "low" }[];
}

export interface FloorPlan {
  schemaVersion: 11;
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
  /** v8. */
  buildingFacts?: BuildingFacts;
  /** v10. */
  ruleProfile?: RuleProfile;
  /** v11. */
  recognition?: RecognitionRecord;
}
