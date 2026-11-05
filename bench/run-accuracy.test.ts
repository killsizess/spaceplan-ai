import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { accuracyReport, measurePlan, type PlanAccuracyResult } from "@/domain/accuracy/dataset";
import { parsePlanFile } from "@/features/projects/project-repository";

/**
 * Reads every project JSON in ACCURACY_DIR (bench/plans by default) and an optional
 * `<name>.areas.json` next to it with the areas a document states, then writes the report
 * to ACCURACY_OUT (bench/accuracy-report.md by default) and prints it.
 */
it("measures recognition over the plans in the set", () => {
  const dir = process.env.ACCURACY_DIR ?? "bench/plans";
  const out = process.env.ACCURACY_OUT ?? "bench/accuracy-report.md";
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".areas.json")).sort() : [];
  const results: PlanAccuracyResult[] = files.map((file) => {
    const name = file.replace(/\.json$/, "");
    try {
      const plan = parsePlanFile(readFileSync(join(dir, file), "utf8"));
      const areasFile = join(dir, `${name}.areas.json`);
      const documented = existsSync(areasFile) ? JSON.parse(readFileSync(areasFile, "utf8")) : [];
      return measurePlan(name, plan, documented);
    } catch (error) {
      return { name, skipped: `не открылся: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  const report = accuracyReport(results);
  writeFileSync(out, report);
  console.log(report);
  console.log(`Отчёт записан в ${out}. Планов в папке: ${files.length}.`);
  expect(results.length).toBe(files.length);
});
