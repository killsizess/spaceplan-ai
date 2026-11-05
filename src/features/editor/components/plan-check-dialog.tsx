"use client";

import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, ClipboardCheck, DoorOpen, Focus, Layers2, Link2, X } from "lucide-react";
import type { PlanDiagnosticItem, PlanDiagnosticKind, PlanDiagnosticReport } from "@/domain/floor-plan/plan-diagnostics";
import type { Opening, Wall } from "@/domain/floor-plan/types";
import "../plan-check.css";

const CATEGORIES: readonly { kind: PlanDiagnosticKind; label: string }[] = [
  { kind: "connections", label: tr`Концы стен` },
  { kind: "intersections", label: tr`Пересечения стен` },
  { kind: "overlaps", label: tr`Наложения стен` },
  { kind: "door-wall", label: tr`Дверь и стена` },
  { kind: "door-pair", label: tr`Дверь и дверь` },
];

type Filter = PlanDiagnosticKind | "all";

function itemText(item: PlanDiagnosticItem, walls: ReadonlyMap<string, number>, doors: ReadonlyMap<string, number>): { title: string; reason: string } {
  const wallNumber = (id: string) => walls.get(id) ?? "—";
  const doorNumber = (id: string) => doors.get(id) ?? "—";
  switch (item.kind) {
    case "connections": {
      const diagnostic = item.diagnostic;
      const wall = wallNumber(diagnostic.wallId);
      const endpoint = diagnostic.endpoint === "start" ? tr`начала` : tr`конца`;
      if (diagnostic.kind === "open") return {
        title: tr`Свободный конец · стена ${wall}`,
        reason: tr`У ${endpoint} стены нет общего узла с другой стеной. Такой конец может быть частью задумки.`,
      };
      const target = wallNumber(diagnostic.target.wallId);
      if (diagnostic.kind === "near-endpoint") {
        const numbers = [walls.get(diagnostic.wallId) ?? 0, walls.get(diagnostic.target.wallId) ?? 0].sort((a, b) => a - b);
        return {
          title: tr`Концы стен ${numbers[0]} и ${numbers[1]} рядом`,
          reason: tr`Между концами ${lengthText(diagnostic.distance)} по осям. Общий узел пока не создан.`,
        };
      }
      if (diagnostic.kind === "junction") return {
        title: tr`T-касание стен ${wall} и ${target}`,
        reason: tr`Конец стены ${wall} касается середины стены ${target}, но общего узла пока нет.`,
      };
      return {
        title: tr`Конец стены ${wall} рядом со стеной ${target}`,
        reason: tr`До оси стены ${target} — ${lengthText(diagnostic.distance)}. Конец ещё не соединён с ней.`,
      };
    }
    case "intersections": {
      const numbers = item.diagnostic.wallIds.map((id) => walls.get(id) ?? 0).sort((a, b) => a - b);
      return {
        title: tr`Стены ${numbers[0]} и ${numbers[1]} пересекаются`,
        reason: tr`Оси пересекаются серединами, но общего узла пока нет.`,
      };
    }
    case "overlaps": {
      const numbers = item.diagnostic.wallIds.map((id) => walls.get(id) ?? 0).sort((a, b) => a - b);
      return {
        title: tr`Стены ${numbers[0]} и ${numbers[1]} лежат друг на друге`,
        reason: tr`Оси совпадают на участке ${lengthText(item.diagnostic.length)}. Площадь не удваивается, но в 3D одна стена может закрыть проёмы другой. Удалите лишнюю стену или сдвиньте её.`,
      };
    }
    case "door-wall": return {
      title: tr`Дверь ${doorNumber(item.diagnostic.doorId)} и стена ${wallNumber(item.diagnostic.wallId)}`,
      reason: tr`Номинальное полотно пересекает стену на пути открывания от 0° до 90°.`,
    };
    case "door-pair": {
      const numbers = item.diagnostic.doorIds.map((id) => doors.get(id) ?? 0).sort((a, b) => a - b);
      return {
        title: tr`Двери ${numbers[0]} и ${numbers[1]}`,
        reason: tr`Зоны открывания от 0° до 90° имеют общую область по высоте. Полотна могут мешать друг другу при разных углах.`,
      };
    }
  }
}

function CategoryIcon({ kind }: { kind: PlanDiagnosticKind }) {
  if (kind === "connections") return <Link2 size={16} aria-hidden="true" />;
  if (kind === "intersections") return <Focus size={16} aria-hidden="true" />;
  if (kind === "overlaps") return <Layers2 size={16} aria-hidden="true" />;
  return <DoorOpen size={16} aria-hidden="true" />;
}

