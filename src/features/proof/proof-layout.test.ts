import { describe, expect, it } from "vitest";
import { createVariantsExamplePlan } from "@/domain/generation/example-flat";
import { planAskingToRemove } from "@/domain/generation/generate-variants";
import { REPORT_PAGE, type MeasureText } from "../report/report-layout";
import { buildPlanProof, type PlanProof } from "./plan-proof";
import { layoutPlanProof } from "./proof-layout";

const measure: MeasureText = (text, size) => text.length * size * 0.5;
const AT = "2026-11-05T10:00:00.000Z";
const proofOf = (wallId: string): PlanProof => {
  const asked = planAskingToRemove(createVariantsExamplePlan(), wallId, AT);
  if (!asked) throw new Error("No plan results");
  return buildPlanProof(asked, { generatedAt: AT, appVersion: "9.9.9", question: "Что, если убрать стену" });
};
const textOf = (proof: PlanProof) =>
  layoutPlanProof(proof, measure).flatMap((page) => page.ops).flatMap((op) => (op.kind === "text" ? [op.text] : [])).join(" ");

describe("the proof on paper", () => {
  it("carries the chain, what would change it, its limits and the fingerprint", () => {
    const proof = proofOf("living-kitchen");
    const text = textOf(proof);
    for (const part of ["Что, если убрать стену", "Что меняется и почему", "Что изменит вывод", "Газифицированная", "На чём это держится", "Границы этого вывода", "Нет данных"]) {
      expect(text.replace(/\s+/g, " ")).toContain(part);
    }
    expect(text).toContain(proof.fingerprint.slice(0, 9));
  });

  it("keeps everything on the page, and numbers the pages", () => {
    const long: PlanProof = { ...proofOf("living-kitchen") };
    long.decisions = Array.from({ length: 30 }, (_, index) => ({ ...long.decisions[0], id: String(index) }));
    const pages = layoutPlanProof(long, measure);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, index) => {
      for (const op of page.ops) {
        expect(op.y).toBeGreaterThanOrEqual(0);
        expect(op.y).toBeLessThanOrEqual(REPORT_PAGE.height);
        expect(op.x).toBeGreaterThanOrEqual(0);
        expect(op.x).toBeLessThanOrEqual(REPORT_PAGE.width);
      }
      const footer = page.ops.flatMap((op) => (op.kind === "text" ? [op.text] : []));
      expect(footer).toContain(`Стр. ${index + 1} из ${pages.length}`);
      expect(footer.some((line) => line.includes("9.9.9"))).toBe(true);
    });
  });

  it("does not offer alternatives without rules, and says so at the top", () => {
    const asked = planAskingToRemove({ ...createVariantsExamplePlan(), buildingFacts: undefined } as never, "living-kitchen", AT);
    const text = textOf(buildPlanProof(asked as never, { generatedAt: AT, appVersion: "x" }));
    expect(text).toContain("Нормы не проверялись");
    expect(text).not.toContain("Что изменит вывод");
  });
});
