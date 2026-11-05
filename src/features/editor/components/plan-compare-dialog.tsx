"use client";

import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { useEffect, useMemo, useRef, useState } from "react";
import { GitCompare, X } from "lucide-react";
import { diffPlans, type CollectionDiff, type PlanMetrics } from "@/domain/floor-plan/plan-diff";
import { originNote, originStatus, planFromOrigin } from "@/domain/floor-plan/plan-origin";
import type { FloorPlan, RoomKind } from "@/domain/floor-plan/types";
import { rulesForPlan } from "@/domain/rules/engine";
import { PROCEDURES } from "@/domain/rules/moscow";
import { formatArea, formatLength } from "@/lib/format";
import { ROOM_KINDS } from "../room-kinds";
import "../plan-check.css";
import "../plan-compare.css";

interface CompareRow {
  label: string;
  before: number;
  after: number;
  kind: "area" | "length" | "count";
}

const clean = (value: number) => (Math.abs(value) < 5e-10 ? 0 : value);
const number = (value: number, kind: CompareRow["kind"]) =>
  kind === "area" ? formatArea(clean(value)) : kind === "length" ? lengthText(clean(value)) : formatLength(clean(value));
function signed(value: number, kind: CompareRow["kind"]) {
  if (Math.abs(value) < 5e-10) return "—";
  return `${value > 0 ? "+" : "−"}${number(Math.abs(value), kind)}`;
}

function rows(before: PlanMetrics, after: PlanMetrics): CompareRow[] {
  const kinds = (Object.keys(ROOM_KINDS) as RoomKind[]).filter((kind) => before.roomsByKind[kind] || after.roomsByKind[kind]);
  return [
    { label: tr`Площадь помещений`, before: before.totalArea, after: after.totalArea, kind: "area" },
    { label: tr`Помещений`, before: before.roomCount, after: after.roomCount, kind: "count" },
    ...kinds.map((kind) => ({
      label: tr`${ROOM_KINDS[kind].label}: площадь`, before: before.areaByKind[kind], after: after.areaByKind[kind], kind: "area" as const,
    })),
    { label: tr`Стен`, before: before.wallCount, after: after.wallCount, kind: "count" },
    { label: tr`Длина стен по осям`, before: before.wallLength, after: after.wallLength, kind: "length" },
    { label: tr`Дверей`, before: before.doorCount, after: after.doorCount, kind: "count" },
    { label: tr`Окон`, before: before.windowCount, after: after.windowCount, kind: "count" },
  ];
}

const counts = (diff: CollectionDiff) =>
  tr`добавлено ${diff.added.length}, удалено ${diff.removed.length}, изменено ${diff.changed.length}`;

export interface CompareCandidate {
  plan: FloorPlan;
}

