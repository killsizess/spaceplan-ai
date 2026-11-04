import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import {
  findOpeningCandidates,
  MAX_OPENING_INPUT_SEGMENTS,
  openingFromCandidate,
  type CurvePolyline,
} from "./opening-candidates";
import type { Opening, Wall } from "./types";
import type { LineSegment } from "./wall-candidates";

const T = 0.2;

/** A drawing in the local frame of one wall (x along it, y across it), placed anywhere on the sheet. */
class Sheet {
  segments: LineSegment[] = [];
  curves: CurvePolyline[] = [];
  private readonly ux: number;
  private readonly uy: number;
  constructor(private readonly origin: Point, angleDeg = 0) {
    this.ux = Math.cos((angleDeg * Math.PI) / 180);
    this.uy = Math.sin((angleDeg * Math.PI) / 180);
  }
  at(x: number, y: number): Point {
    return { x: this.origin.x + this.ux * x - this.uy * y, y: this.origin.y + this.uy * x + this.ux * y };
  }
  line(x1: number, y1: number, x2: number, y2: number) {
    this.segments.push({ start: this.at(x1, y1), end: this.at(x2, y2) });
    return this;
  }
  /** Both face lines of a wall of length `length`, interrupted over the given gaps. */
  faces(length: number, gaps: [number, number][] = [], thickness = T) {
    let from = 0;
    for (const [a, b] of [...gaps, [length, length] as [number, number]]) {
      for (const y of [-thickness / 2, thickness / 2]) this.line(from, y, a, y);
      from = b;
    }
    return this;
  }
  jambs(x0: number, x1: number, thickness = T) {
    return this.line(x0, -thickness / 2, x0, thickness / 2).line(x1, -thickness / 2, x1, thickness / 2);
  }
  /** Leaf standing out of the hinge at `hinge`, and the quarter circle it sweeps. */
  door(hinge: number, other: number, side: 1 | -1, withLeaf = true, withArc = true) {
    const width = Math.abs(other - hinge), direction = Math.sign(other - hinge);
    if (withLeaf) this.line(hinge, 0, hinge, side * width);
    if (withArc) {
      const points: Point[] = [];
      for (let i = 0; i <= 8; i++) {
        const angle = (i / 8) * (Math.PI / 2);
        points.push(this.at(hinge + direction * width * Math.cos(angle), side * width * Math.sin(angle)));
      }
      this.curves.push({ points });
    }
    return this;
  }
  glazing(x0: number, x1: number, ys: number[]) {
    for (const y of ys) this.line(x0, y, x1, y);
    return this;
  }
}

const wall = (id: string, start: Point, end: Point, thickness = T): Wall => ({ id, start, end, thickness, height: 2.7 });
const horizontal = (id = "w", length = 6) => wall(id, { x: 0, y: 0 }, { x: length, y: 0 });
const find = (sheet: Sheet, walls: Wall[], openings: Opening[] = []) =>
  findOpeningCandidates(sheet.segments, sheet.curves, walls, openings);

