import { tr } from "@/lib/i18n";
import { floorPlanSchema } from "./schema";
import type { RoomAdjacencyResult } from "./room-adjacency";
import type { FloorPlan, PlanRequirement, RoomKind, Wall } from "./types";

/** Area comparisons tolerate floating-point noise of the contour computation. */
const AREA_TOLERANCE = 1e-9;
/** Same tolerance as shared wall nodes. */
const WALL_TOLERANCE = 1e-9;

/** How a wall that a requirement keeps was changed. `unmarked`: it is no longer bearing. */
export type WallChange = "deleted" | "moved" | "thickness" | "unmarked";

export type RequirementStatus = "met" | "violated" | "no-rooms" | "inactive";

export interface RequirementRoom {
  readonly id: string;
  readonly kind: RoomKind;
  readonly area: number;
  /** Saved parameters bound to the room, if any. */
  readonly labelId?: string;
}

export interface RequirementFinding {
  readonly roomId: string;
  /** Internal area in m² (area requirements). */
  readonly area?: number;
  /** Doors to other rooms and outside (walk-through requirements). */
  readonly doors?: number;
  /** Matching neighbour (connection requirements). */
  readonly otherRoomId?: string;
  /** What happened to a fixed wall; absent when it is unchanged. */
  readonly change?: WallChange;
  /** The wall a finding is about (wall requirements). */
  readonly wallId?: string;
  /** True when this room breaks the requirement. */
  readonly violates: boolean;
}

export interface RequirementResult {
  readonly id: string;
  readonly status: RequirementStatus;
  /** Rooms the requirement looked at, in the given room order. */
  readonly findings: readonly RequirementFinding[];
}

function validated(plan: FloorPlan): FloorPlan {
  const parsed = floorPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom") ?? parsed.error.issues[0];
    throw new Error(issue?.message ?? tr`Проверьте параметры требования.`);
  }
  return parsed.data;
}

/** Adds a requirement in one undoable step; IDs are unique across all plan objects. */
export function addRequirement(plan: FloorPlan, requirement: PlanRequirement): FloorPlan {
  if (plan.requirements.length >= 50) throw new Error(tr`В одном плане может быть не больше 50 требований.`);
  return validated({ ...plan, requirements: [...plan.requirements, requirement] });
}

export function removeRequirement(plan: FloorPlan, id: string): FloorPlan {
  if (!plan.requirements.some((item) => item.id === id)) throw new Error(tr`Требование не найдено.`);
  return validated({ ...plan, requirements: plan.requirements.filter((item) => item.id !== id) });
}

/**
 * Checks each requirement against the computed wall rooms (with the kinds from
 * their saved parameters) and their adjacency. Deterministic, read-only and only
 * as good as the plan: it measures geometry, not building regulations. Manual
 * rectangle mode has no connections, so its requirements are inactive.
 */
export function evaluateRequirements(
  plan: FloorPlan,
  rooms: readonly RequirementRoom[],
  adjacency: RoomAdjacencyResult | null,
): RequirementResult[] {
  const roomsActive = plan.roomMode === "walls" && adjacency !== null;
  return plan.requirements.map((requirement): RequirementResult => {
    if (requirement.type === "wall-fixed") return fixedWall(plan, requirement);
    if (requirement.type === "bearing-walls-kept") return bearingWalls(plan, requirement);
    if (!roomsActive) return { id: requirement.id, status: "inactive", findings: [] };
    return roomRequirement(requirement, rooms, adjacency);
  });
}

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= WALL_TOLERANCE;

/** Same axis (either direction) and thickness as stored; otherwise what changed. */
function wallChange(
  wall: Wall | undefined,
  stored: { start: { x: number; y: number }; end: { x: number; y: number }; thickness: number },
): WallChange | undefined {
  if (!wall) return "deleted";
  const sameAxis = (samePoint(wall.start, stored.start) && samePoint(wall.end, stored.end)) ||
    (samePoint(wall.start, stored.end) && samePoint(wall.end, stored.start));
  if (!sameAxis) return "moved";
  if (Math.abs(wall.thickness - stored.thickness) > WALL_TOLERANCE) return "thickness";
  return undefined;
}

