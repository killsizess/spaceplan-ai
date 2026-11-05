"use client";

import { useEffect, useMemo, useRef } from "react";
import { ScanSearch, TriangleAlert, X } from "lucide-react";
import type { BuildingFacts, FloorPlan, NeighbourFloor } from "@/domain/floor-plan/types";
import { WALL_KIND_LABELS } from "@/domain/floor-plan/wall-kind";
import { citation, rulesForPlan } from "@/domain/rules/engine";
import { PROCEDURE_ORDER, PROCEDURES } from "@/domain/rules/moscow";
import type { ConfidenceLevel, Procedure, RuleReport, RuleSource } from "@/domain/rules/types";
import { buildXray, type PlanXray, type WallPotential, type WorkAnswer } from "@/domain/rules/xray";
import { REPORT_LEVEL_ORDER, REPORT_LEVELS } from "../report/plan-report";
import "../report/plan-report.css";
import "./plan-xray.css";

const YES_NO: readonly { value: string; label: string }[] = [
  { value: "", label: "Не знаю" },
  { value: "yes", label: "Да" },
  { value: "no", label: "Нет" },
];
const NEIGHBOURS: readonly { value: "" | NeighbourFloor; label: string }[] = [
  { value: "", label: "Не знаю" },
  { value: "same-layout", label: "Такая же планировка" },
  { value: "other-layout", label: "Другая планировка" },
  { value: "no-dwelling", label: "Квартир нет" },
];
const BOOLEAN_FACTS: readonly { key: "gasified" | "woodenFloors" | "heritage" | "emergency"; label: string }[] = [
  { key: "gasified", label: "В квартире есть газ" },
  { key: "woodenFloors", label: "Перекрытия деревянные" },
  { key: "heritage", label: "Дом — объект культурного наследия" },
  { key: "emergency", label: "Дом признан аварийным" },
];

const toAnswer = (value: boolean | undefined) => (value === undefined ? "" : value ? "yes" : "no");
const fromAnswer = (value: string) => (value === "" ? undefined : value === "yes");

function ProcedureChip({ procedure }: { procedure: Procedure }) {
  return <span className={`xray-chip procedure-${procedure}`} data-procedure={procedure}>{PROCEDURES[procedure].label}</span>;
}

function sourcesText(rules: Pick<RuleReport, "documents">, sources: readonly RuleSource[]) {
  return citation(rules, { sources });
}

