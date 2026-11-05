import { addRoom, updateRoom } from "@/domain/floor-plan/operations";
import {
  addWall,
  addWalls,
  addWallsAndOpenings,
  updateWall,
  addOpening,
  updateOpening,
  deleteObject,
  setUnderlay,
  setRoomMode,
  moveWallNode,
  setWallKind,
} from "@/domain/floor-plan/construction";
import { sameWallNode, type WallEndpoint } from "@/domain/floor-plan/wall-nodes";
import { connectWallEndpoints } from "@/domain/floor-plan/connect-wall-endpoints";
import { connectWallJunction } from "@/domain/floor-plan/connect-wall-junction";
import { connectWallIntersection } from "@/domain/floor-plan/connect-wall-intersection";
import { moveWall, offsetWall } from "@/domain/floor-plan/move-wall";
import { addRequirement, removeRequirement } from "@/domain/floor-plan/plan-requirements";
import { withBuildingFacts, withRuleProfile } from "@/domain/floor-plan/building-facts";
import type { WallIntersectionDiagnostic } from "@/domain/floor-plan/wall-intersections";
import type { WallConnectionDiagnostic } from "@/domain/floor-plan/wall-diagnostics";
import type { Point } from "@/domain/geometry";
import {
  addRectangularWallRoom,
  resizeRectangularWallRoom,
  type RectangularWallRoomInput,
  type WallIdTuple,
} from "@/domain/floor-plan/rectangular-wall-room";
import { detectWallRooms, type WallRoom } from "@/domain/floor-plan/wall-rooms";
import {
  setWallRoomLabel,
  assignWallRoomLabel,
  removeWallRoomLabel,
  reconcileWallRoomLabels,
  type WallRoomLabelValues,
} from "@/domain/floor-plan/wall-room-labels";
import type {
  BuildingFacts,
  RuleProfile,
  FloorPlan,
  Room,
  Wall,
  Opening,
  Underlay,
  RoomMode,
  PlanRequirement,
  WallKind,
} from "@/domain/floor-plan/types";

export interface EditorState {
  plan: FloorPlan;
  past: FloorPlan[];
  future: FloorPlan[];
  selectedId: string | null;
  error: string | null;
}
export type EditorAction =
  | { type: "load"; plan: FloorPlan }
  | { type: "select"; id: string | null }
  | { type: "add"; room: Room }
  | { type: "update"; room: Room }
  | { type: "wall:add"; wall: Wall }
  /** Accepted suggestions (walls found in a PDF): one undo step. */
  | { type: "wall:add-many"; walls: readonly Wall[] }
  | { type: "openings:add-many"; walls: readonly Wall[]; openings: readonly Opening[] }
  | { type: "wall:update"; wall: Wall; connectEndpoints?: boolean }
  | { type: "wall:set-kind"; wallId: string; kind: WallKind }
  | { type: "wall:connect-endpoints"; diagnostic: WallConnectionDiagnostic }
  | { type: "wall:connect-junction"; diagnostic: WallConnectionDiagnostic; newWallId: string }
  | { type: "wall:connect-intersection"; diagnostic: WallIntersectionDiagnostic; newWallIds: readonly [string, string] }
  | {
      type: "wall:move";
      wallId: string;
      delta: Point;
      /** Wall position seen when a gesture started; a changed wall rejects the move. */
      expected?: { start: Point; end: Point };
    }
  | {
      type: "wall:offset";
      wallId: string;
      /** Metres along the wall's normal; other walls keep their directions. */
      distance: number;
      expected?: { start: Point; end: Point };
    }
  | { type: "wall-room:add"; input: RectangularWallRoomInput; wallIds: WallIdTuple }
  | { type: "wall-room:resize"; room: WallRoom; width: number; depth: number }
  | { type: "wall-room:label-set"; room: WallRoom; values: WallRoomLabelValues; labelId: string }
  | { type: "wall-room:label-assign"; room: WallRoom; labelId: string }
  | { type: "wall-room:label-remove"; labelId: string }
  | { type: "requirement:add"; requirement: PlanRequirement }
  | { type: "requirement:remove"; id: string }
  /** Answers about the building: one undo step. No answers left removes the field. */
  | { type: "facts:set"; facts: BuildingFacts }
  | { type: "profile:set"; profile: RuleProfile | null }
  | {
      type: "wall:node-move";
      wallId: string;
      endpoint: WallEndpoint;
      point: Point;
      expectedPoint?: Point;
    }
  | { type: "opening:add"; opening: Opening }
  | { type: "opening:update"; opening: Opening }
  | { type: "underlay:set"; underlay: Underlay | null }
  | { type: "roomMode:set"; mode: RoomMode }
  | { type: "delete"; id: string }
  | { type: "replace"; plan: FloorPlan }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clearError" };

export function initialEditorState(plan: FloorPlan): EditorState {
  return {
    plan,
    past: [],
    future: [],
    selectedId:
      (plan.roomMode === "manual" ? plan.rooms[0]?.id : null) ??
      plan.walls[0]?.id ??
      null,
    error: null,
  };
}
/**
 * Selection that survives undo/redo: kept when the object still exists in the
 * restored plan (wall rooms by their stable key), otherwise cleared.
 */
