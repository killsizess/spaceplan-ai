import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { analyzeDoorPairCollisions } from "./door-pair-collisions";
import type { DoorSwing, Opening, Wall } from "./types";

interface Fixture { wall: Wall; door: Opening; }

function fixture(id: string, hinge: Point = { x: 0, y: 0 }, angle = 0, width = 1,
  swing: DoorSwing = { hinge: "start", side: "left" }): Fixture {
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const offset = 1;
  const distance = offset + (swing.hinge === "end" ? width : 0);
  const start = { x: hinge.x - distance * axis.x, y: hinge.y - distance * axis.y };
  return {
    wall: { id: `wall-${id}`, start, end: { x: start.x + (width + 2) * axis.x, y: start.y + (width + 2) * axis.y }, height: 4, thickness: 0.2 },
    door: { id, wallId: `wall-${id}`, kind: "door", offset, width, height: 2.1, sillHeight: 0, door: swing },
  };
}

function analyze(fixtures: readonly Fixture[], limit = 100) {
  return analyzeDoorPairCollisions(fixtures.map((item) => item.wall), fixtures.map((item) => item.door), limit);
}

/** Independent sector coordinates from the wall axis and model parameters. */
function coordinates(f: Fixture, point: Point): { x: number; y: number } {
  const axis = { x: f.wall.end.x - f.wall.start.x, y: f.wall.end.y - f.wall.start.y };
  const length = Math.hypot(axis.x, axis.y);
  axis.x /= length; axis.y /= length;
  const swing = f.door.door ?? { hinge: "start", side: "left" };
  const atEnd = swing.hinge === "end";
  const distance = f.door.offset + (atEnd ? f.door.width : 0);
  const dx = point.x - f.wall.start.x - distance * axis.x;
  const dy = point.y - f.wall.start.y - distance * axis.y;
  return {
    x: (dx * axis.x + dy * axis.y) * (atEnd ? -1 : 1),
    y: (-dx * axis.y + dy * axis.x) * (swing.side === "left" ? -1 : 1),
  };
}

function expectWitness(point: Point, fixtures: readonly Fixture[]) {
  expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  for (const f of fixtures) {
    const local = coordinates(f, point);
    expect(local.x).toBeGreaterThan(0);
    expect(local.y).toBeGreaterThan(0);
    expect(Math.hypot(local.x, local.y)).toBeLessThan(f.door.width);
  }
}

