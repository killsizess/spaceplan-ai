import { tr } from "@/lib/i18n";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { MOSCOW_PACK, PROCEDURE_ORDER } from "./moscow";
import { profilePack } from "./profile-pack";
import type { RuleFinding, RulePack, RuleReport, RuleStatus } from "./types";

/**
 * The rules that apply to a plan: a ready-made base where there is one, otherwise the rules
 * the developer wrote for their own country. With neither, no rules run and the report
 * says so.
 */
export function packForPlan(plan: Pick<FloorPlan, "buildingFacts" | "ruleProfile">): RulePack | null {
  const region = plan.buildingFacts?.region;
  if (region === "moscow") return MOSCOW_PACK;
  if (region === "other" && plan.ruleProfile) return profilePack(plan.ruleProfile);
  return null;
}

/** Where the rule behind a finding stands, from the base and the specialist's sign-offs. */
export function statusOf(finding: Pick<RuleFinding, "ruleId" | "sources">, pack: Pick<RulePack, "kind" | "reviewed" | "signoffs">): RuleStatus {
  if (pack.kind === "owner") return "developer";
  if (!finding.sources.length) return "no-rule";
  const signoff = pack.signoffs?.[finding.ruleId];
  if (signoff) return signoff.status;
  return pack.reviewed ? "confirmed" : "draft";
}

/**
 * A rule a specialist has not confirmed cannot "verify" anything: geometry may be certain,
 * but the reading of the document behind the statement is not. It stays an assumption.
 * The developer's own rules are not a reading of anything: checked as written, they hold
 * or they do not.
 */
function capped(finding: RuleFinding): RuleFinding {
  return finding.status === "draft" && finding.level === "verified" ? { ...finding, level: "assumption" } : finding;
}

export const RULE_STATUS_LABELS: Readonly<Record<RuleStatus, string>> = {
  draft: tr`черновик: прочитано в документе, специалист не сверял`,
  confirmed: tr`подтверждено специалистом`,
  rejected: tr`отклонено специалистом`,
  developer: tr`правило застройщика`,
  "no-rule": tr`без правила: не хватает данных`,
};

export function runRules(pack: RulePack, plan: FloorPlan): RuleReport {
  const { findings, missingFacts, checkedChanges } = pack.check(plan);
  const marked = findings.map((finding) => capped({ ...finding, status: statusOf(finding, pack) }));
  // A rejected rule says nothing about the plan; it is kept aside so the screen can say so.
  const final = marked.filter((finding) => finding.status !== "rejected");
  const withdrawn = marked.filter((finding) => finding.status === "rejected");
  const procedures = checkedChanges ? final.map((finding) => finding.procedure) : [];
  return {
    packId: pack.id,
    kind: pack.kind,
    procedures: pack.procedures,
    notUnderstood: pack.notUnderstood ?? [],
    region: pack.region,
    version: pack.version,
    reviewed: pack.reviewed,
    documents: pack.documents,
    notChecked: pack.notChecked,
    checkedChanges,
    findings: final,
    overall: PROCEDURE_ORDER.find((procedure) => procedures.includes(procedure)) ?? null,
    missingFacts,
    withdrawn,
  };
}

/** The rule report for a plan, or null when no rule base applies to it. */
export function rulesForPlan(plan: FloorPlan): RuleReport | null {
  const pack = packForPlan(plan);
  return pack ? runRules(pack, plan) : null;
}

/** Points that share one of these beginnings are listed together. */
const CLAUSES = [
  { point: tr`прил. 1, п. `, list: tr`прил. 1, пп. ` },
  { point: tr`п. `, list: tr`пп. ` },
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
