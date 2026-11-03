import { Check, ChevronRight } from "lucide-react";
import type { Room } from "@/domain/floor-plan/types";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { rectangleArea } from "@/domain/geometry";
import { formatArea } from "@/lib/format";
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
            "Замкните стены, чтобы появились помещения и их площадь."
          ) : (
            <>
              Здесь появятся
              <br />
              ваши комнаты
            </>
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
      <span className="eyebrow">ОБЩАЯ ПЛОЩАДЬ</span>
      <strong data-testid="total-area">{formatArea(totalArea)}</strong>
      <div>
        <span>{rooms.length} помещений</span>
        <span className="verified-mark">
          <Check size={12} /> По геометрии
        </span>
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
      <p>
        {wallMode ? "По внутренним контурам." : "Сумма площадей комнат."}
        <br />
        {wallMode ? "Толщина стен вычтена." : "Без вычета толщины стен."}
      </p>
    </div>
  );
}