function Facts({ facts, onFacts }: { facts: BuildingFacts; onFacts: (facts: BuildingFacts) => void }) {
  const moscow = facts.region === "moscow";
  return (
    <section className="xray-facts" aria-label="О квартире и доме">
      <label>
        <span>Где находится квартира</span>
        <select
          value={facts.region ?? ""}
          onChange={(event) => onFacts({ ...facts, region: (event.target.value || undefined) as BuildingFacts["region"] })}
        >
          <option value="">Не указано</option>
          <option value="moscow">Москва</option>
          <option value="other">Другой регион</option>
        </select>
      </label>
      {moscow && BOOLEAN_FACTS.map(({ key, label }) => (
        <label key={key}>
          <span>{label}</span>
          <select value={toAnswer(facts[key])} onChange={(event) => onFacts({ ...facts, [key]: fromAnswer(event.target.value) })}>
            {YES_NO.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      ))}
      {moscow && (["below", "above"] as const).map((side) => (
        <label key={side}>
          <span>{side === "below" ? "Этажом ниже" : "Этажом выше"}</span>
          <select
            value={facts[side] ?? ""}
            onChange={(event) => onFacts({ ...facts, [side]: (event.target.value || undefined) as NeighbourFloor | undefined })}
          >
            {NEIGHBOURS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      ))}
    </section>
  );
}

function WallAnswer({ label, answer, rules }: { label: string; answer: WorkAnswer; rules: RuleReport }) {
  const sources = sourcesText(rules, answer.sources);
  return (
    <div className="xray-answer">
      <span className="xray-answer-label">{label}</span>
      <ProcedureChip procedure={answer.procedure} />
      <p>{answer.reason}{sources && <small> {sources}</small>}</p>
    </div>
  );
}

function WallCard({ wall, rules, onShow }: { wall: WallPotential; rules: RuleReport; onShow: (wallId: string) => void }) {
  return (
    <li className="xray-wall" data-testid="xray-wall" data-wall={wall.wallId} data-procedure={wall.removal.procedure}>
      <strong>
        Стена {wall.number} <span>{WALL_KIND_LABELS[wall.kind]}{wall.rooms.length ? ` · ${wall.rooms.join(", ")}` : ""}</span>
      </strong>
      <WallAnswer label="Снос или перенос" answer={wall.removal} rules={rules} />
      <WallAnswer label="Новый проём" answer={wall.opening} rules={rules} />
      <button type="button" className="xray-show" onClick={() => onShow(wall.wallId)}>Показать на плане</button>
    </li>
  );
}

function Potential({ xray, rules, onShow }: { xray: PlanXray; rules: RuleReport; onShow: (wallId: string) => void }) {
  return (
    <section className="xray-potential" aria-labelledby="xray-potential-title">
      <h3 id="xray-potential-title">Что в этой квартире можно изменить</h3>
      {xray.walls.length === 0 && (
        <p className="xray-empty" data-testid="xray-no-walls">
          На плане нет стен. Нарисуйте их или загрузите чертёж, и здесь появится ответ по каждой стене.
        </p>
      )}
      {xray.walls.length > 0 && (
        <dl className="xray-counts" data-testid="xray-counts">
          {PROCEDURE_ORDER.map((procedure) => (
            <div key={procedure}>
              <dt><ProcedureChip procedure={procedure} /></dt>
              <dd data-testid={`xray-count-${procedure}`}>{xray.counts[procedure]}</dd>
            </div>
          ))}
        </dl>
      )}
      {PROCEDURE_ORDER.map((procedure) => {
        const walls = xray.walls.filter((wall) => wall.removal.procedure === procedure);
        if (!walls.length) return null;
        return (
          <details key={procedure} open={xray.walls.length <= 12} className="xray-group">
            <summary>{PROCEDURES[procedure].label}: стен {walls.length}. <small>{PROCEDURES[procedure].meaning}</small></summary>
            <ul>{walls.map((wall) => <WallCard key={wall.wallId} wall={wall} rules={rules} onShow={onShow} />)}</ul>
          </details>
        );
      })}
      {xray.rooms.length > 0 && (
        <>
          <h4>Санузлы и кухни</h4>
          <ul className="xray-rooms">
            {xray.rooms.map((room) => (
              <li key={room.roomId} data-testid="xray-room">
                <strong>{room.name}</strong>
                <WallAnswer label="Перенос" answer={room.move} rules={rules} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Findings({ rules }: { rules: RuleReport }) {
  return (
    <section className="xray-findings" aria-labelledby="xray-findings-title">
      <h3 id="xray-findings-title">Выводы по правилам</h3>
      {REPORT_LEVEL_ORDER.map((level: ConfidenceLevel) => {
        const items = rules.findings.filter((finding) => finding.level === level);
        if (!items.length) return null;
        return (
          <div key={level} className={`xray-level level-${level}`}>
            <h4>{REPORT_LEVELS[level].label} <span>{items.length}</span></h4>
            <ul>
              {items.map((finding, index) => {
                const source = citation(rules, finding);
                return (
                  <li key={index} data-testid="xray-finding" data-rule={finding.ruleId} data-state={finding.state}>
                    <strong>{finding.title}</strong>
                    {finding.procedure && <ProcedureChip procedure={finding.procedure} />}
                    {finding.detail && <p>{finding.detail}</p>}
                    {source && <small>{source}</small>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export default function PlanXrayDialog({
  plan,
  onFacts,
  onShowWall,
  onClose,
}: {
  plan: FloorPlan;
  onFacts: (facts: BuildingFacts) => void;
  /** Closes the dialog with the wall selected on the plan. */
  onShowWall: (wallId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rules = useMemo(() => rulesForPlan(plan), [plan]);
  const xray = useMemo(() => (rules ? buildXray(plan) : null), [plan, rules]);
  const facts = plan.buildingFacts ?? {};

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog plan-report-dialog plan-xray-dialog"
      aria-labelledby="plan-xray-title"
      data-testid="xray-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button type="button" className="icon-button modal-close" aria-label="Закрыть X-Ray" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
      <header className="plan-report-header">
        <span className="plan-report-symbol"><ScanSearch size={22} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">X-RAY КВАРТИРЫ</span>
          <h2 id="plan-xray-title">{plan.name}</h2>
        </div>
      </header>

      <div className="plan-report-scroll">
        <Facts facts={facts} onFacts={onFacts} />

        {!rules && (
          <p className="xray-no-rules" data-testid="xray-no-rules">
            {facts.region === "other"
              ? "Для этого региона базы правил пока нет: нормы не проверяются. Сейчас есть только база для Москвы."
              : "Укажите, где находится квартира. Правила берутся только для выбранного региона."}
          </p>
        )}

        {rules && xray && (
          <>
            {!rules.reviewed && (
              <p className="xray-draft" data-testid="xray-draft">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>
                  <strong>Черновик базы правил.</strong> Правила прочитаны в документах, но специалист их ещё не сверил.
                  Это подсказка, а не заключение: окончательно решают проект и Мосжилинспекция.
                </span>
              </p>
            )}
            {rules.missingFacts.length > 0 && (
              <p className="xray-missing" data-testid="xray-missing">
                Без ответов выше часть выводов остаётся без данных. Осталось вопросов: {rules.missingFacts.length}.
              </p>
            )}
            {rules.checkedChanges && rules.overall && (
              <section className="xray-overall" data-testid="xray-overall" data-procedure={rules.overall}>
                <h3>Что понадобится для этого варианта</h3>
                <ProcedureChip procedure={rules.overall} />
                <p>{PROCEDURES[rules.overall].meaning}</p>
                {PROCEDURES[rules.overall].sources.length > 0 && (
                  <small>{sourcesText(rules, PROCEDURES[rules.overall].sources)}</small>
                )}
              </section>
            )}
            <Findings rules={rules} />
            <Potential xray={xray} rules={rules} onShow={onShowWall} />
            <section className="xray-documents" data-testid="xray-documents" aria-labelledby="xray-documents-title">
              <h3 id="xray-documents-title">Документы и редакции</h3>
              <ul>
                {rules.documents.map((document) => (
                  <li key={document.id}>
                    <a href={document.url} target="_blank" rel="noreferrer noopener">{document.title}</a>
                    <p>{document.edition}</p>
                    <p>{document.gaps}</p>
                  </li>
                ))}
              </ul>
            </section>
            <section className="xray-not-checked" data-testid="xray-not-checked" aria-labelledby="xray-not-checked-title">
              <h3 id="xray-not-checked-title">Что база не проверяет</h3>
              <ul>{rules.notChecked.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
          </>
        )}
      </div>
    </dialog>
  );
}
