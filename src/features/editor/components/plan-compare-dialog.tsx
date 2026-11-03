"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GitCompare, X } from "lucide-react";
import { diffPlans, type CollectionDiff, type PlanMetrics } from "@/domain/floor-plan/plan-diff";
import type { FloorPlan, RoomKind } from "@/domain/floor-plan/types";
import { formatLength } from "@/lib/format";
import { ROOM_KINDS } from "../room-kinds";
import "../plan-check.css";
import "../plan-compare.css";

interface CompareRow {
  label: string;
  before: number;
  after: number;
  unit: "м²" | "м" | "";
}

const number = (value: number) => formatLength(Math.abs(value) < 5e-10 ? 0 : value);
function signed(value: number, unit: string) {
  if (Math.abs(value) < 5e-10) return "—";
  return `${value > 0 ? "+" : "−"}${formatLength(Math.abs(value))}${unit ? ` ${unit}` : ""}`;
}

function rows(before: PlanMetrics, after: PlanMetrics): CompareRow[] {
  const kinds = (Object.keys(ROOM_KINDS) as RoomKind[]).filter((kind) => before.roomsByKind[kind] || after.roomsByKind[kind]);
  return [
    { label: "Площадь помещений", before: before.totalArea, after: after.totalArea, unit: "м²" },
    { label: "Помещений", before: before.roomCount, after: after.roomCount, unit: "" },
    ...kinds.map((kind) => ({
      label: `${ROOM_KINDS[kind].label}: площадь`, before: before.areaByKind[kind], after: after.areaByKind[kind], unit: "м²" as const,
    })),
    { label: "Стен", before: before.wallCount, after: after.wallCount, unit: "" },
    { label: "Длина стен по осям", before: before.wallLength, after: after.wallLength, unit: "м" },
    { label: "Дверей", before: before.doorCount, after: after.doorCount, unit: "" },
    { label: "Окон", before: before.windowCount, after: after.windowCount, unit: "" },
  ];
}

const counts = (diff: CollectionDiff) =>
  `добавлено ${diff.added.length}, удалено ${diff.removed.length}, изменено ${diff.changed.length}`;

export interface CompareCandidate {
  plan: FloorPlan;
}

export default function PlanCompareDialog({
  current,
  candidates,
  onClose,
}: {
  current: FloorPlan;
  /** Other saved projects to compare with, newest first. */
  candidates: readonly CompareCandidate[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState(candidates[0]?.plan.id ?? "");
  const selected = candidates.find((candidate) => candidate.plan.id === selectedId)?.plan ?? candidates[0]?.plan;
  const diff = useMemo(() => (selected ? diffPlans(selected, current) : null), [selected, current]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  function close() {
    dialogRef.current?.close();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-check-dialog plan-compare-dialog"
      aria-labelledby="plan-compare-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <button type="button" className="icon-button modal-close" aria-label="Закрыть сравнение" onClick={close} autoFocus>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-check-header">
        <span className="plan-check-symbol"><GitCompare size={24} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">ВАРИАНТЫ ПЛАНИРОВКИ</span>
          <h2 id="plan-compare-title">Сравнение планов</h2>
          <p title={current.name}>Текущий: {current.name}</p>
        </div>
      </header>
      {!selected || !diff ? (
        <p className="plan-compare-empty">В библиотеке нет других проектов. Создайте вариант кнопкой «Вариант», измените его и сравните с исходным планом.</p>
      ) : (
        <div className="plan-compare-body">
          <label htmlFor="plan-compare-target">Сравнить с проектом</label>
          <select id="plan-compare-target" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
            {candidates.map((candidate) => (
              <option key={candidate.plan.id} value={candidate.plan.id}>{candidate.plan.name}</option>
            ))}
          </select>
          {diff.identical && <p className="plan-compare-same" data-testid="plan-compare-identical">Планы совпадают по стенам, проёмам, помещениям и требованиям.</p>}
          <div className="plan-compare-table-wrap">
            <table className="plan-compare-table">
              <thead>
                <tr><th scope="col">Показатель</th><th scope="col">Выбранный</th><th scope="col">Текущий</th><th scope="col">Разница</th></tr>
              </thead>
              <tbody>
                {rows(diff.before, diff.after).map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{number(row.before)}{row.unit && ` ${row.unit}`}</td>
                    <td>{number(row.after)}{row.unit && ` ${row.unit}`}</td>
                    <td data-sign={Math.sign(Math.abs(row.after - row.before) < 5e-10 ? 0 : row.after - row.before)}>{signed(row.after - row.before, row.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Изменения от выбранного к текущему</h3>
          <ul className="plan-compare-changes" data-testid="plan-compare-changes">
            <li>Стены: {counts(diff.walls)}</li>
            <li>Объём работ по стенам: {formatLength(diff.changedWallLength)} м</li>
            <li>Проёмы: {counts(diff.openings)}; перенесено на плане: {diff.movedOpenings.length}</li>
            <li>Параметры помещений: {counts(diff.wallRoomLabels)}</li>
            <li>Требования: {counts(diff.requirements)}</li>
            {(diff.before.roomMode !== diff.after.roomMode) && <li>Способ расчёта помещений отличается: площади несопоставимы.</li>}
            {(!diff.before.roomsComputed || !diff.after.roomsComputed) && <li>Помещения одного из планов не удалось определить, площади не учтены.</li>}
          </ul>
          <p className="plan-compare-note">
            Сравнение идёт по идентификаторам объектов, поэтому точно для вариантов, созданных из одного проекта. У независимо нарисованных планов все стены окажутся «добавленными» и «удалёнными». Площади и длины считает ядро приложения; это геометрия, а не оценка стоимости или строительная экспертиза.
          </p>
        </div>
      )}
    </dialog>
  );
}
