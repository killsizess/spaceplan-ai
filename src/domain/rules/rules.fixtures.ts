import { tr } from "@/lib/i18n";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import type { BuildingFacts, FloorPlan, Opening, RoomKind, Wall, WallKind } from "@/domain/floor-plan/types";
import { resolveWallRoomLabels, setWallRoomLabel } from "@/domain/floor-plan/wall-room-labels";
import { pointInRoom } from "./rule-rooms";

export const wall = (id: string, x1: number, y1: number, x2: number, y2: number, kind?: WallKind, height = 2.7): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.2,
  height,
  ...(kind ? { kind } : {}),
});

export const window_ = (id: string, wallId: string, offset: number, width = 1.2): Opening => ({
  id, wallId, kind: "window", offset, width, height: 1.2, sillHeight: 0.9,
});
export const door = (id: string, wallId: string, offset: number, width = 0.9): Opening => ({
  id, wallId, kind: "door", offset, width, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" },
});

export function labelled(plan: FloorPlan, point: { x: number; y: number }, name: string, kind: RoomKind): FloorPlan {
  const room = resolveWallRoomLabels(plan).rooms.find((item) => pointInRoom(point, item));
  if (!room) throw new Error(`No room at ${point.x}, ${point.y}`);
  const existing = room.labelId;
  const values = { name, kind, color: "#f1e3c6" };
  return setWallRoomLabel(plan, room, values, existing ?? `label-${name}`);
}

/**
 * A 10 × 6 m apartment: bearing outer ring; living room on the left, kitchen top right,
 * bathroom bottom right, partitions between them; a window in the living room and in the kitchen.
 */
export function apartment(facts: BuildingFacts = { region: "moscow" }): FloorPlan {
  let plan: FloorPlan = {
    ...createEmptyPlan("xray"),
    name: tr`Квартира`,
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0, "bearing"),
      wall("right", 10, 0, 10, 6, "bearing"),
      wall("bottom", 10, 6, 0, 6, "bearing"),
      wall("left", 0, 6, 0, 0, "bearing"),
      wall("living-kitchen", 6, 0, 6, 3, "partition"),
      wall("living-bath", 6, 3, 6, 6, "partition"),
      wall("kitchen-bath", 6, 3, 10, 3, "partition"),
    ],
    openings: [window_("living-window", "top", 2), window_("kitchen-window", "top", 7)],
    buildingFacts: facts,
  };
  plan = labelled(plan, { x: 3, y: 3 }, tr`Гостиная`, "living");
  plan = labelled(plan, { x: 8, y: 1.5 }, tr`Кухня`, "kitchen");
  plan = labelled(plan, { x: 8, y: 4.5 }, tr`Санузел`, "bathroom");
  return plan;
}

/** A variant of `source` after `edit`, the way the app stores one. */
export function variantOf(source: FloorPlan, edit: (plan: FloorPlan) => FloorPlan): FloorPlan {
  const { origin: _none, ...base } = source;
  void _none;
  return { ...edit(structuredClone(base)), origin: createPlanOrigin(base, "2026-11-05T10:00:00.000Z") };
}
