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
    <div className="drawing-tools" aria-label="Инструменты">
      <button
        className={tool === "select" ? "active" : ""}
        onClick={() => onTool("select")}
        title="Выбрать и переместить (V)"
        aria-label="Выбрать"
        aria-pressed={tool === "select"}
      >
        <MousePointer2 size={19} />
      </button>
      <button
        className={tool === "room" ? "active" : ""}
        onClick={onRoomTool}
        title="Нарисовать комнату (R)"
        aria-label="Нарисовать комнату"
        aria-pressed={tool === "room"}
      >
        <SquareDashed size={20} />
      </button>
      <span />
      <button
        className={tool === "wall" ? "active" : ""}
        onClick={() => onTool("wall")}
        title="Начертить стену (W)"
        aria-label="Нарисовать стену"
        aria-pressed={tool === "wall"}
      >
        <BrickWall size={20} />
      </button>
      <button
        className={tool === "door" ? "active" : ""}
        onClick={() => onTool("door")}
        title="Поставить дверь на стену (D)"
        aria-label="Добавить дверь"
        aria-pressed={tool === "door"}
        disabled={!hasWalls}
      >
        <DoorOpen size={20} />
      </button>
      <button
        className={tool === "window" ? "active" : ""}
        onClick={() => onTool("window")}
        title="Поставить окно на стену"
        aria-label="Добавить окно"
        aria-pressed={tool === "window"}
        disabled={!hasWalls}
      >
        <RectangleHorizontal size={20} />
      </button>
      <span />
      <button
        className={tool === "pan" ? "active" : ""}
        onClick={() => onTool("pan")}
        title="Перемещать вид (H)"
        aria-label="Перемещать вид"
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
  ["grid", "Сетка"],
  ["dimensions", "Размеры комнат"],
  ["connections", "Свободные концы стен"],
  ["intersections", "Пересечения стен"],
  ["doorCollisions", "Столкновения дверей"],
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
  const scaleMeters = scaleBarMeters(zoom);
  return (
    <div className="canvas-bottom">
      <div className="scale-indicator">
        <span style={{ width: scaleMeters * BASE_SCALE * zoom }} />
        <small>{scaleMeters} м</small>
      </div>
      <div className="zoom-controls">
        <button
          className="icon-button"
          aria-label="Уменьшить масштаб"
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
          aria-label="Увеличить масштаб"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => onZoom(clampZoom(zoom >= 0.2 ? zoom + 0.15 : zoom * 1.5))}
        >
          <Plus size={16} />
        </button>
        <span className="toolbar-divider" />
        <button
          className="icon-button"
          aria-label="Показать весь план"
          title="Показать весь план (F)"
          onClick={onFit}
        >
          <Maximize size={16} />
        </button>
      </div>
    </div>
  );
}