/** A wall the user pinned: same axis (either direction) and thickness as stored. */
function fixedWall(
  plan: FloorPlan,
  requirement: Extract<PlanRequirement, { type: "wall-fixed" }>,
): RequirementResult {
  const change = wallChange(plan.walls.find((item) => item.id === requirement.wallId), requirement);
  return {
    id: requirement.id,
    status: change ? "violated" : "met",
    findings: [{ roomId: "", violates: Boolean(change), ...(change ? { change } : {}) }],
  };
}

/** Every wall that was bearing when the requirement was added keeps its axis, thickness and mark. */
function bearingWalls(
  plan: FloorPlan,
  requirement: Extract<PlanRequirement, { type: "bearing-walls-kept" }>,
): RequirementResult {
  const findings = requirement.walls.map((stored): RequirementFinding => {
    const wall = plan.walls.find((item) => item.id === stored.wallId);
    const change = wallChange(wall, stored) ?? (wall && wall.kind !== "bearing" ? "unmarked" : undefined);
    return { roomId: "", wallId: stored.wallId, violates: Boolean(change), ...(change ? { change } : {}) };
  });
  return { id: requirement.id, status: findings.some((finding) => finding.violates) ? "violated" : "met", findings };
}

/** Captures a wall's current axis and thickness as a "do not change" requirement. */
export function fixedWallRequirement(wall: Wall, id: string): Extract<PlanRequirement, { type: "wall-fixed" }> {
  return {
    id,
    type: "wall-fixed",
    wallId: wall.id,
    start: { x: wall.start.x, y: wall.start.y },
    end: { x: wall.end.x, y: wall.end.y },
    thickness: wall.thickness,
  };
}

/**
 * "Bearing walls kept": a snapshot of the walls marked bearing now. Throws when there are
 * none, so the requirement is never silently empty.
 */
export function bearingWallsRequirement(
  walls: readonly Wall[],
  id: string,
): Extract<PlanRequirement, { type: "bearing-walls-kept" }> {
  const bearing = walls.filter((wall) => wall.kind === "bearing");
  if (!bearing.length) throw new Error(tr`Нет несущих стен: отметьте их в свойствах стены.`);
  return {
    id,
    type: "bearing-walls-kept",
    walls: bearing.map((wall) => ({
      wallId: wall.id,
      start: { x: wall.start.x, y: wall.start.y },
      end: { x: wall.end.x, y: wall.end.y },
      thickness: wall.thickness,
    })),
  };
}

function roomRequirement(
  requirement: Exclude<PlanRequirement, { type: "wall-fixed" | "bearing-walls-kept" }>,
  rooms: readonly RequirementRoom[],
  adjacency: RoomAdjacencyResult,
): RequirementResult {
  const doors = new Map<string, number>();
  for (const pair of adjacency.pairs) {
    for (const id of pair.rooms) doors.set(id, (doors.get(id) ?? 0) + pair.doorIds.length);
  }
  for (const door of adjacency.exteriorDoors) doors.set(door.roomId, (doors.get(door.roomId) ?? 0) + 1);

  {
    // A room requirement bound to saved parameters checks only that room.
    const ofKind = "labelId" in requirement && requirement.labelId !== undefined
      ? rooms.filter((room) => room.labelId === requirement.labelId)
      : rooms.filter((room) => room.kind === requirement.kind);
    if (requirement.type === "room-min-area") {
      const findings = ofKind.map((room) => ({
        roomId: room.id, area: room.area, violates: room.area < requirement.minArea - AREA_TOLERANCE,
      }));
      return { id: requirement.id, status: status(findings), findings };
    }
    if (requirement.type === "room-max-area") {
      const findings = ofKind.map((room) => ({
        roomId: room.id, area: room.area, violates: room.area > requirement.maxArea + AREA_TOLERANCE,
      }));
      return { id: requirement.id, status: status(findings), findings };
    }
    if (requirement.type === "room-not-walkthrough") {
      const findings = ofKind.map((room) => {
        const count = doors.get(room.id) ?? 0;
        return { roomId: room.id, doors: count, violates: count > 1 };
      });
      return { id: requirement.id, status: status(findings), findings };
    }
    const others = rooms.filter((room) => room.kind === requirement.otherKind);
    // Connecting a kind to itself needs two different rooms of that kind.
    const enough = requirement.kind === requirement.otherKind ? ofKind.length >= 2 : ofKind.length > 0 && others.length > 0;
    if (!enough) return { id: requirement.id, status: "no-rooms", findings: [] };
    const findings: RequirementFinding[] = [];
    for (const pair of adjacency.pairs) {
      if (requirement.byDoor && pair.doorIds.length === 0) continue;
      const [a, b] = pair.rooms.map((id) => rooms.find((room) => room.id === id));
      if (!a || !b) continue;
      if (a.kind === requirement.kind && b.kind === requirement.otherKind) {
        findings.push({ roomId: a.id, otherRoomId: b.id, violates: false });
      } else if (b.kind === requirement.kind && a.kind === requirement.otherKind) {
        findings.push({ roomId: b.id, otherRoomId: a.id, violates: false });
      }
    }
    return { id: requirement.id, status: findings.length ? "met" : "violated", findings };
  }
}

