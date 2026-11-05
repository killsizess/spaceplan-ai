"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ScanSearch, TriangleAlert, X } from "lucide-react";
import type { BuildingFacts, FloorPlan, NeighbourFloor, RuleProfile } from "@/domain/floor-plan/types";
import { WALL_KIND_LABELS } from "@/domain/floor-plan/wall-kind";
import { citation, rulesForPlan } from "@/domain/rules/engine";
import { describeProfileRule } from "@/domain/rules/profile-pack";
import { interpretPrompt } from "@/domain/rules/prompt-rules";
import {
  FLOOR_ANSWERS,
  FLOOR_LABEL,
  NEIGHBOUR_ANSWERS,
  NEIGHBOUR_LABELS,
  REGION_ANSWERS,
  REGION_LABEL,
  UNKNOWN_ANSWER,
  YES_NO_QUESTIONS,
} from "@/domain/rules/facts";
import { PROCEDURE_ORDER, PROCEDURES } from "@/domain/rules/moscow";
import type { ConfidenceLevel, Procedure, RuleFinding, RuleReport, RuleSource } from "@/domain/rules/types";
import { roomsOfPlan } from "@/domain/rules/rule-rooms";
import { buildXray, type PlanXray, type WallPotential, type WorkAnswer } from "@/domain/rules/xray";
import { REPORT_LEVEL_ORDER, REPORT_LEVELS } from "../report/plan-report";
import "../report/plan-report.css";
import "./plan-xray.css";

const YES_NO: readonly { value: string; label: string }[] = [
  { value: "", label: UNKNOWN_ANSWER },
  { value: "yes", label: "Да" },
  { value: "no", label: "Нет" },
];
const NEIGHBOURS = Object.entries(NEIGHBOUR_ANSWERS) as [NeighbourFloor, string][];

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
        <span>{REGION_LABEL}</span>
        <select
          value={facts.region ?? ""}
          onChange={(event) => onFacts({ ...facts, region: (event.target.value || undefined) as BuildingFacts["region"] })}
        >
          <option value="">Не указано</option>
          <option value="moscow">{REGION_ANSWERS.moscow}</option>
          <option value="other">{REGION_ANSWERS.other}</option>
        </select>
      </label>
      {moscow && YES_NO_QUESTIONS.map(({ key, label }) => (
        <label key={key}>
          <span>{label}</span>
          <select value={toAnswer(facts[key])} onChange={(event) => onFacts({ ...facts, [key]: fromAnswer(event.target.value) })}>
            {YES_NO.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      ))}
      {moscow && (
        <label>
          <span>{FLOOR_LABEL}</span>
          <select
            value={facts.floorLevel ?? ""}
            onChange={(event) => onFacts({ ...facts, floorLevel: (event.target.value || undefined) as BuildingFacts["floorLevel"] })}
          >
            <option value="">{UNKNOWN_ANSWER}</option>
            <option value="first">{FLOOR_ANSWERS.first}</option>
            <option value="upper">{FLOOR_ANSWERS.upper}</option>
          </select>
        </label>
      )}
      {moscow && (["below", "above"] as const).map((side) => (
        <label key={side}>
          <span>{NEIGHBOUR_LABELS[side]}</span>
          <select
            value={facts[side] ?? ""}
            onChange={(event) => onFacts({ ...facts, [side]: (event.target.value || undefined) as NeighbourFloor | undefined })}
          >
            <option value="">{UNKNOWN_ANSWER}</option>
            {NEIGHBOURS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      ))}
    </section>
  );
}

const LAST_PROMPT_KEY = "spaceplan-ai:last-rule-prompt:v1";

function readLastPrompt(): string {
  try {
    return window.localStorage.getItem(LAST_PROMPT_KEY) ?? "";
  } catch {
    return "";
  }
}
function rememberPrompt(prompt: string) {
  try {
    window.localStorage.setItem(LAST_PROMPT_KEY, prompt);
  } catch {
    // Only a convenience: the rules themselves are saved in the plan.
  }
}

