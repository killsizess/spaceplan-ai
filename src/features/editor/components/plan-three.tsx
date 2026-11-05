"use client";

import { tr } from "@/lib/i18n";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Box, Focus, Layers2, Minus, Plus, Rotate3d } from "lucide-react";
import type { FloorPlan } from "@/domain/floor-plan/types";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import {
  createThreeScene,
  type RendererStatus,
  type ThreeScene,
} from "../three-scene";
import "../plan-three.css";

interface PlanThreeProps {
  plan: FloorPlan;
  wallRooms?: readonly WallRoom[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onReturnTo2D: () => void;
  onCreateExample?: () => void;
  exampleBusy?: boolean;
}

const EMPTY_WALL_ROOMS: readonly WallRoom[] = [];

export default function PlanThree({
  plan,
  wallRooms = EMPTY_WALL_ROOMS,
  selectedId,
  onSelect,
  onReturnTo2D,
  onCreateExample,
  exampleBusy,
}: PlanThreeProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ThreeScene | null>(null);
  const [status, setStatus] = useState<RendererStatus>("loading");
  const helpId = useId();
  const selectCurrent = useEffectEvent((id: string | null) => onSelect(id));

  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    try {
      scene.current = createThreeScene(
        host.current,
        (id) => selectCurrent(id),
        (nextStatus) => {
          if (alive) setStatus(nextStatus);
        },
      );
      host.current.focus({ preventScroll: true });
    } catch {
      queueMicrotask(() => {
        if (alive) setStatus("error");
      });
    }
    return () => {
      alive = false;
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.updatePlan(plan, wallRooms);
  }, [plan, wallRooms]);

  useEffect(() => {
    scene.current?.select(selectedId);
  }, [selectedId]);

  const roomCount =
    plan.roomMode === "walls" ? wallRooms.length : plan.rooms.length;
  const empty = roomCount === 0 && plan.walls.length === 0;
  const exampleButton = onCreateExample && (
    <button type="button" disabled={exampleBusy} onClick={onCreateExample}>{tr`Создать 3D-пример`}</button>
  );

  return (
    <div className="plan-three-shell" data-renderer-status={status}>
      <div
        ref={host}
        className="plan-three-host"
        data-testid="plan-three"
        data-renderer-status={status}
        role="region"
        aria-label={tr`Трёхмерный план`}
        aria-describedby={helpId}
        tabIndex={0}
      />
      {status === "error" ? (
        <div className="plan-three-fallback" role="alert">
          <Box size={32} strokeWidth={1.5} />
          <h3>{tr`3D-просмотр недоступен`}</h3>
          <p>{tr`Браузер не смог запустить или потерял WebGL. План остаётся в редакторе: можно продолжить работу в 2D и затем снова открыть 3D.`}</p>
          <button type="button" onClick={onReturnTo2D}>{tr`Вернуться в 2D`}</button>
        </div>
      ) : (
        <>
          <div className="plan-three-badge">
            <Box size={16} strokeWidth={1.6} />
            <span>{tr`Объёмная модель`}</span>
            <span className="plan-three-badge-dot" />
            <span>{tr`метры`}</span>
          </div>
          <div className="plan-three-controls" aria-label={tr`Камера 3D`}>
            <button
              type="button"
              aria-label={tr`Вписать 3D-план`}
              title={tr`Вписать план · F`}
              onClick={() => scene.current?.fit()}
            >
              <Focus size={18} />
            </button>
            <button
              type="button"
              aria-label={tr`Вид сверху`}
              title={tr`Вид сверху · T`}
              onClick={() => scene.current?.top()}
            >
              <Layers2 size={18} />
            </button>
            <span />
            <button
              type="button"
              aria-label={tr`Приблизить 3D-план`}
              title={tr`Приблизить · +`}
              onClick={() => scene.current?.zoom(0.8)}
            >
              <Plus size={18} />
            </button>
            <button
              type="button"
              aria-label={tr`Отдалить 3D-план`}
              title={tr`Отдалить · −`}
              onClick={() => scene.current?.zoom(1.25)}
            >
              <Minus size={18} />
            </button>
          </div>
          {status === "loading" && (
            <div className="plan-three-loading" role="status">{tr`Подготавливаем 3D…`}</div>
          )}
          {empty ? (
            <div className="plan-three-empty">
              <Rotate3d size={30} strokeWidth={1.4} />
              <h3>{tr`Здесь появится ваш план`}</h3>
              <p>{tr`Добавьте комнаты или стены в 2D — они сразу появятся в объёме.`}</p>
              <button type="button" onClick={onReturnTo2D}>{tr`Начать в 2D`}</button>
              {exampleButton}
            </div>
          ) : (
            <div className="plan-three-summary">
              <strong>
                {roomCount}{tr` комнат · `}{plan.walls.length}{tr` стен ·`}{" "}
                {plan.openings.length}{tr` проёмов`}</strong>
              <span>
                {plan.roomMode === "walls" && roomCount === 0
                  ? tr`Замкните стены в 2D, чтобы определить помещения и показать их полы.`
                  : plan.walls.length === 0
                    ? tr`Показаны полы комнат. Добавьте стены в 2D, чтобы увидеть их высоту.`
                    : tr`Высоты и проёмы взяты из плана. Выберите объект для изменения размеров.`}
              </span>
              {plan.walls.length === 0 && exampleButton}
            </div>
          )}
          <div className="plan-three-help" id={helpId}>
            <Rotate3d size={15} />
            <span>{tr`Тяните — вращение · правая кнопка — сдвиг · колесо — масштаб.`}<span className="plan-three-keyboard-help">
                {" "}{tr`Стрелки — вращение, Shift + стрелки — сдвиг.`}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
