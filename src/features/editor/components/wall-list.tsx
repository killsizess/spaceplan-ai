import { BrickWall, DoorOpen, RectangleHorizontal } from "lucide-react";
import type { Opening, Wall, WallKind } from "@/domain/floor-plan/types";
import { WALL_KIND_LABELS, wallKindOf } from "@/domain/floor-plan/wall-kind";
import { wallLength } from "@/domain/geometry";
import { formatLength } from "@/lib/format";

const QUICK_KINDS: readonly { kind: WallKind; mark: string }[] = [
  { kind: "bearing", mark: "Н" },
  { kind: "partition", mark: "П" },
  { kind: "unknown", mark: "?" },
];

/**
 * How many walls have a type, and the way to the next one without it. The type comes
 * from documents or a specialist: this only makes marking fast, it never suggests a type.
 */
export function WallKindSummary({
  walls,
  selectedId,
  onSelect,
}: {
  walls: readonly Wall[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!walls.length) return null;
  const bearing = walls.filter((wall) => wallKindOf(wall) === "bearing").length;
  const partition = walls.filter((wall) => wallKindOf(wall) === "partition").length;
  const unknown = walls.length - bearing - partition;
  const selectedIndex = walls.findIndex((wall) => wall.id === selectedId);
  const next =
    walls.slice(selectedIndex + 1).find((wall) => wallKindOf(wall) === "unknown") ??
    walls.find((wall) => wallKindOf(wall) === "unknown");
  return (
    <section className="wall-kind-summary" aria-label="Типы стен" data-testid="wall-kind-summary" data-unknown={unknown}>
      <div className="wall-kind-summary-bar" aria-hidden="true">
        <i className="kind-bearing" style={{ flexGrow: bearing }} />
        <i className="kind-partition" style={{ flexGrow: partition }} />
        <i className="kind-unknown" style={{ flexGrow: unknown }} />
      </div>
      <p>
        Несущих <strong>{bearing}</strong> · перегородок <strong>{partition}</strong> · без типа <strong>{unknown}</strong>
      </p>
      {next ? (
        <button type="button" className="text-button" onClick={() => onSelect(next.id)}>
          Следующая стена без типа
        </button>
      ) : (
        <p className="wall-kind-summary-done">Тип указан у всех стен.</p>
      )}
    </section>
  );
}

/** What the wall colours on the plan mean; shown once a plan has walls. */
export function WallKindLegend({ walls }: { walls: readonly Wall[] }) {
  if (!walls.length) return <div className="wall-kind-legend" />;
  return (
    <div className="wall-kind-legend" data-testid="wall-kind-legend" aria-label="Цвета стен на плане">
      <span><i className="kind-bearing" /> Несущая</span>
      <span><i className="kind-partition" /> Перегородка</span>
      <span><i className="kind-unknown" /> Не указано</span>
    </div>
  );
}

/** Walls of the plan with their openings, in plan order. */
export function WallList({
  walls,
  openings,
  selectedId,
  busy = false,
  onSelect,
  onSetKind,
}: {
  walls: readonly Wall[];
  openings: readonly Opening[];
  selectedId: string | null;
  busy?: boolean;
  onSelect: (id: string) => void;
  onSetKind?: (wallId: string, kind: WallKind) => void;
}) {
  return walls.map((wall, index) => (
    <div className="wall-list-group" key={wall.id}>
      <div className="wall-list-row" data-wall-kind={wallKindOf(wall)}>
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
        {onSetKind && (
          <div className="wall-kind-quick" role="group" aria-label={`Тип стены ${index + 1}`}>
            {QUICK_KINDS.map(({ kind, mark }) => (
              <button
                key={kind}
                type="button"
                disabled={busy}
                className={`kind-${kind}`}
                aria-pressed={wallKindOf(wall) === kind}
                aria-label={`Стена ${index + 1}: ${WALL_KIND_LABELS[kind].toLowerCase()}`}
                title={WALL_KIND_LABELS[kind]}
                onClick={() => onSetKind(wall.id, kind)}
              >
                {mark}
              </button>
            ))}
          </div>
        )}
      </div>
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
