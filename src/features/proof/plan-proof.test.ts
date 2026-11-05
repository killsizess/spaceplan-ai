import { describe, expect, it } from "vitest";
import { createVariantsExamplePlan } from "@/domain/generation/example-flat";
import { generateVariants, planAskingToRemove } from "@/domain/generation/generate-variants";
import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { rulesForPlan } from "@/domain/rules/engine";
import { interpretPrompt } from "@/domain/rules/prompt-rules";
import { door, variantOf, wall } from "@/domain/rules/rules.fixtures";
import { buildPlanProof, planFingerprint } from "./plan-proof";

const AT = "2026-11-05T10:00:00.000Z";
const meta = { generatedAt: AT, appVersion: "test" };
const example = createVariantsExamplePlan();

function ask(plan: FloorPlan, wallId: string): FloorPlan {
  const asked = planAskingToRemove(plan, wallId, AT);
  if (!asked) throw new Error("No plan results");
  return asked;
}
const proofOf = (plan: FloorPlan, wallId: string) => buildPlanProof(ask(plan, wallId), meta);

describe("the answer and its chain", () => {
  it("names the decision, the rule and the input it rests on", () => {
    const proof = proofOf(example, "living-bedroom");
    expect(proof.status).toBe("checked");
    expect(proof.answer.procedure).toBe("simplified");
    expect(proof.answer.label).toBe("Упрощённый порядок");
    expect(proof.decisions).toHaveLength(1);
    const [decision] = proof.decisions;
    expect(decision.text).toBe("Убрать стену 5 (перегородка) между «Гостиная» и «Спальня»");
    expect(decision.procedure).toBe("simplified");
    expect(decision.reasons[0].citation).toContain("508-ПП");
    expect(decision.reasons[0].dependsOn).toContain("Тип стены 5: перегородка");
    expect(decision.reasons[0].decisive).toBe(true);
  });

  it("says a draft is a draft while nobody has confirmed the rules", () => {
    expect(proofOf(example, "living-bedroom").draftNote).toContain("черновик");
  });

  it("never claims anything is allowed", () => {
    const proof = proofOf(example, "living-kitchen");
    const text = JSON.stringify(proof).toLowerCase();
    expect(text).not.toMatch(/разрешено|допустимо[^г]/);
  });

  it("keeps what the rules say of the variant as a whole apart, and marks what decided", () => {
    const proof = proofOf(example, "living-kitchen");
    expect(proof.answer.procedure).toBe("unknown");
    expect(proof.decisions[0].procedure).toBe("simplified");
    const decisive = proof.general.filter((reason) => reason.decisive);
    expect(decisive.map((reason) => reason.title)).toContain("Границы кухни изменены или кухни нет на прежнем месте");
    expect(proof.decisions[0].reasons.every((reason) => !reason.decisive)).toBe(true);
  });

  it("tells a step the rules are silent on from a step they allow", () => {
    const proof = proofOf({ ...example, buildingFacts: { region: "moscow" } }, "living-kitchen");
    expect(proof.decisions[0].procedure).toBeNull();
    expect(proof.decisions[0].reasons).toEqual([]);
    expect(proof.answer.procedure).toBe("unknown");
  });

  it("does not call two rooms along an outer wall rooms on its two sides", () => {
    const { decisions } = proofOf(example, "top");
    expect(decisions[0].text).toBe("Убрать стену 1 (несущая), помещения «Гостиная», «Спальня»");
    expect(decisions[0].procedure).toBe("specialist");
  });
});

