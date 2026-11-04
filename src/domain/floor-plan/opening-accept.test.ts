import { describe, expect, it } from "vitest";
import { editorReducer, initialEditorState } from "@/features/editor/editor-state";
import { addWallsAndOpenings } from "./construction";
import { checkPlanIntegrity } from "./plan-integrity";
import { findOpeningCandidates, openingFromCandidate } from "./opening-candidates";
import { createEmptyPlan } from "./operations";
import type { FloorPlan, Opening, Wall } from "./types";
import { detectWallRooms } from "./wall-rooms";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7,
});

/** A 5 × 4 room whose top wall stops short around a 0.9 m opening: the contour is open. */
function openRoom(): FloorPlan {
  return {
    ...createEmptyPlan("accept"),
    roomMode: "walls",
    walls: [
      wall("top-left", 0, 0, 1, 0),
      wall("top-right", 1.9, 0, 5, 0),
      wall("right", 5, 0, 5, 4),
      wall("bottom", 5, 4, 0, 4),
      wall("left", 0, 4, 0, 0),
    ],
  };
}

const glazing = [
  { start: { x: 1, y: -0.05 }, end: { x: 1.9, y: -0.05 } },
  { start: { x: 1, y: 0.05 }, end: { x: 1.9, y: 0.05 } },
];

describe("accepting opening suggestions", () => {
  it("closes the room with a short wall and puts the window in it, in one undo step", () => {
    const plan = openRoom();
    expect(detectWallRooms(plan.walls).rooms).toHaveLength(0);
    const { candidates } = findOpeningCandidates(glazing, [], plan.walls);
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate).toMatchObject({ kind: "window", source: "wall-gap", confidence: "high" });
    const fillId = "fill";
    const fill: Wall = { id: fillId, ...candidate.fill! };
    const opening = openingFromCandidate(candidate, "window-1", fillId);

    const state = initialEditorState(plan);
    const next = editorReducer(state, { type: "openings:add-many", walls: [fill], openings: [opening] });
    expect(next.error).toBeNull();
    expect(next.plan.walls).toHaveLength(6);
    expect(next.plan.openings).toEqual([opening]);
    // The gap is closed by a wall that shares its end points with the neighbours exactly.
    expect(fill.start).toEqual(plan.walls[0].end);
    expect(fill.end).toEqual(plan.walls[1].start);
    expect(detectWallRooms(next.plan.walls).rooms).toHaveLength(1);
    expect(checkPlanIntegrity(next.plan).valid).toBe(true);
    expect(checkPlanIntegrity(next.plan).issues).toEqual([]);
    expect(next.past).toHaveLength(1);
    const undone = editorReducer(next, { type: "undo" });
    expect(undone.plan).toBe(plan);
  });

  it("adds an opening to an existing wall, together with walls for other gaps", () => {
    const plan = { ...openRoom(), walls: [...openRoom().walls, wall("long", 0, 6, 8, 6)] };
    const door: Opening = { id: "d", wallId: "long", kind: "door", offset: 2, width: 0.9, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } };
    const fill = wall("fill", 1, 0, 1.9, 0);
    const result = addWallsAndOpenings(plan, [fill], [door, { id: "w", wallId: "fill", kind: "window", offset: 0, width: 0.9, height: 1.2, sillHeight: 0.9 }]);
    expect(result.walls).toHaveLength(7);
    expect(result.openings.map((item) => item.id)).toEqual(["d", "w"]);
  });

  it("is all or nothing: one bad opening or a repeated ID leaves the plan unchanged", () => {
    const plan = openRoom();
    const fill = wall("fill", 1, 0, 1.9, 0);
    const good: Opening = { id: "o1", wallId: "fill", kind: "door", offset: 0, width: 0.9, height: 2.1, sillHeight: 0 };
    const orphan: Opening = { id: "o2", wallId: "missing", kind: "door", offset: 0, width: 0.9, height: 2.1, sillHeight: 0 };
    expect(() => addWallsAndOpenings(plan, [fill], [good, orphan])).toThrow();
    expect(() => addWallsAndOpenings(plan, [fill], [good, { ...good, offset: 0.5 }])).toThrow(/Идентификатор/);
    expect(() => addWallsAndOpenings(plan, [{ ...fill, id: "left" }], [])).toThrow(/Идентификатор/);
    const tooWide: Opening = { ...good, width: 1.5 };
    expect(() => addWallsAndOpenings(plan, [fill], [tooWide])).toThrow(/границы/i);
    const state = initialEditorState(plan);
    const refused = editorReducer(state, { type: "openings:add-many", walls: [fill], openings: [good, orphan] });
    expect(refused.error).not.toBeNull();
    expect(refused.plan).toBe(plan);
    expect(refused.past).toHaveLength(0);
    expect(addWallsAndOpenings(plan, [], [])).toBe(plan);
  });
});