function keptSelection(plan: FloorPlan, id: string | null): string | null {
  if (!id) return null;
  if ([...plan.walls, ...plan.openings, ...plan.rooms].some((item) => item.id === id)) return id;
  if (plan.roomMode === "walls") {
    try {
      if (detectWallRooms(plan.walls).rooms.some((room) => room.id === id)) return id;
    } catch {
      return null;
    }
  }
  return null;
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  if (action.type === "load") return initialEditorState(action.plan);
  if (action.type === "select")
    return { ...state, selectedId: action.id, error: null };
  if (action.type === "clearError") return { ...state, error: null };
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous
      ? {
          plan: previous,
          past: state.past.slice(0, -1),
          future: [state.plan, ...state.future],
          selectedId: keptSelection(previous, state.selectedId),
          error: null,
        }
      : state;
  }
  if (action.type === "redo") {
    const next = state.future[0];
    return next
      ? {
          plan: next,
          past: [...state.past, state.plan],
          future: state.future.slice(1),
          selectedId: keptSelection(next, state.selectedId),
          error: null,
        }
      : state;
  }
  try {
    let plan: FloorPlan;
    let selectedId = state.selectedId;
    if (action.type === "replace") {
      plan = action.plan;
      selectedId = null;
    } else if (action.type === "add") {
      plan = addRoom(state.plan, action.room);
      selectedId = action.room.id;
    } else if (action.type === "update")
      plan = updateRoom(state.plan, action.room);
    else if (action.type === "wall:add") {
      plan = addWall(state.plan, action.wall);
      selectedId = action.wall.id;
    } else if (action.type === "wall:add-many") {
      plan = addWalls(state.plan, action.walls);
      selectedId = null;
    } else if (action.type === "openings:add-many") {
      plan = addWallsAndOpenings(state.plan, action.walls, action.openings);
      selectedId = null;
    } else if (action.type === "wall:update") {
      plan = updateWall(state.plan, action.wall, action.connectEndpoints);
    } else if (action.type === "wall:set-kind") {
      plan = setWallKind(state.plan, action.wallId, action.kind);
      selectedId = action.wallId;
    } else if (action.type === "wall:connect-endpoints") {
      plan = connectWallEndpoints(state.plan, action.diagnostic);
      selectedId = action.diagnostic.wallId;
    } else if (action.type === "wall:connect-junction") {
      plan = connectWallJunction(state.plan, action.diagnostic, action.newWallId);
      selectedId = action.diagnostic.wallId;
    } else if (action.type === "wall:connect-intersection") {
      plan = connectWallIntersection(state.plan, action.diagnostic, action.newWallIds);
      selectedId = action.diagnostic.wallIds[0];
    } else if (action.type === "wall:move") {
      plan = moveWall(state.plan, action.wallId, action.delta, action.expected);
      selectedId = action.wallId;
    } else if (action.type === "wall:offset") {
      plan = offsetWall(state.plan, action.wallId, action.distance, action.expected);
      selectedId = action.wallId;
    } else if (action.type === "wall-room:add") {
      plan = addRectangularWallRoom(state.plan, action.input, action.wallIds);
      selectedId = action.wallIds[0];
    } else if (action.type === "wall-room:resize") {
      plan = resizeRectangularWallRoom(state.plan, action.room, action.width, action.depth);
      // The same four walls bound the resized room, so its derived key stays valid.
      selectedId = action.room.id;
    } else if (action.type === "wall-room:label-set") {
      plan = setWallRoomLabel(state.plan, action.room, action.values, action.labelId);
      selectedId = action.room.id;
    } else if (action.type === "wall-room:label-assign") {
      plan = assignWallRoomLabel(state.plan, action.labelId, action.room);
      selectedId = action.room.id;
    } else if (action.type === "wall-room:label-remove") {
      plan = removeWallRoomLabel(state.plan, action.labelId);
    } else if (action.type === "requirement:add") {
      plan = addRequirement(state.plan, action.requirement);
    } else if (action.type === "requirement:remove") {
      plan = removeRequirement(state.plan, action.id);
    } else if (action.type === "facts:set") {
      plan = withBuildingFacts(state.plan, action.facts);
    } else if (action.type === "profile:set") {
      plan = withRuleProfile(state.plan, action.profile);
    } else if (action.type === "wall:node-move") {
      const wall = state.plan.walls.find((item) => item.id === action.wallId);
      if (!wall) throw new Error("Стена не найдена.");
      if (
        action.expectedPoint &&
        !sameWallNode(wall[action.endpoint], action.expectedPoint)
      ) {
        throw new Error("Стена изменилась во время перемещения. Повторите действие.");
      }
      plan = moveWallNode(state.plan, action.wallId, action.endpoint, action.point);
      selectedId = action.wallId;
    } else if (action.type === "opening:add") {
      plan = addOpening(state.plan, action.opening);
      selectedId = action.opening.id;
    } else if (action.type === "opening:update") {
      plan = updateOpening(state.plan, action.opening);
    } else if (action.type === "underlay:set") {
      plan = setUnderlay(state.plan, action.underlay);
    } else if (action.type === "roomMode:set") {
      plan = setRoomMode(state.plan, action.mode);
      selectedId = null;
    } else {
      plan = deleteObject(state.plan, action.id);
      selectedId = null;
    }
    if (plan === state.plan) return { ...state, selectedId, error: null };
    // A wall type changes no geometry, so no room can change either.
    if ((action.type.startsWith("wall:") && action.type !== "wall:set-kind") || action.type === "openings:add-many" || action.type === "wall-room:add" || action.type === "wall-room:resize" || action.type === "delete" || action.type === "roomMode:set") {
      plan = reconcileWallRoomLabels(state.plan, plan);
    }
    return {
      plan,
      selectedId,
      past: [...state.past.slice(-49), state.plan],
      future: [],
      error: null,
    };
  } catch (error) {
    return {
      ...state,
      error:
        error instanceof Error ? error.message : "Не удалось изменить план.",
    };
  }
}
