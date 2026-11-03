import { describe, expect, it } from "vitest";
import { createSpatialExamplePlan } from "@/domain/floor-plan/examples";
import { wallMoveContext } from "@/domain/floor-plan/move-wall";
import { checkPlanIntegrity } from "@/domain/floor-plan/plan-integrity";
import type { RoomKind } from "@/domain/floor-plan/types";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { analyzeWallIntersections } from "@/domain/floor-plan/wall-intersections";
import { editorReducer, initialEditorState, type EditorAction, type EditorState } from "./editor-state";

/** Small deterministic PRNG so every failing sequence can be replayed by seed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: RoomKind[] = ["living", "bedroom", "kitchen", "bathroom", "hall", "other"];

/**
 * One random editor command against the current state, as the UI would send
 * it: the same action types, ids from a counter, coordinates on the 0.1 m grid.
 */
function randomAction(state: EditorState, next: () => number, counter: { value: number }): EditorAction {
  const plan = state.plan;
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const grid = (low: number, high: number) => Math.round((low + next() * (high - low)) * 10) / 10;
  const id = () => `seq-${counter.value++}`;
  const wall = plan.walls.length ? pick(plan.walls) : undefined;
  const roll = next();
  if (roll < 0.1 || !wall) {
    if (plan.walls.length >= 40) return { type: "undo" };
    const start = { x: grid(-2, 12), y: grid(-2, 10) };
    const end = next() < 0.5 ? { x: grid(-2, 12), y: start.y } : { x: start.x, y: grid(-2, 10) };
    return { type: "wall:add", wall: { id: id(), start, end, thickness: pick([0.12, 0.2]), height: 2.7 } };
  }
  if (roll < 0.2) {
    const endpoint = next() < 0.5 ? "start" : "end";
    return { type: "wall:node-move", wallId: wall.id, endpoint, point: { x: wall[endpoint].x + grid(-1, 1), y: wall[endpoint].y + grid(-1, 1) }, expectedPoint: wall[endpoint] };
  }
  if (roll < 0.32) {
    const context = wallMoveContext(plan.walls, wall.id);
    const distance = grid(-1.5, 1.5);
    return next() < 0.5
      ? { type: "wall:move", wallId: wall.id, delta: { x: context.direction.x * distance, y: context.direction.y * distance }, expected: { start: wall.start, end: wall.end } }
      : { type: "wall:offset", wallId: wall.id, distance, expected: { start: wall.start, end: wall.end } };
  }
  if (roll < 0.4) {
    return { type: "wall:update", wall: { ...wall, thickness: pick([0.1, 0.12, 0.2, 0.25]), height: pick([2.5, 2.7, 3]) }, connectEndpoints: next() < 0.8 };
  }
  if (roll < 0.5) {
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    const door = next() < 0.6;
    return {
      type: "opening:add",
      opening: door
        ? { id: id(), wallId: wall.id, kind: "door", offset: grid(0, Math.max(0, length - 0.9)), width: 0.9, height: 2.1, sillHeight: 0 }
        : { id: id(), wallId: wall.id, kind: "window", offset: grid(0, Math.max(0, length - 1.2)), width: 1.2, height: 1.2, sillHeight: 0.9 },
    };
  }
  if (roll < 0.56 && plan.openings.length) {
    const opening = pick(plan.openings);
    return { type: "opening:update", opening: { ...opening, offset: Math.max(0, opening.offset + grid(-0.5, 0.5)) } };
  }
  if (roll < 0.62) {
    const target = pick([...plan.walls, ...plan.openings]);
    return { type: "delete", id: target.id };
  }
  if (roll < 0.7) {
    const diagnostics = analyzeWallConnections(plan.walls);
    const near = diagnostics.find((item) => item.kind === "near-endpoint");
    const junction = diagnostics.find((item) => (item.kind === "near-wall" || item.kind === "junction") && item.target.endpoint === undefined);
    const crossing = analyzeWallIntersections(plan.walls).intersections[0];
    if (near && next() < 0.4) return { type: "wall:connect-endpoints", diagnostic: near };
    if (junction && next() < 0.6) return { type: "wall:connect-junction", diagnostic: junction, newWallId: id() };
    if (crossing) return { type: "wall:connect-intersection", diagnostic: crossing, newWallIds: [id(), id()] };
    return { type: "redo" };
  }
  if (roll < 0.76) {
    const kind = pick(KINDS);
    if (plan.requirements.length && next() < 0.4) return { type: "requirement:remove", id: pick(plan.requirements).id };
    return next() < 0.5
      ? { type: "requirement:add", requirement: { id: id(), type: "room-min-area", kind, minArea: grid(1, 20) } }
      : { type: "requirement:add", requirement: { id: id(), type: "rooms-connected", kind, otherKind: pick(KINDS), byDoor: next() < 0.5 } };
  }
  if (roll < 0.8) return { type: "roomMode:set", mode: plan.roomMode === "walls" ? "manual" : "walls" };
  if (roll < 0.9) return { type: "undo" };
  return { type: "redo" };
}

describe("random editor sequences", () => {
  it("never produce an integrity error over 1000 commands, and rejected commands change nothing", () => {
    let applied = 0, rejected = 0;
    const types = new Map<string, number>();
    for (const seed of [11, 12, 13, 14]) {
      const next = random(seed);
      const counter = { value: 0 };
      let state = initialEditorState({ ...createSpatialExamplePlan(), roomMode: "walls" });
      for (let step = 0; step < 250; step++) {
        const action = randomAction(state, next, counter);
        const before = state;
        state = editorReducer(state, action);
        if (state.error) {
          rejected++;
          // A rejected command keeps the last valid plan and both history stacks.
          expect(state.plan, `seed ${seed} step ${step} ${action.type}`).toBe(before.plan);
          expect(state.past).toBe(before.past);
          expect(state.future).toBe(before.future);
          state = editorReducer(state, { type: "clearError" });
          continue;
        }
        applied++;
        types.set(action.type, (types.get(action.type) ?? 0) + 1);
        const report = checkPlanIntegrity(state.plan);
        expect(report.issues.filter((item) => item.severity === "error"), `seed ${seed} step ${step} ${action.type}`).toEqual([]);
      }
    }
    expect(applied + rejected).toBe(1000);
    // Not vacuous: most commands apply and every kind of change is exercised.
    expect(applied).toBeGreaterThan(500);
    for (const type of ["wall:add", "wall:node-move", "wall:move", "wall:offset", "opening:add", "delete", "requirement:add", "undo", "redo", "roomMode:set"]) {
      expect(types.get(type) ?? 0, type).toBeGreaterThan(0);
    }
  }, 60_000);
});
