import type { FloorPlan } from "@/domain/floor-plan/types";
import { MOSCOW_PACK, PROCEDURE_ORDER } from "./moscow";
import type { RuleFinding, RulePack, RuleReport } from "./types";

/**
 * The rule base that applies to a plan: only the one the owner chose. Without a chosen
 * region no regional rules run, and the report says so.
 */
export function packForPlan(plan: Pick<FloorPlan, "buildingFacts">): RulePack | null {
  return plan.buildingFacts?.region === "moscow" ? MOSCOW_PACK : null;
}

/**
 * Rules a specialist has not confirmed cannot "verify" anything: geometry may be certain,
 * but the reading of the document behind the statement is not. They stay an assumption.
 */
function capped(finding: RuleFinding, reviewed: boolean): RuleFinding {
  return !reviewed && finding.level === "verified" ? { ...finding, level: "assumption" } : finding;
}

export function runRules(pack: RulePack, plan: FloorPlan): RuleReport {
  const { findings, missingFacts, checkedChanges } = pack.check(plan);
  const final = findings.map((finding) => capped(finding, pack.reviewed));
  const procedures = checkedChanges ? final.map((finding) => finding.procedure) : [];
  return {
    packId: pack.id,
    region: pack.region,
    version: pack.version,
    reviewed: pack.reviewed,
    documents: pack.documents,
    notChecked: pack.notChecked,
    checkedChanges,
    findings: final,
    overall: PROCEDURE_ORDER.find((procedure) => procedures.includes(procedure)) ?? null,
    missingFacts,
  };
}

/** The rule report for a plan, or null when no rule base applies to it. */
export function rulesForPlan(plan: FloorPlan): RuleReport | null {
  const pack = packForPlan(plan);
  return pack ? runRules(pack, plan) : null;
}

/** Points that share one of these beginnings are listed together. */
const CLAUSES = [
  { point: "прил. 1, п. ", list: "прил. 1, пп. " },
  { point: "п. ", list: "пп. " },
];

/** «508-ПП, прил. 1, пп. 9.3, 9.6; ПП РФ № 47, п. 24; ЖК РФ, ст. 25, ч. 2; ст. 26, ч. 2, п. 3». */
export function citation(report: Pick<RuleReport, "documents">, finding: Pick<RuleFinding, "sources">): string {
  const byDocument = new Map<string, string[]>();
  for (const source of finding.sources) {
    byDocument.set(source.document, [...(byDocument.get(source.document) ?? []), source.point]);
  }
  return [...byDocument]
    .map(([id, points]) => {
      const short = report.documents.find((item) => item.id === id)?.short ?? id;
      const clause = CLAUSES.find(({ point: start }) => points.every((point) => point.startsWith(start)));
      const listed = clause && points.length > 1
        ? `${clause.list}${points.map((point) => point.slice(clause.point.length)).join(", ")}`
        : points.join("; ");
      return `${short}, ${listed}`;
    })
    .join("; ");
}
