"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { generateVariants, variantSummary, type GeneratedVariant, type GenerationGoal, type GenerationResult, type RejectionReason } from "@/domain/generation/generate-variants";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import { citation } from "@/domain/rules/engine";
import { PlanThumbnail } from "../projects/projects-dialog";
import "../report/plan-report.css";
import "../xray/plan-xray.css";
import "./plan-variants.css";

const GOALS: readonly { value: GenerationGoal; label: string }[] = [
  { value: "any", label: "Всё, что подходит" },
  { value: "more-rooms", label: "Больше комнат" },
  { value: "larger-rooms", label: "Просторнее" },
];

const REJECTIONS: Readonly<Record<RejectionReason, string>> = {
  forbidden: "запрещено правилами",
  "new-problem": "появились новые замечания по правилам",
  geometry: "появились ошибки геометрии",
  requirement: "нарушены требования плана",
  "bathroom-entrance": "вход в санузел оказался бы прямо из комнаты или кухни",
  "not-buildable": "не получилось построить",
};

function VariantCard({ variant, onSave }: { variant: GeneratedVariant; onSave: () => void }) {
  const { rules, overall } = variant;
  const notes = (rules?.findings ?? []).filter((finding) => finding.procedure);
  return (
    <li className="variant-card" data-testid="variant-card" data-procedure={overall ?? "none"}>
      <PlanThumbnail plan={variant.plan} wallRooms={resolveWallRoomLabels(variant.plan).rooms} />
      <div className="variant-card-body">
        <ol className={variant.moves.length > 1 ? "variant-moves several" : "variant-moves"}>{variant.moves.map((move) => <li key={move.text}>{move.text}</li>)}</ol>
        <p className="variant-summary">{variantSummary(variant)}</p>
        {rules && overall ? (
          <span className={`xray-chip procedure-${overall}`} data-testid="variant-procedure">{rules.procedures[overall].label}</span>
        ) : (
          <span className="xray-chip procedure-unknown" data-testid="variant-procedure">
            {rules ? "Порядок не определён" : "Нормы не проверялись"}
          </span>
        )}
        {rules && notes.length > 0 && (
          <details>
            <summary>Почему так: выводов {notes.length}</summary>
            <ul>
              {notes.map((finding, index) => {
                const source = citation(rules, finding);
                return <li key={index}>{finding.title}{source && <small> {source}</small>}</li>;
              })}
            </ul>
          </details>
        )}
        <button type="button" className="primary-button" onClick={onSave}>Сохранить как вариант</button>
      </div>
    </li>
  );
}

function Outcome({
  result,
  onSave,
  onOpenExample,
}: {
  result: GenerationResult;
  onSave: (variant: GeneratedVariant, index: number) => void;
  onOpenExample: () => void;
}) {
  const example = (
    <button type="button" className="secondary-button" onClick={onOpenExample}>Открыть пример для подбора</button>
  );
  if (result.blockers.length) {
    return (
      <>
        <p className="variants-blocker" data-testid="variants-blocker">{result.blockers[0]}</p>
        <div className="variants-controls">{example}</div>
      </>
    );
  }
  const dropped = (Object.keys(REJECTIONS) as RejectionReason[]).filter((reason) => result.rejected[reason] > 0);
  return (
    <>
      <p className="variants-count" data-testid="variants-count">
        Проверено вариантов: {result.tried}. Подходят: {result.variants.length}.
        {dropped.length > 0 && <> Отброшено: {dropped.map((reason) => `${REJECTIONS[reason]} (${result.rejected[reason]})`).join(", ")}.</>}
        {result.untypedWalls > 0 && <> Стены без типа не трогались: {result.untypedWalls}.</>}
      </p>
      {result.variants.length === 0 && (
        <>
          <p className="variants-blocker" data-testid="variants-none">
            Ничего не нашлось. Попробуйте другую цель, отметьте типы стен или ослабьте правила и требования.
          </p>
          <div className="variants-controls">{example}</div>
        </>
      )}
      <ul className="variant-list">
        {result.variants.map((variant, index) => (
          <VariantCard key={variant.key} variant={variant} onSave={() => onSave(variant, index + 1)} />
        ))}
      </ul>
    </>
  );
}

export default function PlanVariantsDialog({
  plan,
  onSave,
  onCompare,
  onOpenExample,
  onClose,
}: {
  plan: FloorPlan;
  onSave: (variant: GeneratedVariant, index: number) => void;
  onCompare: () => void;
  onOpenExample: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [goal, setGoal] = useState<GenerationGoal>("any");
  const [result, setResult] = useState<GenerationResult | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-report-dialog plan-xray-dialog plan-variants-dialog"
      aria-labelledby="plan-variants-title"
      data-testid="variants-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button type="button" className="icon-button modal-close" aria-label="Закрыть подбор вариантов" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-report-header">
        <span className="plan-report-symbol"><Sparkles size={22} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">ПОДБОР ВАРИАНТОВ</span>
          <h2 id="plan-variants-title">{plan.name}</h2>
        </div>
      </header>
      <div className="plan-report-scroll">
        <p className="variants-intro">
          Приложение перебирает только перегородки: убирает, сдвигает или добавляет их. Несущие стены, стены без типа и стены
          санузлов, балконов и шахт не трогает. Это перебор, а не нейросеть, и каждый вариант проверен теми же правилами, что и
          план. Это предложение для обсуждения, а не проект.
        </p>
        <div className="variants-controls">
          <label>
            <span>Что важнее</span>
            <select value={goal} onChange={(event) => { setGoal(event.target.value as GenerationGoal); setResult(null); }}>
              {GOALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="primary-button"
            onClick={() => setResult(generateVariants(plan, { goal, at: new Date().toISOString() }))}
          >
            Подобрать варианты
          </button>
          <button type="button" className="secondary-button" onClick={onCompare}>Сравнить с другим проектом</button>
        </div>
        {result && <Outcome result={result} onSave={onSave} onOpenExample={onOpenExample} />}
      </div>
    </dialog>
  );
}
