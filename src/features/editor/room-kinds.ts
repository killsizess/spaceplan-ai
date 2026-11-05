import { tr } from "@/lib/i18n";
import type { RoomKind } from "@/domain/floor-plan/types";

export const ROOM_KINDS: Record<RoomKind, { label: string; color: string }> = {
  living: { label: tr`Гостиная`, color: "#f1e3c6" },
  bedroom: { label: tr`Спальня`, color: "#d3ebd8" },
  kitchen: { label: tr`Кухня`, color: "#f8dcc6" },
  bathroom: { label: tr`Ванная`, color: "#cfe7f3" },
  hall: { label: tr`Прихожая`, color: "#ece7da" },
  other: { label: tr`Комната`, color: "#e0d9f2" },
  balcony: { label: tr`Балкон, лоджия`, color: "#f6d6d0" },
  shaft: { label: tr`Вентшахта, короб`, color: "#ece7da" },
};

export const ROOM_COLORS = [
  "#f1e3c6",
  "#d3ebd8",
  "#f8dcc6",
  "#cfe7f3",
  "#e0d9f2",
  "#f6d6d0",
];