/** The developer's rules for a place with no ready-made base: written, read back, applied. */
function ProfileEditor({ profile, onProfile }: { profile: RuleProfile | undefined; onProfile: (profile: RuleProfile | null) => void }) {
  const [text, setText] = useState(() => profile?.prompt ?? readLastPrompt());
  return (
    <section className="xray-profile" data-testid="xray-profile" aria-labelledby="xray-profile-title">
      <h3 id="xray-profile-title">Правила застройщика</h3>
      <p>
        Опишите своими словами, что важно в вашей стране или на вашем объекте. Приложение проверит план по этим правилам,
        но не будет сверять их с законами страны.
      </p>
      <label>
        <span>Правила своими словами</span>
        <textarea
          rows={5}
          maxLength={5000}
          value={text}
          placeholder={"Кухня не меньше 9 м². Спальня не меньше 10 м².\nПотолки не ниже 2,6 м. В каждой комнате окно.\nНесущие стены не трогать. Санузлы не переносить.\nKitchen at least 9 m2. Do not merge the kitchen with the living room."}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="xray-profile-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!text.trim()}
          onClick={() => {
            rememberPrompt(text);
            onProfile(interpretPrompt(text));
          }}
        >
          Применить правила
        </button>
        {profile && <button type="button" className="secondary-button" onClick={() => onProfile(null)}>Убрать правила</button>}
      </div>
      <p className="xray-note">
        Текст разбирается по шаблонам, без нейросети: понимает русский и английский и не угадывает. Проверьте, как приложение его поняло.
      </p>
      {profile && (
        <>
          <h4>Как приложение это поняло: {profile.rules.length}</h4>
          <ul data-testid="xray-profile-rules">
            {profile.rules.map((rule) => (
              <li key={rule.id} data-rule-type={rule.type}>
                <strong>{describeProfileRule(rule)}</strong> <small>«{rule.phrase}»</small>
              </li>
            ))}
          </ul>
          {profile.notUnderstood.length > 0 && (
            <>
              <h4>Не понято и не проверяется: {profile.notUnderstood.length}</h4>
              <ul data-testid="xray-profile-not-understood">
                {profile.notUnderstood.map((phrase) => <li key={phrase}>«{phrase}»</li>)}
              </ul>
            </>
          )}
        </>
      )}
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

function ShowButton({ id, onShow }: { id: string; onShow: (id: string) => void }) {
  return <button type="button" className="xray-show" onClick={() => onShow(id)}>Показать на плане</button>;
}

function WallCard({ wall, rules, onShow }: { wall: WallPotential; rules: RuleReport; onShow: (wallId: string) => void }) {
  return (
    <li className="xray-wall" data-testid="xray-wall" data-wall={wall.wallId} data-procedure={wall.removal.procedure}>
      <strong>
        Стена {wall.number} <span>{WALL_KIND_LABELS[wall.kind]}{wall.rooms.length ? ` · ${wall.rooms.join(", ")}` : ""}</span>
      </strong>
      <WallAnswer label="Снос или перенос" answer={wall.removal} rules={rules} />
      <WallAnswer label="Новый проём" answer={wall.opening} rules={rules} />
      <ShowButton id={wall.wallId} onShow={onShow} />
    </li>
  );
}

function Potential({ xray, rules, onShow, onOpenExample }: {
  xray: PlanXray;
  rules: RuleReport;
  onShow: (id: string) => void;
  onOpenExample: () => void;
}) {
  return (
    <section className="xray-potential" aria-labelledby="xray-potential-title">
      <h3 id="xray-potential-title">Что в этой квартире можно изменить</h3>
      {xray.walls.length === 0 && (
        <p className="xray-empty" data-testid="xray-no-walls">
          На плане нет стен. Нарисуйте их или загрузите чертёж, и здесь появится ответ по каждой стене.{" "}
          <button type="button" className="xray-show" onClick={onOpenExample}>Открыть пример со стенами</button>
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
            <summary>{rules.procedures[procedure].label}: стен {walls.length}. <small>{rules.procedures[procedure].meaning}</small></summary>
            <ul>{walls.map((wall) => <WallCard key={wall.wallId} wall={wall} rules={rules} onShow={onShow} />)}</ul>
          </details>
        );
      })}
      {xray.rooms.length > 0 && (
        <>
          <h4>Санузлы, кухни, балконы и шахты</h4>
          <ul className="xray-rooms">
            {xray.rooms.map((room) => (
              <li key={room.roomId} data-testid="xray-room">
                <strong>{room.name}</strong>
                <WallAnswer label={room.action} answer={room.move} rules={rules} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Findings({ rules, targetOf, onShow }: {
  rules: RuleReport;
  targetOf: (finding: RuleFinding) => string | undefined;
  onShow: (id: string) => void;
}) {
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
                const target = targetOf(finding);
                return (
                  <li key={index} data-testid="xray-finding" data-rule={finding.ruleId} data-state={finding.state}>
                    <strong>{finding.title}</strong>
                    {finding.procedure && <ProcedureChip procedure={finding.procedure} />}
                    {finding.detail && <p>{finding.detail}</p>}
                    {source && <small>{source}</small>}
                    {target && <ShowButton id={target} onShow={onShow} />}
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
  onProfile,
  onShow,
  onOpenExample,
  onGenerate,
  onClose,
}: {
  plan: FloorPlan;
  onFacts: (facts: BuildingFacts) => void;
  onProfile: (profile: RuleProfile | null) => void;
  /** Closes the dialog with this wall, opening or room selected on the plan. */
  onShow: (id: string) => void;
  onOpenExample: () => void;
  onGenerate: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rules = useMemo(() => rulesForPlan(plan), [plan]);
  const xray = useMemo(() => (rules ? buildXray(plan) : null), [plan, rules]);
  const facts = plan.buildingFacts ?? {};
  /** The first object the finding names that is on the plan now; a removed wall is not. */
  const targetOf = useMemo(() => {
    const walls = new Set(plan.walls.map((item) => item.id));
    const openings = new Set(plan.openings.map((item) => item.id));
    const rooms = new Set(roomsOfPlan(plan).rooms.map((item) => item.id));
    return (finding: RuleFinding) =>
      finding.wallIds?.find((id) => walls.has(id)) ??
      finding.openingIds?.find((id) => openings.has(id)) ??
      finding.roomIds?.find((id) => rooms.has(id));
  }, [plan]);

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

        {facts.region === "other" && <ProfileEditor profile={plan.ruleProfile} onProfile={onProfile} />}
        {!rules && (
          <p className="xray-no-rules" data-testid="xray-no-rules">
            {facts.region === "other"
              ? "Правила ещё не заданы, поэтому план не проверяется. Готовая база пока есть только для Москвы."
              : "Укажите, где находится квартира. Для другой страны или региона можно задать правила своими словами."}
          </p>
        )}

        {rules && xray && (
          <>
            {rules.kind === "regulation" && !rules.reviewed && (
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
            {!rules.checkedChanges && (
              <p className="xray-hint" data-testid="xray-variant-hint">
                Чтобы проверить изменения, нажмите «Вариант», измените план и откройте X-Ray снова: он сравнит вариант с исходным планом.
                Или{" "}
                <button type="button" className="xray-show" onClick={onGenerate}>подберите варианты автоматически</button>.
              </p>
            )}
            {rules.checkedChanges && rules.overall && (
              <section className="xray-overall" data-testid="xray-overall" data-procedure={rules.overall}>
                <h3>Что понадобится для этого варианта</h3>
                <ProcedureChip procedure={rules.overall} />
                <p>{rules.procedures[rules.overall].meaning}</p>
                {rules.procedures[rules.overall].sources.length > 0 && (
                  <small>{sourcesText(rules, rules.procedures[rules.overall].sources)}</small>
                )}
              </section>
            )}
            <Findings rules={rules} targetOf={targetOf} onShow={onShow} />
            <Potential xray={xray} rules={rules} onShow={onShow} onOpenExample={onOpenExample} />
            <section className="xray-documents" data-testid="xray-documents" aria-labelledby="xray-documents-title">
              <h3 id="xray-documents-title">Документы и редакции</h3>
              <ul>
                {rules.documents.map((document) => (
                  <li key={document.id}>
                    {document.url
                      ? <a href={document.url} target="_blank" rel="noreferrer noopener">{document.title}</a>
                      : <strong>{document.title}</strong>}
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
