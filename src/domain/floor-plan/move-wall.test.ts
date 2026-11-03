import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { updateWall } from "./construction";
import { createSpatialExamplePlan } from "./examples";
import {
  moveWall,
  offsetWall,
  OFFSET_CONTINUATION,
  OFFSET_MIXED_NODE,
  previewWallMove,
  previewWallOffset,
  wallMoveContext,
  WALL_MOVE_STALE,
} from "./move-wall";
import { createEmptyPlan } from "./operations";
import { checkPlanIntegrity } from "./plan-integrity";
import type { FloorPlan, Opening, Wall } from "./types";
import { detectWallRooms } from "./wall-rooms";
import { buildWallTopology, type WallTopology } from "./wall-topology";

function wall(id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.2): Wall {
  return { id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, height: 2.7 };
}

function opening(id: string, wallId: string, offset: number, kind: "door" | "window" = "door", width = 0.9): Opening {
  return kind === "door"
    ? { id, wallId, kind, offset, width, height: 2.1, sillHeight: 0 }
    : { id, wallId, kind, offset, width, height: 1.2, sillHeight: 0.9 };
}

/**
 * Two halves split by a partition that rests on the outer walls (unsplit T at
 * both ends). A branch rests on the partition and the right wall; a stub rests
 * on the bottom wall only.
 */
function apartment(): FloorPlan {
  return {
    ...createEmptyPlan("move"),
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0),
      wall("right", 10, 0, 10, 6),
      wall("bottom", 10, 6, 0, 6),
      wall("left", 0, 6, 0, 0),
      wall("partition", 6, 0, 6, 6),
      wall("branch", 6, 3, 10, 3),
      wall("stub", 3, 6, 3, 4.5),
    ],
    openings: [
      opening("door-partition", "partition", 1),
      opening("door-branch", "branch", 1),
      opening("door-right", "right", 4),
      opening("window-top", "top", 2, "window", 1.2),
    ],
  };
}

const wallOf = (plan: FloorPlan, id: string) => plan.walls.find((item) => item.id === id)!;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const shifted = (point: Point, delta: Point) => ({ x: point.x + delta.x, y: point.y + delta.y });

/** Plan coordinates of an opening's near and far edge on its wall axis. */
function span(plan: FloorPlan, id: string): [Point, Point] {
  const item = plan.openings.find((candidate) => candidate.id === id)!;
  const host = wallOf(plan, item.wallId);
  const length = Math.hypot(host.end.x - host.start.x, host.end.y - host.start.y);
  const at = (distance: number) => ({
    x: host.start.x + ((host.end.x - host.start.x) / length) * distance,
    y: host.start.y + ((host.end.y - host.start.y) / length) * distance,
  });
  return [at(item.offset), at(item.offset + item.width)];
}

function expectPoint(actual: Point, expected: Point, digits = 9) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

const contactsOf = (topology: WallTopology) =>
  topology.contacts.map((contact) => {
    const node = topology.nodes.find((item) => item.key === contact.node)!;
    return { branch: node.ends.map((end) => `${end.wallId}:${end.endpoint}`).join("+"), host: contact.wallId, offset: Math.round(contact.offset * 1e9) / 1e9 };
  });

/** Every node of the old graph stays together; every T stays on its host's axis or end. */
function expectJunctionsKept(before: WallTopology, after: FloorPlan) {
  const topology = buildWallTopology(after.walls);
  const nodeOf = new Map(topology.nodes.flatMap((node) => node.ends.map((end) => [`${end.wallId}:${end.endpoint}`, node] as const)));
  for (const node of before.nodes) {
    expect(new Set(node.ends.map((end) => nodeOf.get(`${end.wallId}:${end.endpoint}`)!.key)).size).toBe(1);
  }
  for (const contact of before.contacts) {
    const branch = before.nodes.find((node) => node.key === contact.node)!;
    const current = nodeOf.get(`${branch.ends[0].wallId}:${branch.ends[0].endpoint}`)!;
    const kept = current.ends.some((end) => end.wallId === contact.wallId) ||
      topology.contacts.some((item) => item.node === current.key && item.wallId === contact.wallId);
    expect(kept, `${contact.node} on ${contact.wallId}`).toBe(true);
  }
}

/**
 * The documented contract, checked from the outside: carried ends move by the
 * vector and nothing else moves; every junction survives; openings change their
 * plan position only by the rules of rebaseOpenings; the result is valid.
 */
