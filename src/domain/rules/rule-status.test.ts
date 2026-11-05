import { describe, expect, it } from "vitest";
import { runRules, statusOf } from "./engine";
import { MOSCOW_PACK } from "./moscow";
import { MOSCOW_SIGNOFFS } from "./moscow-signoffs";
import { profilePack } from "./profile-pack";
import { interpretPrompt } from "./prompt-rules";
import { apartment } from "./rules.fixtures";
import type { RulePack } from "./types";

const facts = { region: "moscow" as const, gasified: false, woodenFloors: false, heritage: false, emergency: false, below: "no-dwelling" as const, above: "no-dwelling" as const };
const plan = apartment(facts);
const ruleIdOf = (pack: RulePack) => runRules(pack, plan).findings.find((finding) => finding.sources.length && finding.state === "ok")!.ruleId;

describe("the status of each rule", () => {
  it("is a draft for every Moscow rule until a specialist decides, so none can verify", () => {
    const report = runRules(MOSCOW_PACK, plan);
    for (const finding of report.findings) {
      expect(finding.status, finding.ruleId).toBe(finding.sources.length ? "draft" : "no-rule");
      if (finding.status === "draft") expect(finding.level, finding.ruleId).not.toBe("verified");
    }
    expect(report.withdrawn).toEqual([]);
  });

  it("lets a rule a specialist confirmed verify, rule by rule", () => {
    const ruleId = ruleIdOf(MOSCOW_PACK);
    const pack: RulePack = { ...MOSCOW_PACK, signoffs: { [ruleId]: { status: "confirmed", by: "Инженер, тест", date: "2026-11-05" } } };
    const finding = runRules(pack, plan).findings.find((item) => item.ruleId === ruleId)!;
    expect(finding.status).toBe("confirmed");
    expect(finding.level).toBe("verified");
    const other = runRules(pack, plan).findings.find((item) => item.ruleId !== ruleId && item.sources.length)!;
    expect(other.status).toBe("draft");
  });

  it("takes a rule a specialist rejected out of the conclusions and keeps it aside", () => {
    const ruleId = ruleIdOf(MOSCOW_PACK);
    const pack: RulePack = { ...MOSCOW_PACK, signoffs: { [ruleId]: { status: "rejected", by: "Инженер, тест", date: "2026-11-05", note: "неверное чтение" } } };
    const report = runRules(pack, plan);
    expect(report.findings.some((item) => item.ruleId === ruleId)).toBe(false);
    expect(report.withdrawn.map((item) => item.ruleId)).toContain(ruleId);
  });

  it("calls the developer's rules the developer's, and a missing answer no rule at all", () => {
    const owner = profilePack(interpretPrompt("Несущие стены не трогать."));
    expect(statusOf({ ruleId: "x", sources: [{ document: "owner", point: "" }] }, owner)).toBe("developer");
    expect(statusOf({ ruleId: "x", sources: [] }, MOSCOW_PACK)).toBe("no-rule");
  });

  it("has no sign-off nobody made", () => {
    expect(MOSCOW_SIGNOFFS).toEqual({});
  });
});