describe("analyzeDoorPairCollisions", () => {
  it("finds potential conflicts in the whole sweeps even with clear 90° leaves", () => {
    const a = fixture("door-a");
    const b = fixture("door-b", { x: 0.5, y: 0 });
    const result = analyze([a, b]);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatchObject({ id: 'door-pair-collision:["door-a","door-b"]', doorIds: ["door-a", "door-b"] });
    // Both open leaves are parallel vertical segments at x=0 and x=.5.
    expect(result.collisions[0].point.x).toBeGreaterThan(0.5);
    expect(result.truncated).toBe(false);
    expectWitness(result.collisions[0].point, [a, b]);
  });

  const swings: DoorSwing[] = [
    { hinge: "start", side: "left" }, { hinge: "start", side: "right" },
    { hinge: "end", side: "left" }, { hinge: "end", side: "right" },
  ];
  it.each(swings)("keeps $hinge/$side sectors correct on arbitrary and reversed wall directions", (swing) => {
    for (const degrees of [0, 17, 90, 135, 180, 274]) {
      const angle = degrees * Math.PI / 180;
      const a = fixture("a", { x: 20, y: -30 }, angle, 1, swing);
      const sign = swing.hinge === "start" ? 1 : -1;
      const signY = swing.side === "left" ? -1 : 1;
      const closed = { x: sign * Math.cos(angle), y: sign * Math.sin(angle) };
      const opened = { x: -signY * Math.sin(angle), y: signY * Math.cos(angle) };
      const secondHinge = { x: 20 + 0.2 * (closed.x + opened.x), y: -30 + 0.2 * (closed.y + opened.y) };
      const direction = closed.x * opened.y - closed.y * opened.x;
      const b = fixture("b", secondHinge, Math.atan2(closed.y, closed.x), 0.5, { hinge: "start", side: direction < 0 ? "left" : "right" });
      const result = analyze([a, b]);
      expect(result.collisions).toHaveLength(1);
      expectWitness(result.collisions[0].point, [a, b]);
    }
  });

  it("retains the physical result when both supporting wall axes are reversed", () => {
    const fixtures = [fixture("a"), fixture("b", { x: 0.5, y: 0 })];
    const result = analyze(fixtures);
    const reverse = fixtures.map((f) => ({
      wall: { ...f.wall, start: f.wall.end, end: f.wall.start },
      door: { ...f.door, door: { hinge: "end", side: "right" } as DoorSwing },
    }));
    expect(analyze(reverse)).toEqual(result);
  });

  it("ignores distant sectors, windows and an empty or single-door plan", () => {
    const a = fixture("a");
    const distant = fixture("b", { x: 4, y: 4 });
    expect(analyze([a, distant]).collisions).toEqual([]);
    expect(analyze([])).toEqual({ collisions: [], truncated: false });
    expect(analyze([a]).collisions).toEqual([]);
    const window: Opening = { ...a.door, id: "window", kind: "window" }; delete window.door;
    expect(analyzeDoorPairCollisions([a.wall], [window])).toEqual({ collisions: [], truncated: false });
  });

  it("checks legal adjacent doors on one wall without reporting shared boundaries", () => {
    const wall: Wall = { id: "host", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 4 };
    const a = { ...fixture("a").door, wallId: wall.id, offset: 1 };
    const b = { ...fixture("b").door, wallId: wall.id, offset: 2, door: { hinge: "end", side: "left" } as DoorSwing };
    expect(analyzeDoorPairCollisions([wall], [a, b]).collisions).toEqual([]);
    expect(() => analyzeDoorPairCollisions([wall], [a, { ...b, offset: 1.5 }])).toThrow(/перекрываться/);
  });

  it.each([0, Math.PI / 2, Math.PI])("does not warn when a shared hinge has only a common boundary (angle %s)", (angle) => {
    const a = fixture("a");
    const b = fixture("b", { x: 0, y: 0 }, angle, 1, { hinge: "start", side: "right" });
    const result = analyze([a, b]);
    expect(result.collisions).toEqual([]);
  });

  it("detects shared hinges with coincident sectors and a contained smaller sector", () => {
    const a = fixture("a", { x: 0, y: 0 }, 0, 2);
    for (const b of [fixture("b"), fixture("b", { x: 0.2, y: -0.2 }, 0, 0.2)]) {
      const result = analyze([a, b]);
      expect(result.collisions).toHaveLength(1);
      expectWitness(result.collisions[0].point, [a, b]);
    }
  });

  it("ignores circle tangency but detects penetration between rendered arc samples", () => {
    const angle = Math.PI / 128;
    const a = fixture("a");
    const opposite: DoorSwing = { hinge: "start", side: "left" };
    const b = fixture("b", { x: 2 * Math.cos(angle), y: -2 * Math.sin(angle) }, Math.PI, 1, opposite);
    expect(analyze([a, b]).collisions).toEqual([]);
    const distance = 2 - 1e-6;
    const penetrating = fixture("b", { x: distance * Math.cos(angle), y: -distance * Math.sin(angle) }, Math.PI);
    const result = analyze([a, penetrating]);
    expect(result.collisions).toHaveLength(1);
    expectWitness(result.collisions[0].point, [a, penetrating]);
    // At this angle the chord approximation loses ~0.3mm on each circle,
    // vastly more than the actual 1µm penetration that must still be found.
    expect(1 - Math.cos(Math.PI / 128)).toBeGreaterThan(100 * 1e-6);
  });

  it.each([0, 0.5e-9, 1e-9, 10e-9])("handles near-tangency with the metric tolerance (penetration %s)", (penetration) => {
    const a = fixture("a");
    const distance = 2 - penetration;
    const b = fixture("b", { x: distance / Math.sqrt(2), y: -distance / Math.sqrt(2) }, Math.PI);
    const result = analyze([a, b]);
    expect(result.collisions.length).toBe(penetration > 2e-9 ? 1 : 0);
    if (result.collisions.length) expectWitness(result.collisions[0].point, [a, b]);
  });

  it("respects disjoint or touching height intervals but finds positive vertical overlap", () => {
    const a = fixture("a");
    const b = fixture("b", { x: 0.5, y: 0 });
    b.door.height = 1; b.door.sillHeight = 2.1;
    expect(analyze([a, b]).collisions).toEqual([]);
    b.door.sillHeight = 2.2;
    expect(analyze([a, b]).collisions).toEqual([]);
    b.door.sillHeight = 2.1 - 1e-6;
    expect(analyze([a, b]).collisions).toHaveLength(1);
  });

  it("keeps small sectors well resolved near the largest global coordinates", () => {
    const a = fixture("a", { x: 990, y: -990 }, 0.35, 1e-5);
    const b = fixture("b", { x: 990 + 2e-6, y: -990 - 2e-6 }, 0.35, 1e-5);
    const result = analyze([a, b]);
    expect(result.collisions).toHaveLength(1);
    expectWitness(result.collisions[0].point, [a, b]);
  });

  it("handles very large radii with finite world witnesses", () => {
    const a: Fixture = { wall: { id: "wall-a", start: { x: -500, y: 0 }, end: { x: 500, y: 0 }, height: 4, thickness: 0.2 }, door: { id: "a", wallId: "wall-a", kind: "door", offset: 0, width: 1000, height: 2, sillHeight: 0 } };
    const b: Fixture = { wall: { ...a.wall, id: "wall-b", start: a.wall.end, end: a.wall.start }, door: { ...a.door, id: "b", wallId: "wall-b", door: { hinge: "start", side: "right" } } };
    const result = analyze([a, b]);
    expect(result.collisions).toHaveLength(1);
    expectWitness(result.collisions[0].point, [a, b]);
  });

  it("uses stable pair IDs and order, detects truncation only after another real pair", () => {
    const fixtures = [fixture('z:"'), fixture("b", { x: 0.2, y: -0.2 }), fixture("a", { x: 0.1, y: -0.1 })];
    const result = analyze(fixtures);
    expect(result.collisions.map((item) => item.doorIds)).toEqual([["a", "b"], ["a", 'z:"'], ["b", 'z:"']]);
    expect(analyze(fixtures.toReversed())).toEqual(result);
    expect(new Set(result.collisions.map((item) => item.id)).size).toBe(3);
    expect(analyze(fixtures, 2)).toEqual({ collisions: result.collisions.slice(0, 2), truncated: true });
    expect(analyze(fixtures, 3)).toEqual(result);
    expect(analyze(fixtures, 4)).toEqual(result);
  });

  it("supports the default cap and the maximum limit without claiming a total", () => {
    const fixtures = Array.from({ length: 46 }, (_, index) => fixture(`door-${index}`));
    expect(analyze(fixtures).collisions).toHaveLength(100);
    expect(analyze(fixtures).truncated).toBe(true);
    const maximum = analyze(fixtures, 1000);
    expect(maximum.collisions).toHaveLength(1000);
    expect(maximum.truncated).toBe(true);
  });

  it("finds independently sampled positive witnesses and returns valid points for 1000 deterministic random pairs", () => {
    let seed = 0x6a09e667;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let sampledPositive = 0;
    let returned = 0;
    for (let index = 0; index < 1000; index++) {
      const hinge = { x: 8 * random() - 4, y: 8 * random() - 4 };
      const angle = random() * 2 * Math.PI;
      const swing = swings[Math.floor(random() * swings.length)];
      const a = fixture("a", hinge, angle, 0.3 + 1.7 * random(), swing);
      const b = fixture("b", { x: hinge.x + 3.2 * random() - 1.6, y: hinge.y + 3.2 * random() - 1.6 },
        random() * 2 * Math.PI, 0.3 + 1.7 * random(), swings[Math.floor(random() * swings.length)]);
      const result = analyze([a, b]);
      if (result.collisions.length) {
        returned++;
        expectWitness(result.collisions[0].point, [a, b]);
      }
      // Sampling is only an independent sufficient witness of positive overlap:
      // no negative inference is made when this deliberately coarse grid misses.
      const closedAngle = angle + (swing.hinge === "end" ? Math.PI : 0);
      const openAngle = angle + (swing.side === "left" ? -Math.PI / 2 : Math.PI / 2);
      let witness = false;
      for (let radial = 1; radial <= 8 && !witness; radial++) for (let angular = 1; angular < 24; angular++) {
        const theta = angular * Math.PI / 48;
        const radius = a.door.width * radial / 9;
        const point = {
          x: hinge.x + radius * (Math.cos(theta) * Math.cos(closedAngle) + Math.sin(theta) * Math.cos(openAngle)),
          y: hinge.y + radius * (Math.cos(theta) * Math.sin(closedAngle) + Math.sin(theta) * Math.sin(openAngle)),
        };
        const local = coordinates(b, point);
        if (local.x > 1e-5 && local.y > 1e-5 && Math.hypot(local.x, local.y) < b.door.width - 1e-5) {
          witness = true; break;
        }
      }
      if (witness) {
        sampledPositive++;
        expect(result.collisions, `independent positive witness in case ${index}`).toHaveLength(1);
      }
    }
    expect(sampledPositive).toBeGreaterThan(60);
    expect(returned).toBeGreaterThanOrEqual(sampledPositive);
  });

  it("accepts frozen inputs and returns a new world point without mutating model values", () => {
    const fixtures = [fixture("a"), fixture("b", { x: 0.5, y: 0 })];
    const before = JSON.stringify(fixtures);
    for (const f of fixtures) {
      Object.freeze(f.wall.start); Object.freeze(f.wall.end); Object.freeze(f.wall);
      Object.freeze(f.door.door); Object.freeze(f.door);
    }
    Object.freeze(fixtures);
    const result = analyze(fixtures);
    expect(result.collisions).toHaveLength(1);
    expect(JSON.stringify(fixtures)).toBe(before);
    for (const f of fixtures) {
      expect(result.collisions[0].point).not.toBe(f.wall.start);
      expect(result.collisions[0].point).not.toBe(f.wall.end);
    }
  });

  it.each([0, -1, 1001, 1.5, NaN, Infinity])("rejects invalid limits %s", (limit) => {
    expect(() => analyzeDoorPairCollisions([], [], limit)).toThrow(/Лимит/);
  });

  it("validates bad IDs, geometry and relational openings before producing any capped result", () => {
    const a = fixture("a"), b = fixture("b", { x: 0.5, y: 0 });
    const invalidWalls: Wall[] = [
      { ...a.wall, id: "" }, { ...a.wall, id: "x".repeat(101) },
      { ...a.wall, start: { x: NaN, y: 0 } }, { ...a.wall, start: { x: -1001, y: 0 } },
      { ...a.wall, end: a.wall.start }, { ...a.wall, thickness: 0 }, { ...a.wall, height: Infinity },
    ];
    for (const wall of invalidWalls) expect(() => analyzeDoorPairCollisions([wall], [])).toThrow();
    const invalidDoors: Opening[] = [
      { ...a.door, id: "" }, { ...a.door, wallId: "missing" }, { ...a.door, width: NaN },
      { ...a.door, height: 0 }, { ...a.door, sillHeight: -1 }, { ...a.door, offset: 100 },
      { ...a.door, height: 100 }, { ...a.door, kind: "window" },
      { ...a.door, door: { hinge: "middle", side: "left" } as unknown as DoorSwing },
    ];
    for (const door of invalidDoors) expect(() => analyzeDoorPairCollisions([a.wall, b.wall], [b.door, door], 1)).toThrow();
    expect(() => analyzeDoorPairCollisions([a.wall, a.wall], [])).toThrow(/уникальными/);
    expect(() => analyzeDoorPairCollisions([a.wall], [a.door, a.door])).toThrow(/уникальными/);
    expect(() => analyzeDoorPairCollisions([a.wall], [{ ...a.door, id: a.wall.id }])).toThrow(/уникальными/);
    expect(() => analyzeDoorPairCollisions([a.wall], [a.door, { ...a.door, id: "overlap", offset: 1.5 }])).toThrow(/перекрываться/);
    expect(() => analyzeDoorPairCollisions(Array.from({ length: 1001 }, (_, index) => ({ ...a.wall, id: `wall-${index}` })), [])).toThrow(/1000/);
    expect(() => analyzeDoorPairCollisions([a.wall], Array.from({ length: 1001 }, (_, index) => ({ ...a.door, id: `door-${index}` })))).toThrow(/1000/);
  });
});