function expectMoveContract(before: FloorPlan, after: FloorPlan, wallId: string, delta: Point) {
  const context = wallMoveContext(before.walls, wallId);
  const carried = new Set(context.carried.map((end) => `${end.wallId}:${end.endpoint}`));
  expect(after.walls.map((item) => item.id)).toEqual(before.walls.map((item) => item.id));
  expect(carried.has(`${wallId}:start`) && carried.has(`${wallId}:end`)).toBe(true);
  for (const original of before.walls) {
    const next = wallOf(after, original.id);
    expect([next.thickness, next.height]).toEqual([original.thickness, original.height]);
    for (const endpoint of ["start", "end"] as const) {
      if (carried.has(`${original.id}:${endpoint}`)) expectPoint(next[endpoint], shifted(original[endpoint], delta), 12);
      else expect(next[endpoint]).toEqual(original[endpoint]);
    }
  }

  expectJunctionsKept(context.topology, after);

  for (const item of before.openings) {
    const original = wallOf(before, item.wallId), next = wallOf(after, item.wallId);
    const [near0, far0] = span(before, item.id), [near1, far1] = span(after, item.id);
    const startMoved = original.start.x !== next.start.x || original.start.y !== next.start.y;
    const endMoved = original.end.x !== next.end.x || original.end.y !== next.end.y;
    const axis0 = { x: original.end.x - original.start.x, y: original.end.y - original.start.y };
    const axis1 = { x: next.end.x - next.start.x, y: next.end.y - next.start.y };
    const sine = (axis0.x * axis1.y - axis0.y * axis1.x) / (Math.hypot(axis0.x, axis0.y) * Math.hypot(axis1.x, axis1.y));
    if (!startMoved && !endMoved) {
      expect(after.openings.find((candidate) => candidate.id === item.id)).toEqual(item);
    } else if (startMoved && endMoved) {
      // Carried with the wall: the whole opening moves by the vector.
      expectPoint(near1, shifted(near0, delta));
      expectPoint(far1, shifted(far0, delta));
    } else if (Math.abs(sine) <= 1e-12 && axis0.x * axis1.x + axis0.y * axis1.y > 0) {
      // The wall only grew or shrank: the opening keeps its plan position.
      expectPoint(near1, near0);
      expectPoint(far1, far0);
    } else {
      // The wall turned about its unmoved end: the distance to that end is kept.
      const fixed = startMoved ? next.end : next.start;
      const distance = (point: Point) => Math.hypot(point.x - fixed.x, point.y - fixed.y);
      expect(distance(near1)).toBeCloseTo(distance(near0), 9);
      expect(distance(far1)).toBeCloseTo(distance(far0), 9);
    }
  }
  expect(checkPlanIntegrity(after).valid).toBe(true);
}

const KNOWN_REJECTIONS = /опирается концом|примыкание соседней|ненулевую длину|±1000|границы стены/;