/** Rooms that break at least one requirement, unique, in result order (for highlighting). */
export function violatingRoomIds(results: readonly RequirementResult[]): string[] {
  const ids = new Set<string>();
  for (const result of results) {
    for (const finding of result.findings) if (finding.violates && finding.roomId) ids.add(finding.roomId);
  }
  return [...ids];
}

export interface RequirementConflict {
  /** IDs of the requirements that cannot all hold, in plan order. */
  readonly ids: readonly string[];
  /** Certain: impossible for any plan. Otherwise impossible with one room of the kind. */
  readonly certain: boolean;
  readonly reason: "area-range" | "walkthrough-doors";
  readonly kind: RoomKind;
}

/**
 * Requirements that contradict each other regardless of the geometry: a minimum
 * area above a maximum for the same room kind (certain), or a room kind that may
 * not be a passage yet must open by door to two other kinds (impossible when the
 * plan has one room of that kind).
 */
export function findRequirementConflicts(requirements: readonly PlanRequirement[]): RequirementConflict[] {
  const conflicts: RequirementConflict[] = [];
  for (const min of requirements) {
    if (min.type !== "room-min-area") continue;
    for (const max of requirements) {
      // Only limits on the same rooms contradict: the same kind, or the same bound room.
      const sameRooms = min.labelId !== undefined || (max.type === "room-max-area" && max.labelId !== undefined)
        ? max.type === "room-max-area" && max.labelId === min.labelId
        : max.type === "room-max-area" && max.kind === min.kind;
      if (max.type === "room-max-area" && sameRooms && min.minArea > max.maxArea + AREA_TOLERANCE) {
        conflicts.push({ ids: order(requirements, [min.id, max.id]), certain: true, reason: "area-range", kind: min.kind });
      }
    }
  }
  for (const quiet of requirements) {
    if (quiet.type !== "room-not-walkthrough") continue;
    const links = requirements.filter((item): item is Extract<PlanRequirement, { type: "rooms-connected" }> =>
      item.type === "rooms-connected" && item.byDoor && item.kind !== item.otherKind &&
      (item.kind === quiet.kind || item.otherKind === quiet.kind));
    const partners = new Set(links.map((item) => (item.kind === quiet.kind ? item.otherKind : item.kind)));
    if (partners.size >= 2) {
      conflicts.push({
        ids: order(requirements, [quiet.id, ...links.map((item) => item.id)]),
        certain: false,
        reason: "walkthrough-doors",
        kind: quiet.kind,
      });
    }
  }
  return conflicts;
}

function order(requirements: readonly PlanRequirement[], ids: readonly string[]): string[] {
  return requirements.map((item) => item.id).filter((id) => ids.includes(id));
}

function status(findings: readonly RequirementFinding[]): RequirementStatus {
  if (!findings.length) return "no-rooms";
  return findings.some((finding) => finding.violates) ? "violated" : "met";
}
