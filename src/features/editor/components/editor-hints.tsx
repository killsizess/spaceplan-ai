import { ArrowUpRight, BrickWall, ImageUp, MousePointer2, Plus, Ruler, SquareDashed, X } from "lucide-react";
import type { EditorTool } from "../editor-tools";

/** «Быстрый старт» card opened by the help button. */
export function HelpCard({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-card">
      <button
        className="icon-button"
        aria-label="Закрыть справку"
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <span className="eyebrow">БЫСТРЫЙ СТАРТ</span>
      <h3>От идеи — к плану</h3>
      <p>
        <strong>1.</strong> Откройте «Подложка», загрузите JPG/PNG или
        выберите страницу PDF. Укажите масштаб по двум точкам.
      </p>
      <p>
        <strong>2.</strong> Обведите стены инструментом{" "}
        <BrickWall size={13} />. Двери и окна ставятся нажатием на
        стену. Точные размеры задаются справа.
      </p>
      <p>
        <strong>3.</strong> Во вкладке «Комнаты» выберите «По стенам»:
        замкнутые контуры определят площадь с вычетом стен. Для
        отдельных прямоугольников используйте режим «Вручную».
      </p>
      <p>
        <strong>4.</strong> Переключитесь в 3D: тяните модель для
        вращения, правой кнопкой — для сдвига. Выберите объект, чтобы
        изменить его размеры справа.
      </p>
      <p>
        <strong>5.</strong> Отметьте тип каждой стены и нажмите «X-Ray»: он
        покажет, что можно изменить и что для этого понадобится. Нажмите
        «Вариант», измените план, и X-Ray сравнит его с исходным.
      </p>
      <div>
        Изменения плана сохраняются в этом браузере автоматически. Для
        резервной копии или переноса используйте экспорт JSON. В
        списке «Мои проекты» можно открыть другую планировку.
      </div>
    </div>
  );
}

/** Call to action on a completely empty plan. */
export function CanvasEmpty({
  onAddRoom,
  onUpload,
  onExample,
}: {
  onAddRoom: () => void;
  onUpload: () => void;
  onExample: () => void;
}) {
  return (
    <div className="canvas-empty">
      <div className="empty-plan-icon">
        <SquareDashed size={32} strokeWidth={1} />
        <Plus size={18} />
      </div>
      <span className="eyebrow">ЧИСТЫЙ ЛИСТ. ВАШИ ИДЕИ.</span>
      <h2>Дайте пространству форму</h2>
      <p>
        Загрузите чертёж или нарисуйте
        <br />
        прямоугольник на плане.
      </p>
      <button className="primary-button" onClick={onAddRoom}>
        <Plus size={16} /> Добавить первую комнату
      </button>
      <button className="text-button" onClick={onUpload}>
        <ImageUp size={14} /> Загрузить чертёж: DXF, PDF, JPG, PNG
      </button>
      <button className="text-button" onClick={onExample}>
        Открыть пример планировки <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

/** Instruction bubble for tools that wait for clicks on the canvas. */
export function ToolInstruction({ tool }: { tool: EditorTool }) {
  if (tool !== "calibrate" && tool !== "underlay" && tool !== "wall" && tool !== "door" && tool !== "window")
    return null;
  return (
    <div className="tool-instruction" role="status">
      {tool === "calibrate"
        ? "Масштаб: нажмите две точки на изображении с известным расстоянием"
        : tool === "underlay"
          ? "Перетащите подложку в нужное положение"
          : tool === "wall"
            ? "Потяните от начала стены к концу · Escape — отменить"
            : `Нажмите на стену, чтобы поставить ${tool === "door" ? "дверь" : "окно"}`}
    </div>
  );
}

/** One-line hint under the workspace for the active tool. */
export function workspaceHint(viewMode: "2d" | "3d", tool: EditorTool, wallSelected: boolean): string {
  if (viewMode === "3d") return "Выберите объект в модели или списке, чтобы изменить размеры";
  return {
    room: "Потяните по сетке, чтобы создать комнату от 0,5 × 0,5 м",
    pan: "Потяните по плану, чтобы переместить вид",
    select: wallSelected ? "Угол стены меняет соседние стены; круглая ручка сбоку переносит стену вместе с примыканиями" : "Выберите комнату, стену или проём",
    wall: "Стены: привязка к сетке и концам соседних стен",
    door: "Дверь: нажмите на существующую стену",
    window: "Окно: нажмите на существующую стену",
    calibrate: "Две точки на подложке → известная длина в метрах",
    underlay: "Перемещение подложки не двигает стены и комнаты",
  }[tool];
}

/** Right panel placeholder when nothing is selected. */
export function NothingSelected() {
  return (
    <div className="nothing-selected">
      <div>
        <MousePointer2 size={26} strokeWidth={1.2} />
      </div>
      <h2>Каждая деталь важна</h2>
      <p>
        Выберите комнату, стену или проём
        <br />
        или в списке, чтобы настроить
        <br />
        точные размеры.
      </p>
      <span>
        <Ruler size={14} /> Все размеры — в метрах
      </span>
    </div>
  );
}