describe("moving a whole wall with its junctions", () => {
  it("carries a partition's openings and the walls resting on it, keeping every junction", () => {
    const plan = apartment();
    const context = wallMoveContext(plan.walls, "partition");
    expect(context.carried).toEqual([
      { wallId: "branch", endpoint: "start" },
      { wallId: "partition", endpoint: "start" },
      { wallId: "partition", endpoint: "end" },
    ]);
    expect(context.supports).toEqual(["bottom", "top"]);
    // It slides along the outer walls it rests on.
    expect(context.direction).toEqual({ x: -1, y: 0 });

    const moved = moveWall(plan, "partition", { x: 1, y: 0 });
    expect(wallOf(moved, "partition")).toEqual(wall("partition", 7, 0, 7, 6));
    expect(wallOf(moved, "branch")).toEqual(wall("branch", 7, 3, 10, 3));
    for (const id of ["top", "right", "bottom", "left", "stub"]) expect(wallOf(moved, id)).toEqual(wallOf(plan, id));
    expect(moved.openings).toEqual([
      opening("door-partition", "partition", 1),
      // The branch lost 1 m at its start; its door stays at x = 7..7.9.
      opening("door-branch", "branch", 0),
      opening("door-right", "right", 4),
      opening("window-top", "top", 2, "window", 1.2),
    ]);
    expect(contactsOf(buildWallTopology(moved.walls))).toEqual(
      contactsOf(buildWallTopology(plan.walls)).map((contact) =>
        contact.branch === "partition:start" ? { ...contact, offset: 7 } :
          contact.branch === "partition:end" ? { ...contact, offset: 3 } : contact,
      ),
    );
    expectMoveContract(plan, moved, "partition", { x: 1, y: 0 });

    // The same boundary walls enclose each room, so the room keys stay and only areas move.
    const before = detectWallRooms(plan.walls).rooms, after = detectWallRooms(moved.walls).rooms;
    expect(after.map((room) => room.id).sort()).toEqual(before.map((room) => room.id).sort());
    // The branch became 1 m shorter, which frees 1 m × 0.2 m of floor under it.
    expect(sum(after.map((room) => room.area)) - sum(before.map((room) => room.area))).toBeCloseTo(0.2, 9);
    const left = (rooms: typeof before) => rooms.find((room) => room.boundaryWallIds.includes("left"))!;
    expect(left(after).area - left(before).area).toBeCloseTo(5.8, 9);
  });

  it("is the explicit fix for branches that the inspector edit leaves behind", () => {
    const plan = apartment();
    const partition = wallOf(plan, "partition");
    const inspector = updateWall(plan, { ...partition, start: { x: 7, y: 0 }, end: { x: 7, y: 6 } });
    expect(wallOf(inspector, "branch").start).toEqual({ x: 6, y: 3 });
    expect(contactsOf(buildWallTopology(inspector.walls)).some((contact) => contact.branch === "branch:start")).toBe(false);
    const moved = moveWall(plan, "partition", { x: 1, y: 0 });
    expect(contactsOf(buildWallTopology(moved.walls))).toContainEqual({ branch: "branch:start", host: "partition", offset: 3 });
  });

  it("moves an outer wall outward with its corners and branches; neighbours keep their openings in place", () => {
    const plan = apartment();
    const context = wallMoveContext(plan.walls, "right");
    expect(context.supports).toEqual([]);
    expect(context.direction).toEqual({ x: -1, y: 0 });
    expect(context.carried).toEqual([
      { wallId: "bottom", endpoint: "start" },
      { wallId: "branch", endpoint: "end" },
      { wallId: "right", endpoint: "start" },
      { wallId: "right", endpoint: "end" },
      { wallId: "top", endpoint: "end" },
    ]);
    const moved = moveWall(plan, "right", { x: 2, y: 0 });
    expect(wallOf(moved, "right")).toEqual(wall("right", 12, 0, 12, 6));
    expect(wallOf(moved, "top").end).toEqual({ x: 12, y: 0 });
    expect(wallOf(moved, "bottom").start).toEqual({ x: 12, y: 6 });
    expect(wallOf(moved, "branch")).toEqual(wall("branch", 6, 3, 12, 3));
    expect(moved.openings).toEqual(plan.openings);
    expectPoint(span(moved, "door-right")[0], { x: 12, y: 4 });
    expectMoveContract(plan, moved, "right", { x: 2, y: 0 });
  });

  it("turns branches about their far ends when the vector runs along the moved wall", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("turn"),
      walls: [wall("host", 0, 0, 10, 0), wall("branch", 3, 0, 3, 4)],
      openings: [opening("door", "branch", 1)],
    };
    const moved = moveWall(plan, "host", { x: 1, y: 0 });
    expect(wallOf(moved, "host")).toEqual(wall("host", 1, 0, 11, 0));
    expect(wallOf(moved, "branch")).toEqual(wall("branch", 4, 0, 3, 4));
    expect(contactsOf(buildWallTopology(moved.walls))).toEqual([{ branch: "branch:start", host: "host", offset: 3 }]);
    // The branch turned about its unmoved end; the door keeps its 2.1 m from that end.
    const door = moved.openings[0];
    expect(Math.hypot(1, 4) - door.offset - door.width).toBeCloseTo(2.1, 12);
    expectMoveContract(plan, moved, "host", { x: 1, y: 0 });
  });

  it("slides a slanted branch along its support and refuses to tear it off", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("slanted"),
      walls: [wall("host", 0, 0, 10, 0), wall("slanted", 4, 0, 6, 3)],
      openings: [opening("window", "slanted", 0.5, "window", 1)],
    };
    const context = wallMoveContext(plan.walls, "slanted");
    expect(context.supports).toEqual(["host"]);
    expect(context.direction).toEqual({ x: -1, y: 0 });
    const delta = { x: context.direction.x * 1.5, y: context.direction.y * 1.5 };
    const moved = moveWall(plan, "slanted", delta);
    expect(wallOf(moved, "slanted")).toEqual(wall("slanted", 2.5, 0, 4.5, 3));
    expect(moved.openings).toEqual(plan.openings);
    expectMoveContract(plan, moved, "slanted", delta);
    const normal = { x: -3 / Math.hypot(2, 3), y: 2 / Math.hypot(2, 3) };
    expect(() => moveWall(plan, "slanted", { x: normal.x * 0.5, y: normal.y * 0.5 })).toThrow(/опирается концом/);
  });

  it("rejects detaching moves, cut openings, invalid input and stale gestures without touching the plan", () => {
    const plan = apartment();
    const snapshot = structuredClone(plan);
    // Along its own axis the partition would leave the outer walls it rests on.
    expect(() => moveWall(plan, "partition", { x: 0, y: 0.5 })).toThrow(/опирается концом/);
    // The bottom wall would shrink past the stub that rests on it.
    expect(() => moveWall(plan, "left", { x: 3.5, y: 0 })).toThrow(/примыкание соседней/);
    // The top wall would shrink into its window at x = 2..3.2.
    expect(() => moveWall(plan, "left", { x: 2.5, y: 0 })).toThrow(/границы стены/);
    expect(() => moveWall(plan, "right", { x: 2000, y: 0 })).toThrow(/±1000/);
    // The right wall and the partition would collapse onto the bottom wall.
    expect(() => moveWall(plan, "top", { x: 0, y: 6 })).toThrow(/ненулевую длину/);
    for (const delta of [{ x: Number.NaN, y: 0 }, { x: 0, y: Infinity }]) {
      expect(() => moveWall(plan, "partition", delta)).toThrow(/числом/);
    }
    expect(() => moveWall(plan, "missing", { x: 1, y: 0 })).toThrow(/не найдена/);
    expect(() => moveWall(plan, "partition", { x: 1, y: 0 }, { start: { x: 6, y: 0 }, end: { x: 6, y: 5 } })).toThrow(WALL_MOVE_STALE);
    expect(moveWall(plan, "partition", { x: 1, y: 0 }, { start: { x: 6, y: 0 }, end: { x: 6, y: 6 } }).walls).toHaveLength(7);
    expect(plan).toEqual(snapshot);
  });

  it("returns the same plan for a zero move and previews exactly what it commits", () => {
    const plan = apartment();
    expect(moveWall(plan, "partition", { x: 0, y: 0 })).toBe(plan);
    expect(moveWall(plan, "partition", { x: -0, y: 0 })).toBe(plan);
    const context = wallMoveContext(plan.walls, "partition");
    expect(previewWallMove(plan.walls, context, { x: 0, y: 0 })).toBe(plan.walls);
    const preview = previewWallMove(plan.walls, context, { x: -1.5, y: 0 });
    expect(preview.filter((item, index) => item === plan.walls[index]).map((item) => item.id))
      .toEqual(["top", "right", "bottom", "left", "stub"]);
    expect(moveWall(plan, "partition", { x: -1.5, y: 0 }).walls).toEqual(preview);
    // A preview may pass the limits; only the committed command rejects them.
    expect(previewWallMove(plan.walls, context, { x: 5000, y: 0 })[4].start.x).toBe(5006);
  });

  it("does not depend on wall order or on the direction of walls it does not move", () => {
    const plan = apartment();
    const reversed = new Set(["left", "bottom", "stub"]);
    const variant: FloorPlan = {
      ...plan,
      walls: [...plan.walls].reverse().map((item) => reversed.has(item.id) ? { ...item, start: item.end, end: item.start } : item),
    };
    const ends = (moved: FloorPlan) => Object.fromEntries(moved.walls.map((item) => [
      item.id,
      [item.start, item.end].map((point) => `${point.x},${point.y}`).sort(),
    ]));
    for (const [id, delta] of [["partition", { x: 1, y: 0 }], ["right", { x: 1.5, y: 0 }], ["top", { x: 0, y: -0.7 }]] as const) {
      const first = moveWall(plan, id, delta), second = moveWall(variant, id, delta);
      expect(ends(second)).toEqual(ends(first));
      expect(second.openings).toEqual(first.openings);
    }
  });

  it("keeps the contract on every wall of the 3D example along and across its gesture direction", () => {
    const plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
    let accepted = 0, rejected = 0;
    for (const item of plan.walls) {
      const { direction } = wallMoveContext(plan.walls, item.id);
      const across = { x: -direction.y, y: direction.x };
      for (const [axis, distances] of [[direction, [-1.2, -0.5, -0.1, 0.1, 0.5, 1.2]], [across, [-0.4, 0.3]]] as const) {
        for (const distance of distances) {
          const delta = { x: axis.x * distance, y: axis.y * distance };
          let moved: FloorPlan;
          try {
            moved = moveWall(plan, item.id, delta);
          } catch (error) {
            expect((error as Error).message).toMatch(KNOWN_REJECTIONS);
            rejected++;
            continue;
          }
          expectMoveContract(plan, moved, item.id, delta);
          accepted++;
        }
      }
    }
    // Most moves along the gesture direction are valid; moves across it mostly tear a T.
    expect(accepted).toBeGreaterThan(40);
    expect(rejected).toBeGreaterThan(5);
  });

  it("never yields an integrity error over long random sequences of moves", () => {
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    let accepted = 0;
    for (const seed of [1, 2, 3]) {
      const next = random(seed);
      let plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
      for (let step = 0; step < 120; step++) {
        const item = plan.walls[Math.floor(next() * plan.walls.length)];
        const { direction } = wallMoveContext(plan.walls, item.id);
        const axis = next() < 0.85 ? direction : { x: -direction.y, y: direction.x };
        const distance = Math.round((next() * 3 - 1.5) * 10) / 10;
        const delta = { x: axis.x * distance, y: axis.y * distance };
        try {
          const moved = moveWall(plan, item.id, delta);
          if (moved !== plan) expectMoveContract(plan, moved, item.id, delta);
          plan = moved;
          accepted++;
        } catch (error) {
          expect((error as Error).message).toMatch(KNOWN_REJECTIONS);
        }
        expect(checkPlanIntegrity(plan).valid).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(150);
  });
});