describe("openings in an existing wall (both face lines interrupted)", () => {
  it.each([
    ["hinge at the start, opens to +Y", 1, 1.9, 1, { hinge: "start", side: "right" }],
    ["hinge at the start, opens to −Y", 1, 1.9, -1, { hinge: "start", side: "left" }],
    ["hinge at the end, opens to +Y", 1.9, 1, 1, { hinge: "end", side: "right" }],
    ["hinge at the end, opens to −Y", 1.9, 1, -1, { hinge: "end", side: "left" }],
  ] as const)("finds a door with leaf, arc and jambs, %s, with high confidence", (_name, hinge, other, side, swing) => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]).jambs(1, 1.9).door(hinge, other, side);
    const { candidates } = find(sheet, [horizontal()]);
    expect(candidates).toHaveLength(1);
    const [door] = candidates;
    expect(door).toMatchObject({ kind: "door", source: "face-gap", wallId: "w", confidence: "high", door: swing });
    expect(door.offset).toBeCloseTo(1, 6);
    expect(door.width).toBeCloseTo(0.9, 6);
    expect(door.fill).toBeNull();
    expect(door.reasons.join(" ")).toMatch(/дуга открывания/);
    expect(door.reasons.join(" ")).toMatch(/полотна/);
  });

  it("works the same for a wall at any angle and direction", () => {
    for (const angle of [90, 45, 180, -30]) {
      const start = { x: 3, y: -2 };
      const sheet = new Sheet(start, angle).faces(6, [[2, 2.9]]).jambs(2, 2.9).door(2, 2.9, 1);
      const end = sheet.at(6, 0);
      const { candidates } = find(sheet, [wall("w", start, end)]);
      expect(candidates, `angle ${angle}`).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ kind: "door", confidence: "high", door: { hinge: "start", side: "right" } });
      expect(candidates[0].offset).toBeCloseTo(2, 5);
      expect(candidates[0].width).toBeCloseTo(0.9, 5);
    }
  });

  it("the swing side is relative to the wall direction, so a reversed wall flips it", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]).jambs(1, 1.9).door(1, 1.9, 1);
    const reversed = wall("w", { x: 6, y: 0 }, { x: 0, y: 0 });
    const [door] = find(sheet, [reversed]).candidates;
    // Offset counts from the wall start (x = 6): the opening spans 4.1 … 5.0 along it.
    expect(door.offset).toBeCloseTo(4.1, 6);
    expect(door.door).toEqual({ hinge: "end", side: "left" });
  });

  it("finds a window from two or three glazing lines, and doubts a single one", () => {
    const two = new Sheet({ x: 0, y: 0 }).faces(6, [[2, 3.2]]).jambs(2, 3.2).glazing(2, 3.2, [-0.05, 0.05]);
    expect(find(two, [horizontal()]).candidates[0]).toMatchObject({ kind: "window", confidence: "high" });
    const three = new Sheet({ x: 0, y: 0 }).faces(6, [[2, 3.2]]).glazing(2, 3.2, [-0.06, 0, 0.06]);
    expect(find(three, [horizontal()]).candidates[0]).toMatchObject({ kind: "window", confidence: "high" });
    const one = new Sheet({ x: 0, y: 0 }).faces(6, [[2, 3.2]]).glazing(2, 3.2, [0]);
    const [doubtful] = find(one, [horizontal()]).candidates;
    expect(doubtful).toMatchObject({ kind: "window", confidence: "low" });
    expect(doubtful.reasons.join(" ")).toMatch(/одна линия/);
  });

  it("does not take lines along the faces or outside the wall for glazing", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6, [[2, 3.2]]).glazing(2, 3.2, [0.3]).line(2, 0.05, 2.3, 0.05);
    const [item] = find(sheet, [horizontal()]).candidates;
    // 0.3 is outside the wall and 2…2.3 is too short for the opening: nothing counts as glazing.
    expect(item.confidence).toBe("low");
    expect(item.reasons.join(" ")).toMatch(/тип не определён/);
  });

  it("says plainly when it cannot tell the kind, offers the likelier one by width, and marks it low", () => {
    const narrow = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]);
    const [door] = find(narrow, [horizontal()]).candidates;
    expect(door).toMatchObject({ kind: "door", confidence: "low" });
    expect(door.reasons.join(" ")).toMatch(/Нет ни створки, ни остекления: тип не определён, предположительно дверь/);
    const wide = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 2.6]]);
    expect(find(wide, [horizontal()]).candidates[0]).toMatchObject({ kind: "window", confidence: "low" });
  });

  it("is doubtful about a door that has only an arc, or only a leaf", () => {
    const arcOnly = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]).door(1, 1.9, 1, false, true);
    const [a] = find(arcOnly, [horizontal()]).candidates;
    expect(a).toMatchObject({ kind: "door", confidence: "low", door: { hinge: "start", side: "right" } });
    expect(a.reasons.join(" ")).toMatch(/только по дуге/);
    const leafOnly = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]).door(1, 1.9, -1, true, false);
    const [l] = find(leafOnly, [horizontal()]).candidates;
    expect(l).toMatchObject({ kind: "door", confidence: "low", door: { hinge: "start", side: "left" } });
    expect(l.reasons.join(" ")).toMatch(/нет дуги/);
  });

  it("finds an arc-and-jambs door as high without a leaf", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]).jambs(1, 1.9).door(1, 1.9, 1, false, true);
    expect(find(sheet, [horizontal()]).candidates[0]).toMatchObject({ kind: "door", confidence: "high" });
  });

  it("finds nothing where no opening is drawn", () => {
    expect(find(new Sheet({ x: 0, y: 0 }).faces(6), [horizontal()]).candidates).toEqual([]);
    // Too narrow, too wide, at a wall end, and interrupted on one face only.
    expect(find(new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.3]]), [horizontal()]).candidates).toEqual([]);
    expect(find(new Sheet({ x: 0, y: 0 }).faces(9, [[1, 4.5]]), [horizontal("w", 9)]).candidates).toEqual([]);
    expect(find(new Sheet({ x: 0, y: 0 }).faces(6, [[0, 0.9]]), [horizontal()]).candidates).toEqual([]);
    const oneFace = new Sheet({ x: 0, y: 0 }).line(0, 0.1, 6, 0.1).line(0, -0.1, 1, -0.1).line(1.9, -0.1, 6, -0.1).line(1, 0.1, 1, 0.1);
    const half = new Sheet({ x: 0, y: 0 }).line(0, -0.1, 6, -0.1).line(0, 0.1, 1, 0.1).line(1.9, 0.1, 6, 0.1);
    expect(find(oneFace, [horizontal()]).candidates).toEqual([]);
    expect(find(half, [horizontal()]).candidates).toEqual([]);
  });

  it("finds nothing for a wall the drawing does not show, and ignores furniture arcs", () => {
    const elsewhere = new Sheet({ x: 0, y: 20 }).faces(6, [[1, 1.9]]);
    expect(find(elsewhere, [horizontal()]).candidates).toEqual([]);
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6);
    // A round table far from any wall and a small fillet on a wall.
    sheet.curves.push({ points: Array.from({ length: 9 }, (_, i) => ({ x: 3 + 0.5 * Math.cos((i / 8) * Math.PI / 2), y: 3 + 0.5 * Math.sin((i / 8) * Math.PI / 2) })) });
    sheet.curves.push({ points: Array.from({ length: 9 }, (_, i) => ({ x: 4 + 0.1 * Math.cos((i / 8) * Math.PI / 2), y: 0.1 * Math.sin((i / 8) * Math.PI / 2) })) });
    expect(find(sheet, [horizontal()]).candidates).toEqual([]);
  });

  it("does not offer a stretch that already has an opening, but offers the others", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(8, [[1, 1.9], [4, 5]]).jambs(1, 1.9).jambs(4, 5).door(1, 1.9, 1).door(4, 5, 1);
    const taken: Opening = { id: "o", wallId: "w", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0 };
    const { candidates } = find(sheet, [horizontal("w", 8)], [taken]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].offset).toBeCloseTo(4, 6);
  });

  it("offers one candidate per stretch, in plan order, several per wall", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(9, [[1, 1.9], [4, 5.4]]).jambs(1, 1.9).jambs(4, 5.4).door(1, 1.9, 1).glazing(4, 5.4, [-0.05, 0.05]);
    const { candidates } = find(sheet, [horizontal("w", 9)]);
    expect(candidates.map((item) => item.kind)).toEqual(["door", "window"]);
    expect(candidates.map((item) => Math.round(item.offset * 10) / 10)).toEqual([1, 4]);
  });

  it("treats a door swing over unbroken face lines as low confidence, never high", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6).jambs(1, 1.9).door(1, 1.9, 1);
    const [item] = find(sheet, [horizontal()]).candidates;
    expect(item).toMatchObject({ kind: "door", source: "arc", confidence: "low", door: { hinge: "start", side: "right" } });
    expect(item.offset).toBeCloseTo(1, 6);
    expect(item.width).toBeCloseTo(0.9, 6);
    expect(item.reasons.join(" ")).toMatch(/идут сквозь проём/);
  });

  it("does not take a crossing or a T-junction for an opening", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6, [[2.9, 3.1]]);
    expect(find(sheet, [horizontal()]).candidates).toEqual([]);
    const tee = new Sheet({ x: 0, y: 0 }).line(0, 0.1, 6, 0.1).line(0, -0.1, 2.9, -0.1).line(3.1, -0.1, 6, -0.1);
    expect(find(tee, [horizontal()]).candidates).toEqual([]);
  });
});

