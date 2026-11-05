import { tr } from "@/lib/i18n";
import { ArrowUpRight, BrickWall, ImageUp, MousePointer2, Plus, Ruler, SquareDashed, X } from "lucide-react";
import type { EditorTool } from "../editor-tools";

/** «Быстрый старт» card opened by the help button. */
export function HelpCard({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-card">
      <button
        className="icon-button"
        aria-label={tr`Закрыть справку`}
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <span className="eyebrow">{tr`БЫСТРЫЙ СТАРТ`}</span>
      <h3>{tr`От идеи — к плану`}</h3>
      <p>
        <strong>1.</strong>{tr` Откройте «Подложка», загрузите JPG/PNG или выберите страницу PDF. Укажите масштаб по двум точкам.`}</p>
      <p>
        <strong>2.</strong>{tr` Обведите стены инструментом`}{" "}
        <BrickWall size={13} />{tr`. Двери и окна ставятся нажатием на стену. Точные размеры задаются справа.`}</p>
      <p>
        <strong>3.</strong>{tr` Во вкладке «Комнаты» выберите «По стенам»: замкнутые контуры определят площадь с вычетом стен. Для отдельных прямоугольников используйте режим «Вручную».`}</p>
      <p>
        <strong>4.</strong>{tr` Переключитесь в 3D: тяните модель для вращения, правой кнопкой — для сдвига. Выберите объект, чтобы изменить его размеры справа.`}</p>
      <p>
        <strong>5.</strong>{tr` Отметьте тип каждой стены и нажмите «X-Ray»: он покажет, что можно изменить и что для этого понадобится. Нажмите «Вариант», измените план, и X-Ray сравнит его с исходным.`}</p>
      <div>{tr`Изменения плана сохраняются в этом браузере автоматически. Для резервной копии или переноса используйте экспорт JSON. В списке «Мои проекты» можно открыть другую планировку.`}</div>
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
      <span className="eyebrow">{tr`ЧИСТЫЙ ЛИСТ. ВАШИ ИДЕИ.`}</span>
      <h2>{tr`Дайте пространству форму`}</h2>
      <p>{tr`Загрузите чертёж или нарисуйте`}<br />{tr`прямоугольник на плане.`}</p>
      <button className="primary-button" onClick={onAddRoom}>
        <Plus size={16} />{tr` Добавить первую комнату`}</button>
      <button className="text-button" onClick={onUpload}>
        <ImageUp size={14} />{tr` Загрузить чертёж: DXF, PDF, JPG, PNG`}</button>
      <button className="text-button" onClick={onExample}>{tr`Открыть пример планировки `}<ArrowUpRight size={13} />
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
        ? tr`Масштаб: нажмите две точки на изображении с известным расстоянием`
        : tool === "underlay"
          ? tr`Перетащите подложку в нужное положение`
          : tool === "wall"
            ? tr`Потяните от начала стены к концу · Escape — отменить`
            : tr`Нажмите на стену, чтобы поставить ${tool === "door" ? tr`дверь` : tr`окно`}`}
    </div>
  );
}

/** One-line hint under the workspace for the active tool. */
export function workspaceHint(viewMode: "2d" | "3d", tool: EditorTool, wallSelected: boolean): string {
  if (viewMode === "3d") return tr`Выберите объект в модели или списке, чтобы изменить размеры`;
  return {
    room: tr`Потяните по сетке, чтобы создать комнату от 0,5 × 0,5 м`,
    pan: tr`Потяните по плану, чтобы переместить вид`,
    select: wallSelected ? tr`Угол стены меняет соседние стены; круглая ручка сбоку переносит стену вместе с примыканиями` : tr`Выберите комнату, стену или проём`,
    wall: tr`Стены: привязка к сетке и концам соседних стен`,
    door: tr`Дверь: нажмите на существующую стену`,
    window: tr`Окно: нажмите на существующую стену`,
    calibrate: tr`Две точки на подложке → известная длина в метрах`,
    underlay: tr`Перемещение подложки не двигает стены и комнаты`,
  }[tool];
}

/** Right panel placeholder when nothing is selected. */
export function NothingSelected() {
  return (
    <div className="nothing-selected">
      <div>
        <MousePointer2 size={26} strokeWidth={1.2} />
      </div>
      <h2>{tr`Каждая деталь важна`}</h2>
      <p>{tr`Выберите комнату, стену или проём`}<br />{tr`или в списке, чтобы настроить`}<br />{tr`точные размеры.`}</p>
      <span>
        <Ruler size={14} />{tr` Все размеры — в метрах`}</span>
    </div>
  );
}