const OFFSET_REJECTIONS = /опирается концом|примыкание соседней|ненулевую длину|±1000|границы стены|сократилась бы до нуля|разных направлений|той же прямой/;

/**
 * Offset contract: the wall's line moves by `distance` along its normal, every
 * other wall keeps its direction, junctions survive, openings on other walls stay
 * in place and openings on the wall move with its line; the result is valid.
 */
function expectOffsetContract(before: FloorPlan, after: FloorPlan, wallId: string, distance: number) {
  const context = wallMoveContext(before.walls, wallId);
  const { normal } = context;
  expect(after.walls.map((item) => item.id)).toEqual(before.walls.map((item) => item.id));
  for (const original of before.walls) {
    const next = wallOf(after, original.id);
    expect([next.thickness, next.height]).toEqual([original.thickness, original.height]);
    const a = { x: original.end.x - original.start.x, y: original.end.y - original.start.y };
    const b = { x: next.end.x - next.start.x, y: next.end.y - next.start.y };
    const sine = (a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
    expect(Math.abs(sine), `${original.id} keeps its direction`).toBeLessThan(1e-9);
    expect(a.x * b.x + a.y * b.y).toBeGreaterThan(0);
  }
  const original = wallOf(before, wallId), moved = wallOf(after, wallId);
  for (const endpoint of ["start", "end"] as const) {
    const shift = { x: moved[endpoint].x - original.start.x, y: moved[endpoint].y - original.start.y };
    expect(shift.x * normal.x + shift.y * normal.y).toBeCloseTo(distance, 9);
  }
  expectJunctionsKept(context.topology, after);
  // Ends sliding along two parallel lines translate the whole wall: its openings
  // ride along (rebaseOpenings). Otherwise they keep their place along the axis.
  const startShift = { x: moved.start.x - original.start.x, y: moved.start.y - original.start.y };
  const endShift = { x: moved.end.x - original.end.x, y: moved.end.y - original.end.y };
  const rigid = Math.hypot(startShift.x - endShift.x, startShift.y - endShift.y) <= 1e-9;
  const wallShift = rigid ? startShift : { x: normal.x * distance, y: normal.y * distance };
  for (const item of before.openings) {
    const [near0, far0] = span(before, item.id), [near1, far1] = span(after, item.id);
    const shift = item.wallId === wallId ? wallShift : { x: 0, y: 0 };
    expectPoint(near1, shifted(near0, shift));
    expectPoint(far1, shifted(far0, shift));
  }
  expect(checkPlanIntegrity(after).valid).toBe(true);
}

const rounded = (plan: FloorPlan) => JSON.parse(JSON.stringify(plan, (_, value) =>
  typeof value === "number" ? Math.round(value * 1e9) / 1e9 + 0 : value)) as FloorPlan;

describe("offsetting a wall while the others keep their directions", () => {
  /** A trapezoid: slanted sides meet the top wall at shared corners. */
  function trapezoid(): FloorPlan {
    return {
      ...createEmptyPlan("trapezoid"),
      roomMode: "walls",
      walls: [
        wall("top", 2, 0, 8, 0),
        wall("right", 8, 0, 10, 6),
        wall("bottom", 10, 6, 0, 6),
        wall("left", 0, 6, 2, 0),
      ],
      openings: [opening("window", "top", 1, "window", 1.2), opening("door", "left", 2)],
    };
  }

  it("lengthens a trapezoid's top wall along its slanted sides instead of turning them", () => {
    const plan = trapezoid();
    const context = wallMoveContext(plan.walls, "top");
    expect(context.offsetBlocked).toBeNull();
    expect(context.normal).toEqual({ x: 0, y: 1 });
    const moved = offsetWall(plan, "top", -1);
    expectPoint(wallOf(moved, "top").start, { x: 7 / 3, y: -1 });
    expectPoint(wallOf(moved, "top").end, { x: 23 / 3, y: -1 });
    expect(wallOf(moved, "left").start).toEqual({ x: 0, y: 6 });
    expect(wallOf(moved, "right").end).toEqual({ x: 10, y: 6 });
    expectOffsetContract(plan, moved, "top", -1);
    // The window keeps x = 3..4.2 on the moved wall; the door stays where it was.
    expectPoint(span(moved, "window")[0], { x: 3, y: -1 });
    expect(moved.openings.find((item) => item.id === "door")).toEqual(opening("door", "left", 2));
    // The plain move keeps the top wall's length and turns the sides instead.
    const rigid = moveWall(plan, "top", { x: 0, y: -1 });
    expect(wallOf(rigid, "top")).toEqual(wall("top", 2, -1, 8, -1));
  });

  it("keeps a slanted branch at its angle and slides its junction along the moved wall", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("branch"),
      walls: [wall("host", 0, 0, 10, 0), wall("branch", 4, 0, 6, 3)],
      openings: [opening("window", "branch", 1, "window", 1)],
    };
    const moved = offsetWall(plan, "host", -1);
    expect(wallOf(moved, "host")).toEqual(wall("host", 0, -1, 10, -1));
    expectPoint(wallOf(moved, "branch").start, { x: 4 - 2 / 3, y: -1 });
    expectOffsetContract(plan, moved, "host", -1);
    expect(contactsOf(buildWallTopology(moved.walls))).toEqual([
      { branch: "branch:start", host: "host", offset: Math.round((10 / 3) * 1e9) / 1e9 },
    ]);
  });

  it("slides the wall's own end along a slanted support that the plain move would tear off", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("support"),
      walls: [wall("support", 0, 0, 10, 5), wall("stem", 4, 2, 4, 8)],
      openings: [opening("door", "stem", 2)],
    };
    const context = wallMoveContext(plan.walls, "stem");
    expect(context.supports).toEqual(["support"]);
    expect(context.normal).toEqual({ x: -1, y: 0 });
    const moved = offsetWall(plan, "stem", -2);
    expectPoint(wallOf(moved, "stem").start, { x: 6, y: 3 });
    expectPoint(wallOf(moved, "stem").end, { x: 6, y: 8 });
    expectOffsetContract(plan, moved, "stem", -2);
    expect(() => moveWall(plan, "stem", { x: 2, y: 0 })).toThrow(/опирается концом/);
  });

  it("equals the plain move across a partition whose supports are perpendicular", () => {
    const plan = apartment();
    // The normal of the downward partition points to -x, so -1 moves it right.
    const offset = offsetWall(plan, "partition", -1);
    expect(rounded(offset)).toEqual(rounded(moveWall(plan, "partition", { x: 1, y: 0 })));
    expectOffsetContract(plan, offset, "partition", -1);
  });

  it("refuses nodes where walls of several directions meet, and collapsing walls, without touching the plan", () => {
    const split: FloorPlan = {
      ...createEmptyPlan("split"),
      walls: [wall("a", 0, 0, 5, 0), wall("b", 5, 0, 10, 0), wall("stem", 5, 0, 5, 4)],
    };
    expect(wallMoveContext(split.walls, "a").offsetBlocked).toBe(OFFSET_CONTINUATION);
    expect(() => offsetWall(split, "a", 1)).toThrow(OFFSET_CONTINUATION);
    // The stem's node lies on one straight line (a and b), so it can slide along it.
    expect(wallMoveContext(split.walls, "stem").offsetBlocked).toBeNull();
    const slid = offsetWall(split, "stem", -1);
    expectOffsetContract(split, slid, "stem", -1);
    expect(wallOf(slid, "a").end).toEqual({ x: 6, y: 0 });
    expect(wallOf(slid, "b").start).toEqual({ x: 6, y: 0 });

    const mixed: FloorPlan = {
      ...createEmptyPlan("mixed"),
      walls: [wall("w", 0, 0, 5, 0), wall("down", 5, 0, 5, 4), wall("diagonal", 5, 0, 8, 3)],
    };
    expect(wallMoveContext(mixed.walls, "w").offsetBlocked).toBe(OFFSET_MIXED_NODE);
    expect(() => previewWallOffset(mixed.walls, wallMoveContext(mixed.walls, "w"), 1)).toThrow(OFFSET_MIXED_NODE);

    const plan = trapezoid();
    const snapshot = structuredClone(plan);
    expect(() => offsetWall(plan, "top", 7)).toThrow(/сократилась бы до нуля/);
    expect(() => offsetWall(plan, "top", Number.NaN)).toThrow(/числом/);
    expect(() => offsetWall(plan, "missing", 1)).toThrow(/не найдена/);
    expect(() => offsetWall(plan, "top", 1, { start: { x: 2, y: 0 }, end: { x: 8, y: 1 } })).toThrow(WALL_MOVE_STALE);
    expect(offsetWall(plan, "top", 0)).toBe(plan);
    expect(plan).toEqual(snapshot);
  });

  it("matches the plain move on every wall of the orthogonal 3D example and keeps the contract", () => {
    const plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
    let accepted = 0;
    for (const item of plan.walls) {
      const context = wallMoveContext(plan.walls, item.id);
      expect(context.offsetBlocked).toBeNull();
      for (const distance of [-1.2, -0.5, -0.1, 0.1, 0.5, 1.2]) {
        const delta = { x: context.normal.x * distance, y: context.normal.y * distance };
        let offset: FloorPlan | Error, rigid: FloorPlan | Error;
        try { offset = offsetWall(plan, item.id, distance); } catch (error) { offset = error as Error; }
        try { rigid = moveWall(plan, item.id, delta); } catch (error) { rigid = error as Error; }
        if (offset instanceof Error || rigid instanceof Error) {
          expect(offset instanceof Error && rigid instanceof Error, `${item.id} ${distance}`).toBe(true);
          expect((offset as Error).message).toMatch(OFFSET_REJECTIONS);
          continue;
        }
        expect(rounded(offset)).toEqual(rounded(rigid));
        expectOffsetContract(plan, offset, item.id, distance);
        accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(40);
  });

  it("never yields an integrity error over random offset sequences on slanted plans", () => {
    const next = (() => {
      let seed = 7;
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    })();
    let accepted = 0;
    for (const start of [trapezoid(), { ...createSpatialExamplePlan(), roomMode: "walls" as const }]) {
      let plan: FloorPlan = start;
      for (let step = 0; step < 80; step++) {
        const item = plan.walls[Math.floor(next() * plan.walls.length)];
        const distance = Math.round((next() * 2 - 1) * 10) / 10;
        let moved: FloorPlan;
        try {
          moved = offsetWall(plan, item.id, distance);
        } catch (error) {
          expect((error as Error).message).toMatch(OFFSET_REJECTIONS);
          continue;
        }
        if (moved !== plan) expectOffsetContract(plan, moved, item.id, distance);
        plan = moved;
        accepted++;
        expect(checkPlanIntegrity(plan).valid).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(80);
  });
});