describe("what would change the answer", () => {
  it("is found by running the rules again, not by a list", () => {
    const proof = proofOf(example, "living-kitchen");
    const gas = proof.alternatives.find((item) => item.subject === "В квартире есть газ");
    expect(gas).toMatchObject({ current: "Нет", answer: "Да", procedure: "forbidden", label: "Не допускается" });
    expect(gas?.because.join()).toContain("Газифицированная кухня");

    // The same conclusion, from the rules themselves.
    const direct = rulesForPlan(ask({ ...example, buildingFacts: { ...example.buildingFacts, region: "moscow", gasified: true } }, "living-kitchen"));
    expect(direct?.overall).toBe(gas?.procedure);
  });

  it("warns that a partition may turn out to be bearing", () => {
    const proof = proofOf(example, "living-bedroom");
    const type = proof.alternatives.find((item) => item.subject === "Тип стены 5");
    expect(type).toMatchObject({ current: "перегородка", answer: "несущая", procedure: "specialist" });
    expect(type?.because.join()).toContain("Затронута несущая стена");
  });

  it("says why when a heavier reason goes away and nothing new takes its place", () => {
    const proof = proofOf(example, "top");
    const type = proof.alternatives.find((item) => item.subject === "Тип стены 1");
    expect(type?.answer).toBe("перегородка");
    expect(type?.procedure).toBe("project");
    expect(type?.because.length).toBeGreaterThan(0);
  });

  it("gives both answers to a question nobody has answered", () => {
    const proof = proofOf({ ...example, buildingFacts: { region: "moscow" } }, "living-kitchen");
    expect(proof.answer.procedure).toBe("unknown");
    const gas = proof.alternatives.filter((item) => item.subject === "В квартире есть газ");
    expect(gas.map((item) => item.current)).toContain("Не знаю");
    expect(gas.map((item) => item.answer)).toContain("Да");
    expect(proof.facts).toContainEqual({ label: "В квартире есть газ", answer: "Не знаю" });
  });

  it("lists only what changes the answer", () => {
    const proof = proofOf(example, "living-bedroom");
    for (const item of proof.alternatives) expect(item.procedure).not.toBe(proof.answer.procedure);
    expect(proof.alternatives.some((item) => item.subject === "В квартире есть газ")).toBe(false);
  });

  it("does not ask about the building under a developer's own rules", () => {
    const plan: FloorPlan = {
      ...example,
      buildingFacts: { region: "other" },
      ruleProfile: interpretPrompt("несущие стены не трогать"),
    };
    const proof = proofOf(plan, "living-bedroom");
    expect(proof.draftNote).toBeNull();
    expect(proof.alternatives.every((item) => item.subject.startsWith("Тип стены"))).toBe(true);
    expect(proof.alternatives.some((item) => item.answer === "несущая")).toBe(true);
  });
});

describe("what a decision is", () => {
  it("counts a door in a removed wall as part of removing the wall", () => {
    const proof = proofOf(example, "living-hall");
    expect(proof.decisions).toHaveLength(1);
    expect(proof.decisions[0].text).toContain("Убрать стену 7");
  });

  it("counts a door in a new wall as part of the new wall, and finds a lone door on its own", () => {
    const variant = variantOf(example, (plan) => ({
      ...plan,
      walls: [...plan.walls, wall("new", 3.5, 0, 3.5, 5, "partition")],
      openings: [...plan.openings, door("new-door", "new", 2), door("extra", "living-bedroom", 3)],
    }));
    const texts = buildPlanProof(variant, meta).decisions.map((decision) => decision.text);
    expect(texts).toContain("Поставить новую стену 12 (перегородка): дверь в ней");
    expect(texts).toContain("Сделать дверь в стене 5");
    expect(texts).toHaveLength(2);
  });

  it("has nothing to explain on a source plan or a variant with no changes", () => {
    expect(buildPlanProof(example, meta).status).toBe("no-decision");
    const untouched = { ...example, origin: createPlanOrigin(example, AT) };
    const proof = buildPlanProof(untouched, meta);
    expect(proof.status).toBe("no-decision");
    expect(proof.answer.label).toBe("Решения нет");
    expect(proof.alternatives).toEqual([]);
  });

  it("works from a proposal of the generator", () => {
    const [variant] = generateVariants(example, { goal: "more-rooms", at: AT }).variants;
    const proof = buildPlanProof({ ...variant.plan, origin: createPlanOrigin(example, AT) }, meta);
    expect(proof.decisions[0].text).toContain("Поставить новую стену");
    expect(proof.answer.procedure).toBe(variant.overall);
  });
});

