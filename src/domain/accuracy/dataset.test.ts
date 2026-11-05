import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "@/domain/floor-plan/operations";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { accuracyReport, measurePlan, summarizeDataset } from "./dataset";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7 });
const truth: FloorPlan = {
  ...createEmptyPlan("measured"),
  roomMode: "walls",
  walls: [wall("a", 0, 0, 10, 0), wall("b", 10, 0, 10, 6), wall("c", 10, 6, 0, 6), wall("d", 0, 6, 0, 0)],
  openings: [{ id: "door", wallId: "a", kind: "door", offset: 2, width: 0.9, height: 2.1, sillHeight: 0 }],
};

describe("a measured set of plans", () => {
  it("skips a plan that recognition did not touch, and says why", () => {
    const result = measurePlan("hand-drawn", truth);
    expect(result).toEqual({ name: "hand-drawn", skipped: expect.stringContaining("нет записи распознавания") });
  });

  it("measures a plan against what was saved when nothing was confirmed", () => {
    const plan: FloorPlan = {
      ...truth,
      recognition: {
        source: "pdf",
        at: "2026-11-05T10:00:00.000Z",
        appVersion: "0.38.0",
        walls: truth.walls.slice(0, 3).map(({ start, end, thickness }) => ({ start, end, thickness })),
        openings: [{ kind: "door", center: { x: 2.45, y: 0 }, width: 0.9, confidence: "high" }],
      },
    };
    const result = measurePlan("flat", plan);
    expect(result).toMatchObject({ truth: "saved", walls: { wallsFound: 3, truthCount: 4 }, doors: { matched: 1 } });
    const summary = summarizeDataset([result, measurePlan("hand-drawn", truth)]);
    expect(summary).toMatchObject({ plans: 1, skipped: 1, doorRecall: 1 });
    expect(summary.wallRecall).toBeCloseTo(26 / 32, 9);
    const report = accuracyReport([result]);
    expect(report).toContain("| Стены, по длине | 81.3% | 100% |");
    expect(report).toContain("| flat | PDF | сохранённый план |");
  });
});