describe("openings between two walls on one axis", () => {
  const left = wall("a", { x: 0, y: 0 }, { x: 1, y: 0 });
  const right = wall("b", { x: 1.9, y: 0 }, { x: 5, y: 0 });

  it("offers a wall piece that closes the gap, with the opening in it", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(1).line(1, -0.1, 1, 0.1).door(1, 1.9, 1).line(1.9, -0.1, 1.9, 0.1);
    sheet.line(1.9, 0.1, 5, 0.1).line(1.9, -0.1, 5, -0.1);
    const { candidates } = find(sheet, [left, right]);
    expect(candidates).toHaveLength(1);
    const [item] = candidates;
    expect(item).toMatchObject({ kind: "door", source: "wall-gap", wallId: null, confidence: "high", offset: 0 });
    // The piece joins the neighbours exactly: same end points, so the walls share nodes.
    expect(item.fill).toEqual({ start: { x: 1, y: 0 }, end: { x: 1.9, y: 0 }, thickness: T, height: 2.7 });
    expect(item.width).toBeCloseTo(0.9, 9);
    expect(item.door).toEqual({ hinge: "start", side: "right" });
    expect(item.reasons.join(" ")).toMatch(/на одной оси/);
  });

  it("works for walls listed in the other order, vertical and sloping walls", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).glazing(1, 1.9, [-0.04, 0.04]);
    // Whatever the order of the walls, the piece runs along the first wall's direction.
    expect(find(sheet, [right, left]).candidates[0]).toMatchObject({ kind: "window", source: "wall-gap", fill: { start: { x: 1, y: 0 }, end: { x: 1.9, y: 0 } } });
    for (const angle of [90, 33]) {
      const s = new Sheet({ x: 2, y: 1 }, angle).glazing(1, 1.9, [-0.04, 0.04]);
      const a = wall("a", s.at(0, 0), s.at(1, 0)), b = wall("b", s.at(1.9, 0), s.at(5, 0));
      const [item] = find(s, [a, b]).candidates;
      expect(item, `angle ${angle}`).toMatchObject({ kind: "window", source: "wall-gap" });
      expect(item.width).toBeCloseTo(0.9, 6);
      expect(item.fill!.start).toEqual(a.end);
      expect(item.fill!.end).toEqual(b.start);
    }
  });

  it("is a doubtful candidate when the drawing shows nothing about the kind", () => {
    const [item] = find(new Sheet({ x: 0, y: 0 }), [left, right]).candidates;
    expect(item).toMatchObject({ kind: "door", source: "wall-gap", confidence: "low" });
    expect(item.reasons.join(" ")).toMatch(/тип не определён/);
  });

  it("ignores walls that differ in thickness or axis, gaps of the wrong size and blocked gaps", () => {
    const thick = wall("b", { x: 1.9, y: 0 }, { x: 5, y: 0 }, 0.3);
    expect(find(new Sheet({ x: 0, y: 0 }), [left, thick]).candidates).toEqual([]);
    const shifted = wall("b", { x: 1.9, y: 0.1 }, { x: 5, y: 0.1 });
    expect(find(new Sheet({ x: 0, y: 0 }), [left, shifted]).candidates).toEqual([]);
    const near = wall("b", { x: 1.2, y: 0 }, { x: 5, y: 0 });
    expect(find(new Sheet({ x: 0, y: 0 }), [left, near]).candidates).toEqual([]);
    const far = wall("b", { x: 6, y: 0 }, { x: 9, y: 0 });
    expect(find(new Sheet({ x: 0, y: 0 }), [left, far]).candidates).toEqual([]);
    const crossing = wall("c", { x: 1.45, y: -2 }, { x: 1.45, y: 2 });
    expect(find(new Sheet({ x: 0, y: 0 }), [left, right, crossing]).candidates).toEqual([]);
    const overlapping = wall("b", { x: 0.5, y: 0 }, { x: 5, y: 0 });
    expect(find(new Sheet({ x: 0, y: 0 }), [left, overlapping]).candidates).toEqual([]);
  });

  it("finds each gap along a row of walls and nothing else", () => {
    const row = [wall("a", { x: 0, y: 0 }, { x: 1, y: 0 }), wall("b", { x: 1.9, y: 0 }, { x: 4, y: 0 }), wall("c", { x: 5.2, y: 0 }, { x: 8, y: 0 })];
    const { candidates } = find(new Sheet({ x: 0, y: 0 }), row);
    expect(candidates.map((item) => [item.fill!.start.x, item.fill!.end.x])).toEqual([[1, 1.9], [4, 5.2]]);
  });
});

