import { BrickWall, DoorOpen, RectangleHorizontal } from "lucide-react";
import type { Opening, Wall } from "@/domain/floor-plan/types";
import { WALL_KIND_LABELS, wallKindOf } from "@/domain/floor-plan/wall-kind";
import { wallLength } from "@/domain/geometry";
import { formatLength } from "@/lib/format";

/** Walls of the plan with their openings, in plan order. */
export function WallList({
  walls,
  openings,
  selectedId,
  onSelect,
}: {
  walls: readonly Wall[];
  openings: readonly Opening[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return walls.map((wall, index) => (
    <div className="wall-list-group" key={wall.id}>
      <button
        className={`construction-item ${selectedId === wall.id ? "selected" : ""}`}
        aria-label={`Выбрать стену ${index + 1}`}
        onClick={() => onSelect(wall.id)}
      >
        <BrickWall size={16} />
        <span>
          Стена {index + 1}
          <small>
            {formatLength(wallLength(wall.start, wall.end))} м ·{" "}
            {formatLength(wall.thickness)} м
            {wallKindOf(wall) !== "unknown" && <> · {WALL_KIND_LABELS[wallKindOf(wall)].toLowerCase()}</>}
          </small>
        </span>
      </button>
      {openings
        .filter((opening) => opening.wallId === wall.id)
        .map((opening, openingIndex) => (
          <button
            key={opening.id}
            className={`construction-item opening-item ${selectedId === opening.id ? "selected" : ""}`}
            aria-label={`Выбрать ${opening.kind === "door" ? "дверь" : "окно"} ${index + 1}.${openingIndex + 1}`}
            onClick={() => onSelect(opening.id)}
          >
            {opening.kind === "door" ? (
              <DoorOpen size={15} />
            ) : (
              <RectangleHorizontal size={15} />
            )}
            <span>
              {opening.kind === "door" ? "Дверь" : "Окно"}
              <small>
                {formatLength(opening.width)} ×{" "}
                {formatLength(opening.height)} м
              </small>
            </span>
          </button>
        ))}
    </div>
  ));
}