describe("without rules", () => {
  const free: FloorPlan = { ...example, buildingFacts: undefined } as FloorPlan;

  it("says rules were not checked and still reports what the plan itself shows", () => {
    const proof = proofOf(free, "living-bedroom");
    expect(proof.status).toBe("no-rules");
    expect(proof.answer.label).toBe("Нормы не проверялись");
    expect(proof.decisions[0].reasons).toEqual([]);
    expect(proof.alternatives).toEqual([]);
    expect(proof.area.before).toBeCloseTo(81.9, 1);
    expect(proof.checks.length).toBeGreaterThan(0);
  });
});

describe("measures", () => {
  it("shows areas before and after, computed from the plan", () => {
    const proof = proofOf(example, "living-bedroom");
    expect(proof.area.before).toBeCloseTo(81.9, 1);
    expect(proof.area.after).toBeCloseTo(82.86, 1);
    const living = proof.roomChanges.find((row) => row.name === "Гостиная");
    expect(living?.before).toBeCloseTo(32.64, 1);
    expect(living?.after).toBeCloseTo(56.64, 1);
    expect(proof.roomChanges.find((row) => row.name === "Спальня")?.after).toBeNull();
    expect(proof.roomChanges.some((row) => row.name === "Кухня")).toBe(false);
  });

  it("lists the owner's statements it rests on", () => {
    const proof = proofOf(example, "living-bedroom");
    expect(proof.wallTypes).toEqual([{ label: "Стена 5", answer: "перегородка" }]);
    expect(proof.facts.map((line) => line.label)).toContain("В квартире есть газ");
  });
});

describe("the same input gives the same document", () => {
  it("apart from the date", () => {
    const first = proofOf(example, "living-kitchen");
    const second = buildPlanProof(ask(createVariantsExamplePlan(), "living-kitchen"), { ...meta, generatedAt: "2030-01-01T00:00:00.000Z" });
    expect({ ...second, generatedAt: AT }).toEqual(first);
  });

  it("does not change the plan it is asked about", () => {
    const before = structuredClone(example);
    proofOf(example, "living-kitchen");
    expect(example).toEqual(before);
  });
});

describe("the fingerprint", () => {
  const print = planFingerprint(example);

  it("is short enough to compare by eye", () => {
    expect(print).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  it("ignores the name and the order of keys", () => {
    expect(planFingerprint({ ...example, name: "Другое название" })).toBe(print);
    const reversed = { ...example, walls: example.walls.map((item) => Object.fromEntries(Object.entries(item).reverse())) } as FloorPlan;
    expect(planFingerprint(reversed)).toBe(print);
  });

  it("changes with the geometry, a wall type, an answer and the source", () => {
    const moved = { ...example, walls: example.walls.map((item) => (item.id === "top" ? { ...item, height: 2.8 } : item)) };
    const retyped = { ...example, walls: example.walls.map((item) => (item.id === "top" ? { ...item, kind: "partition" as const } : item)) };
    const answered = { ...example, buildingFacts: { ...example.buildingFacts, region: "moscow" as const, gasified: true } };
    const variant = { ...example, origin: createPlanOrigin({ ...example, walls: example.walls.slice(1) }, AT) };
    const prints = [moved, retyped, answered, variant].map(planFingerprint);
    expect(new Set([print, ...prints]).size).toBe(5);
  });

  it("does not depend on when a variant was made", () => {
    const at = (time: string) => planFingerprint({ ...example, origin: createPlanOrigin(example, time) });
    expect(at(AT)).toBe(at("2030-01-01T00:00:00.000Z"));
  });
});
