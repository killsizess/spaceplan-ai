import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { analyzeDoorWallCollisions } from "./door-collisions";
import { doorSwingWorld } from "./door-swing";
import type { DoorSwing, Opening, Wall } from "./types";

const owner: Wall = {
  id: "owner", start: { x: 0, y: 0 }, end: { x: 5, y: 0 },
  thickness: 0.2, height: 3,
};
const door: Opening = {
  id: "door", wallId: owner.id, kind: "door", offset: 1,
  width: 1, height: 2.1, sillHeight: 0,
};
const obstacle: Wall = {
  id: "obstacle", start: { x: 1.3, y: -0.5 }, end: { x: 1.7, y: -0.5 },
  thickness: 0.1, height: 2.7,
};
const swings: DoorSwing[] = [
  { hinge: "start", side: "left" }, { hinge: "start", side: "right" },
  { hinge: "end", side: "left" }, { hinge: "end", side: "right" },
];

function transformed(point: Point, angle: number): Point {
  return {
    x: 20 + point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: -30 + point.x * Math.sin(angle) + point.y * Math.cos(angle),
  };
}

function expectWitnessInWall(point: Point, wall: Wall) {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  const along = ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / length;
  const normal = (-(point.x - wall.start.x) * dy + (point.y - wall.start.y) * dx) / length;
  expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  expect(along).toBeGreaterThanOrEqual(-1e-9);
  expect(along).toBeLessThanOrEqual(length + 1e-9);
  expect(Math.abs(normal)).toBeLessThanOrEqual(wall.thickness / 2 + 1e-9);
}