/** Choice value for the source of a variant; project IDs never look like this. */
const ORIGIN_VALUE = "origin:snapshot";

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
  const { origin } = current;
  // The source as it was when the variant was made: available even if the project is gone.
  const originPlan = useMemo(() => (origin ? planFromOrigin(origin) : null), [origin]);
  const status = useMemo(
    () => (origin ? originStatus(origin, candidates.map((candidate) => candidate.plan)) : null),
    [origin, candidates],
  );
  const [selectedId, setSelectedId] = useState(originPlan ? ORIGIN_VALUE : candidates[0]?.plan.id ?? "");
  const useOrigin = Boolean(originPlan) && (selectedId === ORIGIN_VALUE || !candidates.some((candidate) => candidate.plan.id === selectedId));
  const selected = useOrigin
    ? originPlan!
    : (candidates.find((candidate) => candidate.plan.id === selectedId)?.plan ?? candidates[0]?.plan);
  const diff = useMemo(() => (selected ? diffPlans(selected, current) : null), [selected, current]);
  const procedures = useMemo(() => ({
    current: rulesForPlan(current)?.overall ?? null,
    selected: selected ? rulesForPlan(selected)?.overall ?? null : null,
  }), [selected, current]);

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
      <button type="button" className="icon-button modal-close" aria-label={tr`Закрыть сравнение`} onClick={close} autoFocus>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-check-header">
        <span className="plan-check-symbol"><GitCompare size={24} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">{tr`ВАРИАНТЫ ПЛАНИРОВКИ`}</span>
          <h2 id="plan-compare-title">{tr`Сравнение планов`}</h2>
          <p title={current.name}>{tr`Текущий: `}{current.name}</p>
        </div>
      </header>
      {!selected || !diff ? (
        <p className="plan-compare-empty">{tr`В библиотеке нет других проектов. Создайте вариант кнопкой «Вариант», измените его и сравните с исходным планом.`}</p>
      ) : (
        <div className="plan-compare-body">
          <label htmlFor="plan-compare-target">{tr`Сравнить с проектом`}</label>
          <select id="plan-compare-target" value={useOrigin ? ORIGIN_VALUE : selected.id} onChange={(event) => setSelectedId(event.target.value)}>
            {originPlan && origin && (
              <option value={ORIGIN_VALUE}>{tr`Исходный план «`}{origin.planName}{tr`» на момент создания варианта`}</option>
            )}
            {candidates.map((candidate) => (
              <option key={candidate.plan.id} value={candidate.plan.id}>{candidate.plan.name}</option>
            ))}
          </select>
          {origin && status && (
            <p className="plan-compare-origin" data-testid="plan-compare-origin-note" data-origin-status={status}>
              {originNote(origin, status)}
            </p>
          )}
          {(procedures.current || procedures.selected) && (
            <p className="plan-compare-rules" data-testid="plan-compare-rules">{tr`По нормам: `}{procedures.current ? tr`этот план: ${PROCEDURES[procedures.current].label.toLowerCase()}` : tr`этот план не сравнивался с исходным`}
              {"; "}
              {procedures.selected ? tr`выбранный: ${PROCEDURES[procedures.selected].label.toLowerCase()}` : tr`выбранный не сравнивался с исходным`}.
            </p>
          )}
          {diff.identical && <p className="plan-compare-same" data-testid="plan-compare-identical">{tr`Планы совпадают по стенам, проёмам, помещениям и требованиям.`}</p>}
          <div className="plan-compare-table-wrap">
            <table className="plan-compare-table">
              <thead>
                <tr><th scope="col">{tr`Показатель`}</th><th scope="col">{tr`Выбранный`}</th><th scope="col">{tr`Текущий`}</th><th scope="col">{tr`Разница`}</th></tr>
              </thead>
              <tbody>
                {rows(diff.before, diff.after).map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{number(row.before, row.kind)}</td>
                    <td>{number(row.after, row.kind)}</td>
                    <td data-sign={Math.sign(Math.abs(row.after - row.before) < 5e-10 ? 0 : row.after - row.before)}>{signed(row.after - row.before, row.kind)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{tr`Изменения от выбранного к текущему`}</h3>
          <ul className="plan-compare-changes" data-testid="plan-compare-changes">
            <li>{tr`Стены: `}{counts(diff.walls)}</li>
            <li>{tr`Объём работ по стенам: `}{lengthText(diff.changedWallLength)}</li>
            <li>{tr`Проёмы: `}{counts(diff.openings)}{tr`; перенесено на плане: `}{diff.movedOpenings.length}</li>
            <li>{tr`Параметры помещений: `}{counts(diff.wallRoomLabels)}</li>
            <li>{tr`Требования: `}{counts(diff.requirements)}</li>
            {(diff.before.roomMode !== diff.after.roomMode) && <li>{tr`Способ расчёта помещений отличается: площади несопоставимы.`}</li>}
            {(!diff.before.roomsComputed || !diff.after.roomsComputed) && <li>{tr`Помещения одного из планов не удалось определить, площади не учтены.`}</li>}
          </ul>
          <p className="plan-compare-note">{tr`Сравнение идёт по идентификаторам объектов, поэтому точно для вариантов, созданных из одного проекта. У независимо нарисованных планов все стены окажутся «добавленными» и «удалёнными». Площади и длины считает ядро приложения; это геометрия, а не оценка стоимости или строительная экспертиза.`}</p>
        </div>
      )}
    </dialog>
  );
}
