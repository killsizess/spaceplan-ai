import { describe, expect, it } from "vitest";
import { createExamplePlan } from "@/domain/floor-plan/operations";
import { editorReducer, initialEditorState } from "@/features/editor/editor-state";
import { parsePlanFile, serializePlan } from "./project-repository";

const recognition = {
  source: "pdf" as const,
  at: "2026-11-05T10:00:00.000Z",
  appVersion: "0.38.0",
  walls: [{ start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2 }],
};

describe("format 11", () => {
  it("opens a version 10 project unchanged apart from the version", () => {
    const old = { ...createExamplePlan(), schemaVersion: 10 };
    expect(parsePlanFile(JSON.stringify(old))).toEqual({ ...old, schemaVersion: 11 });
  });

  it("refuses a version 10 file that already carries a version 11 field", () => {
    for (const field of ["recognition", "template", "purchase"]) {
      const file = JSON.stringify({ ...createExamplePlan(), schemaVersion: 10, [field]: field === "recognition" ? recognition : {} });
      expect(() => parsePlanFile(file), field).toThrow();
    }
  });

  it("keeps what recognition proposed when suggestions are accepted, and saves it", () => {
    const state = editorReducer(initialEditorState({ ...createExamplePlan(), roomMode: "walls", rooms: [] }), {
      type: "wall:add-many",
      walls: [{ id: "w", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2, height: 2.7 }],
      recognition,
    });
    expect(state.error).toBeNull();
    expect(state.plan.recognition).toEqual(recognition);
    expect(parsePlanFile(serializePlan(state.plan)).recognition).toEqual(recognition);
  });

  it("adds openings proposed later without losing the walls proposed before", () => {
    const start = { ...createExamplePlan(), roomMode: "walls" as const, rooms: [], recognition };
    const wall = { id: "w", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness: 0.2, height: 2.7 };
    const state = editorReducer(initialEditorState(start), {
      type: "openings:add-many",
      walls: [wall],
      openings: [{ id: "o", wallId: "w", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0 }],
      recognition: { source: "pdf", at: "2026-11-05T11:00:00.000Z", appVersion: "0.38.0", openings: [{ kind: "door", center: { x: 1.45, y: 0 }, width: 0.9, confidence: "high" }] },
    });
    expect(state.error).toBeNull();
    expect(state.plan.recognition?.walls).toEqual(recognition.walls);
    expect(state.plan.recognition?.openings).toHaveLength(1);
  });
});
