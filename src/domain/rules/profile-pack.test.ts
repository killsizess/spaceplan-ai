import { describe, expect, it } from "vitest";
import { buildPlanReport } from "@/features/report/plan-report";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { citation, rulesForPlan } from "./engine";
import { interpretPrompt } from "./prompt-rules";
import { apartment, variantOf, wall, window_ } from "./rules.fixtures";
import { buildXray } from "./xray";

const withRules = (text: string): FloorPlan => ({ ...apartment({ region: "other" }), ruleProfile: interpretPrompt(text) });
const report = (plan: FloorPlan) => rulesForPlan(plan)!;
const without = (plan: FloorPlan, id: string): FloorPlan => ({
  ...plan,
  walls: plan.walls.filter((item) => item.id !== id),
  openings: plan.openings.filter((item) => item.wallId !== id),
});

describe("which rules apply", () => {
  it("runs the developer's rules only for another country or region", () => {
    expect(rulesForPlan(apartment({ region: "other" }))).toBeNull();
    expect(report(withRules("Кухня не меньше 9 м²")).packId).toBe("profile");
    expect(rulesForPlan({ ...apartment({}), ruleProfile: interpretPrompt("Кухня не меньше 9 м²") })).toBeNull();
    expect(report({ ...apartment({ region: "moscow" }), ruleProfile: interpretPrompt("Кухня не меньше 9 м²") }).packId).toBe("moscow");
  });

  it("does not pretend the rules were compared with any law, and asks nothing about the building", () => {
    const result = report(withRules("Кухня не меньше 9 м²"));
    expect(result.kind).toBe("owner");
    expect(result.documents[0].gaps).toContain("не сверяло");
    expect(result.notChecked[0]).toContain("Нормы страны");
    expect(result.missingFacts).toEqual([]);
  });

  it("calls a rule that holds verified, because it is checked as written", () => {
    const [finding] = report(withRules("Кухня не меньше 9 м²")).findings;
    expect(finding).toMatchObject({ level: "verified", state: "ok", title: "Выполнено: Кухня: площадь не меньше 9 м²" });
  });
});

describe("the plan as it stands", () => {
  it("names the room that breaks an area rule, quoting the developer's phrase", () => {
    const result = report(withRules("Кухня не меньше 12 м²"));
    const [finding] = result.findings;
    expect(finding.state).toBe("problem");
    expect(finding.title).toBe("Кухня: 10,64 м² при минимуме 12 м²");
    expect(finding.roomIds).toHaveLength(1);
    expect(citation(result, finding)).toBe("Правила застройщика, «Кухня не меньше 12 м²»");
    expect(report(withRules("санузел не больше 5 м²")).findings[0].title).toBe("Санузел: 10,64 м² при максимуме 5 м²");
  });

  it("checks any living room, and says so when there is no such room", () => {
    expect(report(withRules("жилая комната не меньше 40 м²")).findings[0].title).toBe("Гостиная: 33,64 м² при минимуме 40 м²");
    expect(report(withRules("спальня не меньше 10 м²")).findings[0]).toMatchObject({ level: "undetermined", title: "Не проверено: Спальня: площадь не меньше 10 м²" });
  });

  it("counts rooms", () => {
    expect(report(withRules("две спальни")).findings[0]).toMatchObject({ state: "problem", title: "Спальня: ровно 2: сейчас 0" });
    expect(report(withRules("не больше 1 санузла")).findings[0].state).toBe("ok");
  });

  it("checks windows and heights, and only when there are walls", () => {
    expect(report(withRules("в каждой комнате окно")).findings[0].state).toBe("ok");
    const dark: FloorPlan = { ...withRules("кухня с окном"), openings: [window_("living-window", "top", 2)] };
    expect(report(dark).findings[0].title).toBe("Кухня: нет окна наружу");
    expect(report(withRules("потолки не ниже 2,8 м")).findings.map((item) => item.state)).toContain("problem");
    const manual: FloorPlan = { ...withRules("потолки не ниже 2,8 м"), roomMode: "manual", walls: [], openings: [], wallRoomLabels: [], rooms: [{ id: "r", name: "Кухня", kind: "kitchen", color: "#f1e3c6", x: 0, y: 0, width: 3, height: 3 }] };
    expect(report(manual).findings[0]).toMatchObject({ level: "undetermined", state: "note" });
  });

  it("lists what it did not understand and does not check it", () => {
    const result = report(withRules("Кухня не меньше 9 м². Фасад по согласованию"));
    expect(result.notUnderstood).toEqual(["Фасад по согласованию"]);
    expect(result.findings.at(-1)).toMatchObject({ ruleId: "profile.not-understood", title: "Не понято и не проверяется: «Фасад по согласованию»" });
  });
});

