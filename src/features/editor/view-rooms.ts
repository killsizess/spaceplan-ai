import { tr } from "@/lib/i18n";
import type { FloorPlan } from "@/domain/floor-plan/types";
import type { RoomAdjacencyResult } from "@/domain/floor-plan/room-adjacency";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { resolveWallRoomLabels, type WallRoomLabelResolution } from "@/domain/floor-plan/wall-room-labels";
import type { RoomNeighbour } from "./components/wall-room-properties";

/**
 * Rooms shown by the editor in wall mode. View IDs never collide with stored objects,
 * so selection by ID stays unambiguous; detection errors become warnings instead of
 * breaking the editor.
 */
export type ViewRoomDetection = WallRoomLabelResolution & {
  /** Set only when the rooms of a wall plan cannot be computed: the reason, in the user's words. */
  unresolved?: string;
};

export function detectViewRooms(plan: FloorPlan): ViewRoomDetection {
  if (plan.roomMode !== "walls") return { rooms: [], warnings: [], unassigned: [] };
  try {
    const result = resolveWallRoomLabels(plan);
    const occupied = new Set(
      [...plan.rooms, ...plan.walls, ...plan.openings, ...plan.wallRoomLabels].map(
        (object) => object.id,
      ),
    );
    return {
      ...result,
      rooms: result.rooms.map((room) => {
        let id = room.id;
        let suffix = 1;
        while (occupied.has(id)) id = `${room.id}:view-${suffix++}`;
        occupied.add(id);
        return id === room.id ? room : { ...room, id };
      }),
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : tr`Не удалось определить помещения.`;
    return {
      rooms: [],
      unassigned: plan.wallRoomLabels,
      warnings: [reason],
      unresolved: reason,
    };
  }
}

/** Neighbours of one room: rooms joined by a door first, then by longer shared walls. */
export function roomNeighbours(
  room: WallRoom | undefined,
  rooms: readonly WallRoom[],
  adjacency: RoomAdjacencyResult | null,
): RoomNeighbour[] {
  if (!room || !adjacency) return [];
  return adjacency.pairs
    .flatMap((pair) => {
      if (!pair.rooms.includes(room.id)) return [];
      const otherId = pair.rooms[0] === room.id ? pair.rooms[1] : pair.rooms[0];
      const other = rooms.find((item) => item.id === otherId);
      return other ? [{ id: other.id, name: other.name, length: pair.length, doors: pair.doorIds.length }] : [];
    })
    .sort((a, b) => b.doors - a.doors || b.length - a.length);
}