export default function PlanCheckDialog({
  planName,
  walls,
  openings,
  report,
  onLocate,
  onClose,
  busy,
}: {
  planName: string;
  walls: readonly Wall[];
  openings: readonly Opening[];
  report: PlanDiagnosticReport;
  onLocate: (item: PlanDiagnosticItem) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(6);
  const filtered = useMemo(() => filter === "all" ? report.items : report.items.filter((item) => item.kind === filter), [report.items, filter]);
  const wallNumbers = new Map(walls.map((wall, index) => [wall.id, index + 1]));
  const doorNumbers = new Map(openings.filter((opening) => opening.kind === "door").map((door, index) => [door.id, index + 1]));
  const limitedCategories = CATEGORIES.filter(({ kind }) => report.truncated[kind]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  function close() {
    dialogRef.current?.close();
    onClose();
  }

  function changeFilter(next: Filter) {
    setFilter(next);
    setLimit(6);
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-check-dialog"
      aria-labelledby="plan-check-title"
      aria-describedby="plan-check-description"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <button type="button" className="icon-button modal-close" aria-label={tr`Закрыть проверку плана`} onClick={close} autoFocus>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-check-header">
        <span className="plan-check-symbol"><ClipboardCheck size={24} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">{tr`ГЕОМЕТРИЯ ПЛАНИРОВКИ`}</span>
          <h2 id="plan-check-title">{tr`Проверка плана`}</h2>
          <p title={planName}>{planName}</p>
        </div>
      </header>
      <div className="plan-check-summary" aria-live="polite">
        <div>
          <span>{report.incomplete ? tr`Найдено как минимум` : tr`Замечаний в обзоре`}</span>
          <strong data-testid="plan-check-total">{report.total}{report.incomplete ? "+" : ""}</strong>
        </div>
        <p id="plan-check-description">{tr`Пять проверок в одном списке. Выберите замечание, чтобы найти его на 2D-плане.`}</p>
      </div>
      <nav className="plan-check-filters" aria-label={tr`Виды замечаний`}>
        <button type="button" aria-label={tr`Все замечания`} data-testid="plan-check-filter-all" aria-pressed={filter === "all"} onClick={() => changeFilter("all")}>
          <span>{tr`Все замечания`}</span><b>{report.total}{report.incomplete ? "+" : ""}</b>
        </button>
        {CATEGORIES.map(({ kind, label }) => (
          <button type="button" key={kind} aria-label={label} data-testid={`plan-check-filter-${kind}`} aria-pressed={filter === kind} onClick={() => changeFilter(kind)}>
            <span>{label}</span><b>{report.counts[kind]}{report.truncated[kind] ? "+" : ""}</b>
          </button>
        ))}
      </nav>
      <div className="plan-check-body" aria-busy={busy}>
        {limitedCategories.length > 0 && (
          <p className="plan-check-cap" role="status">{tr`Список ограничен в разделах: `}{limitedCategories.map(({ kind, label }) => `${label} (${report.counts[kind]}+)`).join(", ")}{tr`. Полное число замечаний может быть больше показанного.`}</p>
        )}
        {filtered.length ? (
          <>
            <ul className="plan-check-list">
              {filtered.slice(0, limit).map((item) => {
                const { title, reason } = itemText(item, wallNumbers, doorNumbers);
                const category = CATEGORIES.find(({ kind }) => kind === item.kind)!;
                const point = item.diagnostic.point;
                return (
                  <li key={item.id}>
                    <button type="button" data-testid="plan-check-item" data-kind={item.kind} className={`plan-check-row is-${item.kind}`} aria-label={tr`Показать замечание: ${title}`} disabled={busy} onClick={() => onLocate(item)}>
                      <span className="plan-check-kind-icon"><CategoryIcon kind={item.kind} /></span>
                      <span className="plan-check-row-content">
                        <small className="plan-check-kind-label">{category.label}</small>
                        <strong>{title}</strong>
                        <span className="plan-check-reason">{reason}</span>
                        <small className="plan-check-coordinate">X: {lengthText(point.x)}{" · Y: "}{lengthText(point.y)}</small>
                      </span>
                      <ChevronRight className="plan-check-row-arrow" size={15} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {filtered.length > limit && <button className="plan-check-more" type="button" aria-label={tr`Показать ещё`} onClick={() => setLimit((previous) => previous + 6)}>{tr`Показать ещё `}<span>({filtered.length - limit})</span></button>}
          </>
        ) : (
          <div className="plan-check-empty">
            {walls.length ? <Check size={26} aria-hidden="true" /> : <ClipboardCheck size={26} aria-hidden="true" />}
            <h3>{!walls.length ? tr`Добавьте стены, чтобы начать проверку.` : report.total === 0 && !report.incomplete ? tr`По этим проверкам замечаний нет.` : tr`В этом разделе замечаний не найдено.`}</h3>
            <p>{!walls.length ? tr`Ручные комнаты не входят в эти проверки. Начертите стены и добавьте двери.` : tr`Проверяются концы, пересечения и наложения стен, открывание дверей относительно стен и других дверей.`}</p>
          </div>
        )}
      </div>
      <footer className="plan-check-footer">
        <p>{tr`Свободный конец может быть частью задумки. Эти геометрические проверки не оценивают строительные требования.`}</p>
        <button type="button" className="plan-check-return" onClick={close}>{tr`Вернуться к плану`}</button>
      </footer>
    </dialog>
  );
}
