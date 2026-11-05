import { tr } from "@/lib/i18n";
import { currentUnits, scaleBarLength } from "@/lib/units";
import {
  BrickWall,
  DoorOpen,
  Hand,
  Maximize,
  Minus,
  MousePointer2,
  Plus,
  RectangleHorizontal,
  SquareDashed,
} from "lucide-react";
import type { EditorTool } from "../editor-tools";
import { BASE_SCALE, MAX_ZOOM, MIN_ZOOM, clampZoom, scaleBarMeters } from "../viewport";

/** Vertical tool strip on the 2D canvas. */
export function DrawingTools({
  tool,
  hasWalls,
  onTool,
  onRoomTool,
}: {
  tool: EditorTool;
  hasWalls: boolean;
  onTool: (tool: EditorTool) => void;
  /** Drawing a room may first switch the plan to manual rooms. */
  onRoomTool: () => void;
}) {
  return (
    <div className="drawing-tools" aria-label={tr`Инструменты`}>
      <button
        className={tool === "select" ? "active" : ""}
        onClick={() => onTool("select")}
        title={tr`Выбрать и переместить (V)`}
        aria-label={tr`Выбрать`}
        aria-pressed={tool === "select"}
      >
        <MousePointer2 size={19} />
      </button>
      <button
        className={tool === "room" ? "active" : ""}
        onClick={onRoomTool}
        title={tr`Нарисовать комнату (R)`}
        aria-label={tr`Нарисовать комнату`}
        aria-pressed={tool === "room"}
      >
        <SquareDashed size={20} />
      </button>
      <span />
      <button
        className={tool === "wall" ? "active" : ""}
        onClick={() => onTool("wall")}
        title={tr`Начертить стену (W)`}
        aria-label={tr`Нарисовать стену`}
        aria-pressed={tool === "wall"}
      >
        <BrickWall size={20} />
      </button>
      <button
        className={tool === "door" ? "active" : ""}
        onClick={() => onTool("door")}
        title={tr`Поставить дверь на стену (D)`}
        aria-label={tr`Добавить дверь`}
        aria-pressed={tool === "door"}
        disabled={!hasWalls}
      >
        <DoorOpen size={20} />
      </button>
      <button
        className={tool === "window" ? "active" : ""}
        onClick={() => onTool("window")}
        title={tr`Поставить окно на стену`}
        aria-label={tr`Добавить окно`}
        aria-pressed={tool === "window"}
        disabled={!hasWalls}
      >
        <RectangleHorizontal size={20} />
      </button>
      <span />
      <button
        className={tool === "pan" ? "active" : ""}
        onClick={() => onTool("pan")}
        title={tr`Перемещать вид (H)`}
        aria-label={tr`Перемещать вид`}
        aria-pressed={tool === "pan"}
      >
        <Hand size={19} />
      </button>
    </div>
  );
}

export interface ViewLayers {
  grid: boolean;
  dimensions: boolean;
  connections: boolean;
  intersections: boolean;
  doorCollisions: boolean;
}

const LAYER_LABELS: readonly [keyof ViewLayers, string][] = [
  ["grid", tr`Сетка`],
  ["dimensions", tr`Размеры комнат`],
  ["connections", tr`Свободные концы стен`],
  ["intersections", tr`Пересечения стен`],
  ["doorCollisions", tr`Столкновения дверей`],
];

/** Checkbox list of the «Настройки вида» menu. */
export function ViewMenu({
  layers,
  onChange,
}: {
  layers: ViewLayers;
  onChange: (layer: keyof ViewLayers, visible: boolean) => void;
}) {
  return (
    <div className="view-menu">
      {LAYER_LABELS.map(([layer, label]) => (
        <label key={layer}>
          <input
            type="checkbox"
            checked={layers[layer]}
            onChange={(event) => onChange(layer, event.target.checked)}
          />{" "}
          {label}
        </label>
      ))}
    </div>
  );
}

/** Scale bar and zoom buttons under the 2D canvas. */
export function CanvasBottom({
  zoom,
  onZoom,
  onFit,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  onFit: () => void;
}) {
  const metres = scaleBarMeters(zoom);
  const bar = currentUnits() === "imperial"
    ? scaleBarLength(30 / (BASE_SCALE * zoom))
    : { meters: metres, label: tr`${metres} м` };
  return (
    <div className="canvas-bottom">
      <div className="scale-indicator">
        <span style={{ width: bar.meters * BASE_SCALE * zoom }} />
        <small>{bar.label}</small>
      </div>
      <div className="zoom-controls">
        <button
          className="icon-button"
          aria-label={tr`Уменьшить масштаб`}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => onZoom(clampZoom(zoom > 0.2 ? zoom - 0.15 : zoom / 1.5))}
        >
          <Minus size={16} />
        </button>
        <span data-testid="zoom-value">
          {zoom < 0.1
            ? Math.round(zoom * 1000) / 10
            : Math.round(zoom * 100)}
          %
        </span>
        <button
          className="icon-button"
          aria-label={tr`Увеличить масштаб`}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => onZoom(clampZoom(zoom >= 0.2 ? zoom + 0.15 : zoom * 1.5))}
        >
          <Plus size={16} />
        </button>
        <span className="toolbar-divider" />
        <button
          className="icon-button"
          aria-label={tr`Показать весь план`}
          title={tr`Показать весь план (F)`}
          onClick={onFit}
        >
          <Maximize size={16} />
        </button>
      </div>
    </div>
  );
}
