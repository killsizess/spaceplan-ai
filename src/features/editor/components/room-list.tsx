import { tr } from "@/lib/i18n";
import { Check, ChevronRight } from "lucide-react";
import type { Room } from "@/domain/floor-plan/types";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { rectangleArea } from "@/domain/geometry";
import { formatArea, pluralRu } from "@/lib/format";
import { readableRoomInk } from "@/lib/color-contrast";

export type ListedRoom = Room | WallRoom;

export const roomArea = (room: ListedRoom) =>
  "area" in room ? room.area : rectangleArea(room.width, room.height);

/** Room buttons of the «Комнаты» tab; the empty hint depends on the room source. */
export function RoomList({
  rooms,
  selectedId,
  wallMode,
  onSelect,
}: {
  rooms: readonly ListedRoom[];
  selectedId: string | null;
  wallMode: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {rooms.map((room, index) => (
        <button
          key={room.id}
          className={`room-list-item ${room.id === selectedId ? "selected" : ""}`}
          aria-pressed={room.id === selectedId}
          onClick={() => onSelect(room.id)}
        >
          <span
            className="room-list-swatch"
            style={{ backgroundColor: room.color }}
          >
            <span style={{ color: readableRoomInk(room.color, "#718069") }}>{String(index + 1).padStart(2, "0")}</span>
          </span>
          <span className="room-list-copy">
            <strong>{room.name}</strong>
            <span>{formatArea(roomArea(room))}</span>
          </span>
          {room.id === selectedId && <ChevronRight size={14} />}
        </button>
      ))}
      {!rooms.length && (
        <p className="empty-list">
          {wallMode ? (
            tr`Замкните стены, чтобы появились помещения и их площадь.`
          ) : (
            <>{tr`Здесь появятся`}<br />{tr`ваши комнаты`}</>
          )}
        </p>
      )}
    </>
  );
}

/** Total area card under the sidebar with the proportional area bar. */
export function PlanSummary({
  rooms,
  totalArea,
  wallMode,
}: {
  rooms: readonly ListedRoom[];
  totalArea: number;
  wallMode: boolean;
}) {
  return (
    <div className="plan-summary">
      <span className="eyebrow">{tr`ОБЩАЯ ПЛОЩАДЬ`}</span>
      <strong data-testid="total-area">{formatArea(totalArea)}</strong>
      <div>
        <span>{pluralRu(rooms.length, tr`помещение`, tr`помещения`, tr`помещений`)}</span>
        <span className="verified-mark">
          <Check size={12} />{tr` По геометрии`}</span>
      </div>
      <div className="area-bar">
        {rooms.map((room) => (
          <span
            key={room.id}
            style={{
              width: `${totalArea ? (roomArea(room) / totalArea) * 100 : 0}%`,
              backgroundColor: room.color,
            }}
          />
        ))}
      </div>
      <p>{wallMode ? tr`По внутренним контурам, толщина стен вычтена. Балконы, лоджии и шахты не входят.` : tr`Сумма комнат, без вычета толщины стен. Балконы, лоджии и шахты не входят.`}</p>
    </div>
  );
}