describe("analyzeDoorWallCollisions", () => {
  it("detects the full sweep when the final 90° leaf is already clear", () => {
    const result = analyzeDoorWallCollisions([owner, obstacle], [door]);
    expect(result.truncated).toBe(false);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatchObject({
      id: 'door-wall-collision:["door","obstacle"]', doorId: door.id, wallId: obstacle.id,
    });
    expect(result.collisions[0].point.x).toBeGreaterThan(1.2);
    expectWitnessInWall(result.collisions[0].point, obstacle);
    const dx = result.collisions[0].point.x - 1;
    const dy = result.collisions[0].point.y;
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.hypot(dx, dy)).toBeLessThan(1);
  });

  it.each(swings)("uses the same $hinge / $side sector on diagonal and reversed axes", (swing) => {
    const hingeX = swing.hinge === "start" ? 1 : 2;
    const signX = swing.hinge === "start" ? 1 : -1;
    const signY = swing.side === "left" ? -1 : 1;
    const localObstacle = {
      ...obstacle,
      start: { x: hingeX + signX * 0.3, y: signY * 0.5 },
      end: { x: hingeX + signX * 0.7, y: signY * 0.5 },
    };
    for (const degrees of [0, 17, 90, 135, 180, 274]) {
      const angle = degrees * Math.PI / 180;
      const rotatedOwner = { ...owner, start: transformed(owner.start, angle), end: transformed(owner.end, angle) };
      const rotatedObstacle = { ...localObstacle, start: transformed(localObstacle.start, angle), end: transformed(localObstacle.end, angle) };
      const opening = { ...door, door: swing };
      const result = analyzeDoorWallCollisions([rotatedOwner, rotatedObstacle], [opening]);
      expect(result.collisions).toHaveLength(1);
      expectWitnessInWall(result.collisions[0].point, rotatedObstacle);
      const geometry = doorSwingWorld(rotatedOwner, opening)!;
      const witness = result.collisions[0].point;
      expect(Math.hypot(witness.x - geometry.hinge.x, witness.y - geometry.hinge.y)).toBeLessThan(door.width);
    }
  });

  it("preserves the physical collision when wall direction, hinge and side reverse together", () => {
    const forward = analyzeDoorWallCollisions([owner, obstacle], [door]);
    const reverse = analyzeDoorWallCollisions([
      { ...owner, start: owner.end, end: owner.start },
      { ...obstacle, start: obstacle.end, end: obstacle.start },
    ], [{ ...door, offset: 3, door: { hinge: "end", side: "right" } }]);
    expect(reverse.collisions[0].id).toBe(forward.collisions[0].id);
    expect(reverse.collisions[0].point.x).toBeCloseTo(forward.collisions[0].point.x, 12);
    expect(reverse.collisions[0].point.y).toBeCloseTo(forward.collisions[0].point.y, 12);
  });

  it("uses wall thickness rather than only its centre line", () => {
    const outsideAxis = { ...obstacle, start: { x: 0.5, y: -1.04 }, end: { x: 1.5, y: -1.04 } };
    const result = analyzeDoorWallCollisions([owner, outsideAxis], [door]);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].point.y).toBeCloseTo(-0.99, 12);
    expectWitnessInWall(result.collisions[0].point, outsideAxis);
  });

  it("detects tiny curved penetration between every rendered arc sample", () => {
    const theta = Math.PI / 4 + Math.PI / 128;
    const radial = { x: Math.cos(theta), y: -Math.sin(theta) };
    const tangent = { x: Math.sin(theta), y: Math.cos(theta) };
    const center = { x: 1 + radial.x, y: radial.y };
    const tiny = {
      ...obstacle, thickness: 2e-6,
      start: { x: center.x - tangent.x * 0.001, y: center.y - tangent.y * 0.001 },
      end: { x: center.x + tangent.x * 0.001, y: center.y + tangent.y * 0.001 },
    };
    const geometry = doorSwingWorld(owner, door)!;
    // Every vertex and every chord lies strictly inward of the obstacle's near face.
    const maximumRenderedProjection = Math.max(...geometry.arc.map((point) =>
      (point.x - geometry.hinge.x) * radial.x + (point.y - geometry.hinge.y) * radial.y,
    ));
    expect(maximumRenderedProjection).toBeLessThan(1 - 1e-6);
    const result = analyzeDoorWallCollisions([owner, tiny], [door]);
    expect(result.collisions).toHaveLength(1);
    expectWitnessInWall(result.collisions[0].point, tiny);
  });

  it("ignores only contact with the curve or sector axes", () => {
    const curve = { ...obstacle, start: { x: 0.5, y: -1.05 }, end: { x: 1.5, y: -1.05 } };
    const closedAxis = { ...obstacle, start: { x: 1.2, y: 0.05 }, end: { x: 1.8, y: 0.05 } };
    const openAxis = { ...obstacle, start: { x: 0.95, y: -0.8 }, end: { x: 0.95, y: -0.2 } };
    for (const tangentWall of [curve, closedAxis, openAxis]) {
      expect(analyzeDoorWallCollisions([owner, tangentWall], [door]).collisions).toEqual([]);
    }
    for (const penetratingWall of [
      { ...curve, start: { x: 0.5, y: -1.049999 }, end: { x: 1.5, y: -1.049999 } },
      { ...closedAxis, start: { x: 1.2, y: 0.049999 }, end: { x: 1.8, y: 0.049999 } },
      { ...openAxis, start: { x: 0.950001, y: -0.8 }, end: { x: 0.950001, y: -0.2 } },
    ]) {
      expect(analyzeDoorWallCollisions([owner, penetratingWall], [door]).collisions).toHaveLength(1);
    }
  });

  it("ignores sub-tolerance radial contact but detects resolved penetration", () => {
    const wallAt = (depth: number): Wall => ({
      ...obstacle, start: { x: 0.5, y: -1.05 + depth }, end: { x: 1.5, y: -1.05 + depth },
    });
    expect(analyzeDoorWallCollisions([owner, wallAt(5e-10)], [door]).collisions).toHaveLength(0);
    expect(analyzeDoorWallCollisions([owner, wallAt(2e-9)], [door]).collisions).toHaveLength(1);
  });

  it("subtracts the other wall's passage when its lintel clears the door", () => {
    const passage: Opening = {
      id: "passage", wallId: obstacle.id, kind: "window", offset: 0,
      width: 0.4, sillHeight: 0, height: 2.2,
    };
    expect(analyzeDoorWallCollisions([owner, obstacle], [door, passage]).collisions).toEqual([]);
    expect(analyzeDoorWallCollisions([owner, obstacle], [door, {
      ...passage, height: 2.1,
    }]).collisions).toEqual([]);
    expect(analyzeDoorWallCollisions([owner, obstacle], [door, {
      ...passage, height: 2.1 - 1e-5,
    }]).collisions).toHaveLength(1);
  });

  it("retains sills and reports one pair even when sill and lintel both obstruct", () => {
    const window: Opening = {
      id: "other-window", wallId: obstacle.id, kind: "window", offset: 0,
      width: 0.4, sillHeight: 0.5, height: 1,
    };
    expect(analyzeDoorWallCollisions([owner, obstacle], [door, window]).collisions).toHaveLength(1);
    expect(analyzeDoorWallCollisions([owner, obstacle], [
      { ...door, sillHeight: 1.1, height: 1 },
      { ...window, sillHeight: 1, height: 1.4 },
    ]).collisions).toEqual([]);
  });

  it("requires positive vertical overlap with a low obstacle", () => {
    const raisedDoor = { ...door, sillHeight: 1.1, height: 1 };
    expect(analyzeDoorWallCollisions([owner, { ...obstacle, height: 1.1 }], [raisedDoor]).collisions).toEqual([]);
    expect(analyzeDoorWallCollisions([owner, { ...obstacle, height: 1.10001 }], [raisedDoor]).collisions).toHaveLength(1);
  });

  it("keeps remaining horizontal jamb solids outside a partial passage", () => {
    const window: Opening = {
      id: "other-window", wallId: obstacle.id, kind: "window", offset: 0.1,
      width: 0.2, sillHeight: 0, height: 2.2,
    };
    expect(analyzeDoorWallCollisions([owner, obstacle], [door, window]).collisions).toHaveLength(1);
  });

  it("excludes the supporting wall and windows, and leaves clear geometry alone", () => {
    expect(analyzeDoorWallCollisions([owner], [door])).toEqual({ collisions: [], truncated: false });
    expect(analyzeDoorWallCollisions([owner, obstacle], [{ ...door, kind: "window" }]).collisions).toEqual([]);
    expect(analyzeDoorWallCollisions([owner, {
      ...obstacle, start: { x: 4, y: -1 }, end: { x: 4, y: -2 },
    }], [door]).collisions).toEqual([]);
    expect(analyzeDoorWallCollisions([], [])).toEqual({ collisions: [], truncated: false });
  });

  it("does not collide against another door leaf inside a fully open passage", () => {
    const passage: Opening = {
      id: "other-door", wallId: obstacle.id, kind: "door", offset: 0,
      width: 0.4, sillHeight: 0, height: 2.2,
    };
    const result = analyzeDoorWallCollisions([owner, obstacle], [door, passage]);
    expect(result.collisions.filter((collision) => collision.doorId === door.id)).toEqual([]);
  });

  it("sorts stable pair IDs independently of all input orders and caps only actual results", () => {
    const walls = [
      { ...owner, end: { x: 6, y: 0 } },
      { ...obstacle, id: 'wall-z:"', start: { x: 1.3, y: -0.5 }, end: { x: 3.7, y: -0.5 } },
      { ...obstacle, id: "wall-a", start: { x: 1.3, y: -0.7 }, end: { x: 3.7, y: -0.7 } },
    ];
    const openings = [{ ...door, id: "door-b", offset: 3 }, { ...door, id: "door-a" }];
    const all = analyzeDoorWallCollisions(walls, openings);
    expect(all.collisions.map(({ doorId, wallId }) => [doorId, wallId])).toEqual([
      ["door-a", "wall-a"], ["door-a", 'wall-z:"'], ["door-b", "wall-a"], ["door-b", 'wall-z:"'],
    ]);
    expect(analyzeDoorWallCollisions([...walls].reverse(), [...openings].reverse())).toEqual(all);
    expect(analyzeDoorWallCollisions(walls, openings, 2)).toEqual({ collisions: all.collisions.slice(0, 2), truncated: true });
    expect(analyzeDoorWallCollisions(walls, openings, 4)).toEqual(all);
    expect(analyzeDoorWallCollisions(walls, openings, 5)).toEqual(all);
    expect(new Set(all.collisions.map((collision) => collision.id)).size).toBe(4);
  });

  it("applies the default 100 and maximum 1000 result limits without claiming a total", () => {
    const longOwner = { ...owner, end: { x: 1000, y: 0 } };
    const walls = [longOwner, ...[0.4, 0.6, 0.8].map((distance, index) => ({
      ...obstacle, id: `block-${index}`, start: { x: 0, y: -distance }, end: { x: 1000, y: -distance },
    }))];
    const openings = Array.from({ length: 500 }, (_, index) => ({ ...door, id: `door-${index}`, offset: index * 2 }));
    expect(analyzeDoorWallCollisions(walls, openings).collisions).toHaveLength(100);
    expect(analyzeDoorWallCollisions(walls, openings).truncated).toBe(true);
    const maximum = analyzeDoorWallCollisions(walls, openings, 1000);
    expect(maximum.collisions).toHaveLength(1000);
    expect(maximum.truncated).toBe(true);
  });

  it("accepts frozen inputs and never exposes source point references", () => {
    const walls = [structuredClone(owner), structuredClone(obstacle)];
    const openings = [{ ...door, door: { hinge: "end", side: "left" } as DoorSwing }];
    const before = JSON.stringify({ walls, openings });
    for (const wall of walls) { Object.freeze(wall.start); Object.freeze(wall.end); Object.freeze(wall); }
    Object.freeze(openings[0].door); Object.freeze(openings[0]);
    Object.freeze(walls); Object.freeze(openings);
    const result = analyzeDoorWallCollisions(walls, openings);
    expect(result.collisions).toHaveLength(1);
    expect(JSON.stringify({ walls, openings })).toBe(before);
    for (const wall of walls) {
      expect(result.collisions[0].point).not.toBe(wall.start);
      expect(result.collisions[0].point).not.toBe(wall.end);
    }
  });

  it.each([0, -1, 1001, 1.5, NaN, Infinity])("rejects an invalid limit %s", (limit) => {
    expect(() => analyzeDoorWallCollisions([], [], limit)).toThrow(/Лимит/);
  });

  it.each([
    { ...owner, id: "" }, { ...owner, id: "x".repeat(101) },
    { ...owner, start: { x: NaN, y: 0 } }, { ...owner, end: { x: Infinity, y: 0 } },
    { ...owner, end: owner.start }, { ...owner, start: { x: -1001, y: 0 } },
    { ...owner, thickness: 0 }, { ...owner, thickness: Infinity },
    { ...owner, height: -1 }, { ...owner, height: NaN },
  ])("rejects invalid wall input %# before producing diagnostics", (invalid) => {
    expect(() => analyzeDoorWallCollisions([invalid], [])).toThrow();
  });

  it.each([
    { ...door, id: "" }, { ...door, wallId: "missing" },
    { ...door, width: 0 }, { ...door, offset: NaN }, { ...door, height: Infinity },
    { ...door, sillHeight: -1 }, { ...door, offset: 4.5 }, { ...door, height: 4 },
    { ...door, kind: "window", door: { hinge: "start", side: "left" } },
    { ...door, door: { hinge: "middle", side: "left" } },
  ])("rejects invalid opening input %#", (invalid) => {
    expect(() => analyzeDoorWallCollisions([owner], [invalid as Opening])).toThrow();
  });

  it("rejects duplicate global IDs, overlapping openings and invalid data beyond the cap", () => {
    expect(() => analyzeDoorWallCollisions([owner, owner], [])).toThrow(/уникальными/);
    expect(() => analyzeDoorWallCollisions([owner], [door, door])).toThrow(/уникальными/);
    expect(() => analyzeDoorWallCollisions([owner], [{ ...door, id: owner.id }])).toThrow(/уникальными/);
    expect(() => analyzeDoorWallCollisions([owner], [door, { ...door, id: "other", offset: 1.5 }])).toThrow(/перекрываться/);
    expect(() => analyzeDoorWallCollisions([owner, obstacle], [door, { ...door, id: "bad", width: NaN }], 1)).toThrow();
  });

  it("rejects more than 1000 walls or openings", () => {
    expect(() => analyzeDoorWallCollisions(Array.from({ length: 1001 }, (_, index) => ({ ...owner, id: `wall-${index}` })), [])).toThrow(/1000/);
    expect(() => analyzeDoorWallCollisions([owner], Array.from({ length: 1001 }, (_, index) => ({ ...door, id: `door-${index}` })))).toThrow(/1000/);
  });
});
