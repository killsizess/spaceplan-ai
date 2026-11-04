import type { RoomKind } from "@/domain/floor-plan/types";

export const ROOM_KINDS: Record<RoomKind, { label: string; color: string }> = {
  living: { label: "Гостиная", color: "#f1e3c6" },
  bedroom: { label: "Спальня", color: "#d3ebd8" },
  kitchen: { label: "Кухня", color: "#f8dcc6" },
  bathroom: { label: "Ванная", color: "#cfe7f3" },
  hall: { label: "Прихожая", color: "#ece7da" },
  other: { label: "Комната", color: "#e0d9f2" },
};

export const ROOM_COLORS = [
  "#f1e3c6",
  "#d3ebd8",
  "#f8dcc6",
  "#cfe7f3",
  "#e0d9f2",
  "#f6d6d0",
];