describe("a variant against its source", () => {
  it("forbids touching bearing walls when told to, and sends them to a specialist when not", () => {
    const told = report(variantOf(withRules("Несущие стены не трогать"), (plan) => without(plan, "top")));
    expect(told.overall).toBe("forbidden");
    expect(told.findings.find((item) => item.ruleId === "profile.keep-bearing")!.title).toContain("стена 1");
    const silent = report(variantOf(withRules("Кухня не меньше 9 м²"), (plan) => without(plan, "top")));
    expect(silent.overall).toBe("specialist");
  });

  it("forbids a merge the developer ruled out", () => {
    const result = report(variantOf(withRules("Нельзя объединять кухню с гостиной"), (plan) => without(plan, "living-kitchen")));
    expect(result.overall).toBe("forbidden");
    expect(result.findings.some((item) => item.ruleId === "profile.no-merge")).toBe(true);
    expect(report(variantOf(withRules("Нельзя объединять кухню с санузлом"), (plan) => without(plan, "living-kitchen"))).findings.some((item) => item.ruleId === "profile.no-merge")).toBe(false);
  });

  it("forbids moving a room that must stay", () => {
    const moved = variantOf(withRules("Санузлы не переносить"), (plan) => without(plan, "kitchen-bath"));
    expect(report(moved).findings.some((item) => item.ruleId === "profile.keep-room")).toBe(true);
    expect(report(variantOf(withRules("Санузлы не переносить"), (plan) => plan)).overall).toBeNull();
  });

  it("asks for a project on any change when told to", () => {
    const result = report(variantOf(withRules("Любая перепланировка только по проекту"), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "partition")] })));
    expect(result.overall).toBe("project");
    expect(report(variantOf(withRules("Любая перепланировка только по проекту"), (plan) => plan)).overall).toBeNull();
  });

  it("gives no conclusion on walls of unknown type, or on changes the rules do not mention", () => {
    const untyped = withRules("Кухня не меньше 9 м²");
    untyped.walls = untyped.walls.map((item) => (item.id === "kitchen-bath" ? { ...item, kind: undefined } : item));
    expect(report(variantOf(untyped, (plan) => without(plan, "kitchen-bath"))).overall).toBe("unknown");
    const silent = report(variantOf(withRules("Кухня не меньше 9 м²"), (plan) => ({ ...plan, walls: [...plan.walls, wall("new", 3, 0, 3, 6, "partition")] })));
    expect(silent.overall).toBe("unknown");
    expect(silent.findings.some((item) => item.ruleId === "profile.no-answer")).toBe(true);
  });

  it("never says that something is allowed", () => {
    const result = report(variantOf(withRules("Кухня не меньше 9 м². Несущие стены не трогать"), (plan) => without(plan, "top")));
    for (const finding of result.findings) {
      expect(`${finding.title} ${finding.detail ?? ""}`).not.toMatch(/(^|[^а-яё])(допустимо|разрешено|можно)([^а-яё]|$)/i);
    }
  });
});

describe("X-Ray with the developer's rules", () => {
  const potential = (plan: FloorPlan, id: string) => buildXray(plan).walls.find((item) => item.wallId === id)!;

  it("has no answer where the rules say nothing", () => {
    const answer = potential(withRules("Кухня не меньше 9 м²"), "living-bath");
    expect(answer.removal).toMatchObject({ procedure: "unknown" });
    expect(answer.removal.reason).toContain("нет ответа");
    expect(potential(withRules("Кухня не меньше 9 м²"), "top").removal.procedure).toBe("specialist");
  });

  it("answers from the rules, with the phrase behind each answer", () => {
    const told = withRules("Несущие стены не трогать. Нельзя объединять кухню с гостиной. Санузлы не переносить. Изменения только по проекту");
    expect(potential(told, "top").removal.procedure).toBe("forbidden");
    expect(potential(told, "living-kitchen").removal).toMatchObject({ procedure: "forbidden", sources: [{ document: "owner-prompt", point: "«Нельзя объединять кухню с гостиной»" }] });
    expect(potential(told, "living-bath").removal.procedure).toBe("forbidden");
    expect(potential(told, "living-kitchen").opening.procedure).toBe("project");
    const rooms = buildXray(told).rooms;
    expect(rooms.find((room) => room.kind === "bathroom")!.move.procedure).toBe("forbidden");
    expect(rooms.find((room) => room.kind === "kitchen")!.move.procedure).toBe("project");
  });
});

describe("the report", () => {
  const meta = { generatedAt: "2026-11-05T10:00:00.000Z", appVersion: "test" };

  it("says the rules are the developer's, and what was not understood", () => {
    const result = buildPlanReport(withRules("Кухня не меньше 12 м². Фасад по согласованию"), meta);
    expect(result.limits[0]).toContain("заданы застройщиком");
    expect(result.limits[0]).toContain("не сверяло");
    expect(result.limits[1]).toBe("Не понято и не проверяется: «Фасад по согласованию».");
    expect(result.findings.some((item) => item.source === "Правила застройщика, «Кухня не меньше 12 м²»")).toBe(true);
  });
});