describe("candidates as plan data", () => {
  it("becomes an opening with the editor's sizes, a door keeping its swing", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(6, [[1, 1.9]]).jambs(1, 1.9).door(1.9, 1, -1);
    const [door] = find(sheet, [horizontal()]).candidates;
    expect(openingFromCandidate(door, "id", "w")).toEqual({
      id: "id", wallId: "w", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0, door: { hinge: "end", side: "left" },
    });
    const windowSheet = new Sheet({ x: 0, y: 0 }).faces(6, [[2, 3.2]]).glazing(2, 3.2, [-0.05, 0.05]);
    const [windowItem] = find(windowSheet, [horizontal()]).candidates;
    const asWindow = openingFromCandidate(windowItem, "w1", "w");
    expect(asWindow).toEqual({ id: "w1", wallId: "w", kind: "window", offset: 2, width: 1.2, height: 1.2, sillHeight: 0.9 });
    expect(asWindow).not.toHaveProperty("door");
    // The user may change the kind of a doubtful candidate: a window then has no swing.
    expect(openingFromCandidate(door, "x", "w", "window")).not.toHaveProperty("door");
    expect(openingFromCandidate(windowItem, "y", "w", "door").door).toEqual({ hinge: "start", side: "left" });
  });

  it("is deterministic, does not change its input, and reports a truncated input", () => {
    const sheet = new Sheet({ x: 0, y: 0 }).faces(9, [[1, 1.9], [4, 5.4]]).jambs(1, 1.9).door(1, 1.9, 1).glazing(4, 5.4, [-0.05, 0.05]);
    const walls = [horizontal("w", 9)];
    const before = JSON.stringify([sheet.segments, sheet.curves, walls]);
    const first = find(sheet, walls), second = find(sheet, walls);
    expect(second).toEqual(first);
    expect(JSON.stringify([sheet.segments, sheet.curves, walls])).toBe(before);
    expect(first.truncated).toBe(false);
    const many = Array.from({ length: MAX_OPENING_INPUT_SEGMENTS + 1 }, (_, i) => ({ start: { x: 50 + i * 0.001, y: 50 }, end: { x: 50 + i * 0.001, y: 51 } }));
    expect(findOpeningCandidates(many, [], walls).truncated).toBe(true);
  });

  it("skips invalid input quietly", () => {
    const bad = [{ start: { x: NaN, y: 0 }, end: { x: 1, y: 1 } }];
    expect(findOpeningCandidates(bad, [{ points: [{ x: 0, y: 0 }] }], [horizontal(), wall("zero", { x: 1, y: 1 }, { x: 1, y: 1 })]).candidates).toEqual([]);
    expect(findOpeningCandidates([], [], []).candidates).toEqual([]);
  });
});
