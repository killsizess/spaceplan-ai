import type { RoomKind } from "@/domain/floor-plan/types";

export const ROOM_KINDS: Record<RoomKind, { label: string; color: string }> = {
  living: { label: "Гостиная", color: "#e8e5dd" },
  bedroom: { label: "Спальня", color: "#dfe8df" },
  kitchen: { label: "Кухня", color: "#ede3d4" },
  bathroom: { label: "Ванная", color: "#dce8ed" },
  hall: { label: "Прихожая", color: "#eeeae3" },
  other: { label: "Комната", color: "#e5e1ec" },
};

export const ROOM_COLORS = [
  "#e8e5dd",
  "#dfe8df",
  "#ede3d4",
  "#dce8ed",
  "#e5e1ec",
  "#eeded5",
];
