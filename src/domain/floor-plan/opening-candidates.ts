import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import type { Point } from "@/domain/geometry";
import type { DoorSwing, Opening, Wall } from "./types";
import type { LineSegment } from "./wall-candidates";

/**
 * Door and window candidates from the drawing lines of a vector PDF, for walls that are
 * already in the plan. Nothing here edits a plan and nothing is guessed silently: every
 * candidate lists the evidence it rests on, a candidate with thin evidence is marked
 * `low` ("неуверенно"), and a drawing with no recognisable evidence yields nothing.
 *
 * Three situations are recognised, all in plan metres:
 *  - `face-gap`: both face lines of a plan wall are interrupted over 0.4–3.2 m, with the
 *    wall continuing on both sides;
 *  - `wall-gap`: two collinear plan walls stop short of each other by 0.4–3.2 m (this is
 *    what wall suggestions from a PDF produce at a door). The candidate adds a short wall
 *    piece that closes the gap, so rooms stay closed, and puts the opening in it;
 *  - `arc`: a door swing arc whose centre lies on a plan wall whose face lines run on
 *    through the door.
 * The evidence for the kind of opening inside it is a swing arc and leaf line (door) or
 * two or three thin lines between the faces (window).
 */
export interface CurvePolyline {
  points: Point[];
}

export type OpeningConfidence = "high" | "low";
export type OpeningSource = "face-gap" | "wall-gap" | "arc";

export interface OpeningCandidate {
  kind: "door" | "window";
  source: OpeningSource;
  /** The plan wall that carries the opening; null for `wall-gap`, where `fill` is the host. */
  wallId: string | null;
  /** `wall-gap`: the wall piece to add between two walls. Its opening is at offset 0. */
  fill: { start: Point; end: Point; thickness: number; height: number } | null;
  /** Along the host wall (or the fill piece), from its start. */
  offset: number;
  width: number;
  /** Doors only: from the swing arc when there is one, otherwise the editor's default. */
  door?: DoorSwing;
  confidence: OpeningConfidence;
  /** What the candidate rests on, one short sentence each, in Russian. */
  reasons: string[];
  /** The opening on the wall axis, for drawing. */
  from: Point;
  to: Point;
  thickness: number;
}

export interface OpeningCandidateOptions {
  minWidth: number;
  maxWidth: number;
}

export const DEFAULT_OPENING_CANDIDATE_OPTIONS: OpeningCandidateOptions = { minWidth: 0.4, maxWidth: 3.2 };

export const MAX_OPENING_CANDIDATES = 300;
export const MAX_OPENING_INPUT_SEGMENTS = 20_000;

/** Standard sizes the editor also uses for new openings. */
export const DOOR_SIZE = { height: 2.1, sillHeight: 0 } as const;
export const WINDOW_SIZE = { height: 1.2, sillHeight: 0.9 } as const;

const FACE_ANGLE = Math.tan((1 * Math.PI) / 180);
const GLAZING_ANGLE = Math.tan((2 * Math.PI) / 180);
const PERPENDICULAR_ANGLE = Math.tan((4 * Math.PI) / 180);
/** Pieces of one face line closer than this are one line. */
const GAP_TOLERANCE = 0.02;
const MIN_SEGMENT = 0.05;
/** Walls on one axis: parallel within this angle, axes this close, thicknesses this close. */
const COLLINEAR_OFFSET = 0.03;
const COLLINEAR_THICKNESS = 0.03;
/** How far an opening's jamb or hinge may sit from where the gap or arc says. */
const JAMB_TOLERANCE = 0.05;
const ARC_FIT = 0.04;
const MIN_SWEEP = (60 * Math.PI) / 180;
const MAX_SWEEP = (120 * Math.PI) / 180;
const MIN_DOOR = 0.45;
const MAX_DOOR = 1.4;
const GRID = 1;

interface Frame {
  s: Point;
  u: Point;
  n: Point;
  length: number;
  thickness: number;
}

const local = (frame: Frame, point: Point): Point => ({
  x: (point.x - frame.s.x) * frame.u.x + (point.y - frame.s.y) * frame.u.y,
  y: (point.x - frame.s.x) * frame.n.x + (point.y - frame.s.y) * frame.n.y,
});
const world = (frame: Frame, x: number, y = 0): Point => ({
  x: frame.s.x + frame.u.x * x + frame.n.x * y,
  y: frame.s.y + frame.u.y * x + frame.n.y * y,
});

function frameOf(start: Point, end: Point, thickness: number): Frame | null {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!(length > 0)) return null;
  const u = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  // Same convention as door swings: local +Y is (-uy, ux).
  return { s: start, u, n: { x: -u.y, y: u.x }, length, thickness };
}

/** Uniform grid of segments and curves, to ask for the ones near a wall. */
class Grid<T extends { box: Box }> {
  private cells = new Map<string, T[]>();
  add(item: T) {
    const { minX, minY, maxX, maxY } = item.box;
    for (let x = Math.floor(minX / GRID); x <= Math.floor(maxX / GRID); x++) {
      for (let y = Math.floor(minY / GRID); y <= Math.floor(maxY / GRID); y++) {
        const key = `${x}:${y}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }
  near(box: Box): T[] {
    const found = new Set<T>();
    for (let x = Math.floor(box.minX / GRID); x <= Math.floor(box.maxX / GRID); x++) {
      for (let y = Math.floor(box.minY / GRID); y <= Math.floor(box.maxY / GRID); y++) {
        for (const item of this.cells.get(`${x}:${y}`) ?? []) {
          if (item.box.maxX >= box.minX && item.box.minX <= box.maxX && item.box.maxY >= box.minY && item.box.minY <= box.maxY) found.add(item);
        }
      }
    }
    return [...found];
  }
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
const boxOf = (points: readonly Point[]): Box => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});
const grow = (box: Box, by: number): Box => ({ minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by });

interface SegmentItem {
  box: Box;
  start: Point;
  end: Point;
}
interface CurveItem {
  box: Box;
  points: Point[];
}

type Interval = readonly [number, number];

function merge(intervals: Interval[]): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = result.at(-1);
    if (last && from - last[1] <= GAP_TOLERANCE) last[1] = Math.max(last[1], to);
    else result.push([from, to]);
  }
  return result;
}
function complement(covered: readonly Interval[], from: number, to: number): [number, number][] {
  const gaps: [number, number][] = [];
  let at = from;
  for (const [a, b] of covered) {
    if (b <= at) continue;
    if (a > at) gaps.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
    if (at >= to) break;
  }
  if (at < to) gaps.push([at, to]);
  return gaps.filter(([a, b]) => b - a > 1e-9);
}
function intersect(first: readonly Interval[], second: readonly Interval[]): [number, number][] {
  const result: [number, number][] = [];
  for (const [a, b] of first) {
    for (const [c, d] of second) {
      const from = Math.max(a, c), to = Math.min(b, d);
      if (to - from > 1e-9) result.push([from, to]);
    }
  }
  return result;
}
const covers = (intervals: readonly Interval[], x: number) => intervals.some(([a, b]) => x >= a - 0.03 && x <= b + 0.03);

/** The circle through three points, or null for (nearly) collinear points. */
function circleThrough(a: Point, b: Point, c: Point): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

interface Arc {
  /** Centre in the frame of the wall. */
  x: number;
  y: number;
  r: number;
  /** Local points of the arc. */
  points: Point[];
}

/** A door swing: a curve that is a quarter circle (60°–120°) of door size, in the wall's frame. */
function swingArc(frame: Frame, curve: CurveItem): Arc | null {
  const points = curve.points.map((point) => local(frame, point));
  if (points.length < 5) return null;
  const first = points[0], middle = points[Math.floor(points.length / 2)], last = points.at(-1)!;
  const circle = circleThrough(first, middle, last);
  if (!circle || circle.r < MIN_DOOR || circle.r > MAX_DOOR) return null;
  if (points.some((p) => Math.abs(Math.hypot(p.x - circle.x, p.y - circle.y) - circle.r) > ARC_FIT * circle.r + 0.01)) return null;
  const angle = (p: Point) => Math.atan2(p.y - circle.y, p.x - circle.x);
  let sweep = Math.abs(angle(last) - angle(first));
  if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
  if (sweep < MIN_SWEEP || sweep > MAX_SWEEP) return null;
  return { x: circle.x, y: circle.y, r: circle.r, points };
}

interface Evidence {
  glazing: number;
  jambStart: boolean;
  jambEnd: boolean;
  leaf: { hinge: "start" | "end"; side: "left" | "right" } | null;
  arc: { hinge: "start" | "end"; side: "left" | "right"; r: number } | null;
}

/**
 * What the drawing shows inside the opening `[x0, x1]` of a wall: lines between the faces
 * (glazing), closing lines at its ends (jambs), a leaf line standing out of one jamb and a
 * swing arc around it.
 */
function inspect(frame: Frame, x0: number, x1: number, segments: Grid<SegmentItem>, curves: Grid<CurveItem>): Evidence {
  const t = frame.thickness, width = x1 - x0;
  const reach = width + 0.3;
  const corners = [world(frame, x0 - 0.2, -reach), world(frame, x0 - 0.2, reach), world(frame, x1 + 0.2, -reach), world(frame, x1 + 0.2, reach)];
  const region = boxOf(corners);
  const glazing: number[] = [];
  let jambStart = false, jambEnd = false;
  let leaf: Evidence["leaf"] = null;
  for (const item of segments.near(region)) {
    const a = local(frame, item.start), b = local(frame, item.end);
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    if (Math.hypot(dx, dy) < MIN_SEGMENT) continue;
    if (dy <= dx * GLAZING_ANGLE + 0.005) {
      // Parallel to the wall, strictly between its faces, over most of the opening.
      const y = (a.y + b.y) / 2;
      if (Math.abs(y) > t / 2 - 0.015) continue;
      const covered = Math.min(Math.max(a.x, b.x), x1 + JAMB_TOLERANCE) - Math.max(Math.min(a.x, b.x), x0 - JAMB_TOLERANCE);
      if (covered >= 0.7 * width && !glazing.some((other) => Math.abs(other - y) < 0.02)) glazing.push(y);
    } else if (dx <= dy * PERPENDICULAR_ANGLE + 0.005) {
      const x = (a.x + b.x) / 2;
      const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y);
      const nearStart = Math.abs(x - x0) <= JAMB_TOLERANCE, nearEnd = Math.abs(x - x1) <= JAMB_TOLERANCE;
      // A jamb closes the opening across the wall's thickness.
      if ((nearStart || nearEnd) && low <= -t / 2 * 0.7 && high >= t / 2 * 0.7 && high - low <= t + 0.1) {
        if (nearStart) jambStart = true;
        else jambEnd = true;
      }
      // A leaf stands out of a jamb, about as long as the opening is wide.
      const outer = Math.abs(low) > Math.abs(high) ? low : high;
      const root = Math.abs(low) > Math.abs(high) ? high : low;
      if ((nearStart || nearEnd) && Math.abs(root) <= t / 2 + JAMB_TOLERANCE && Math.abs(Math.abs(outer) - width) <= Math.max(0.12, 0.15 * width)) {
        leaf = { hinge: nearStart ? "start" : "end", side: outer > 0 ? "right" : "left" };
      }
    }
  }
  let arc: Evidence["arc"] = null;
  for (const curve of curves.near(region)) {
    const swing = swingArc(frame, curve);
    if (!swing) continue;
    // Hinge on the wall axis at one jamb, radius about the width of the opening.
    if (Math.abs(swing.y) > t / 2 + 0.06) continue;
    if (Math.abs(swing.r - width) > Math.max(0.12, 0.2 * width)) continue;
    const atStart = Math.abs(swing.x - x0) <= 0.07, atEnd = Math.abs(swing.x - x1) <= 0.07;
    if (atStart === atEnd) continue;
    const meanY = swing.points.reduce((sum, p) => sum + p.y, 0) / swing.points.length;
    if (Math.abs(meanY) < 0.2 * swing.r) continue;
    arc = { hinge: atStart ? "start" : "end", side: meanY > 0 ? "right" : "left", r: swing.r };
    break;
  }
  return { glazing: glazing.length, jambStart, jambEnd, leaf, arc };
}

interface Classified {
  kind: "door" | "window";
  door?: DoorSwing;
  confidence: OpeningConfidence;
  reasons: string[];
}

const widthText = (width: number) => lengthText(Math.round(width * 100) / 100);

function classify(evidence: Evidence, width: number, structure: string): Classified {
  const reasons = [structure];
  const jambs = Number(evidence.jambStart) + Number(evidence.jambEnd);
  if (jambs === 2) reasons.push(tr`Проём закрыт линиями с обоих концов.`);
  else if (jambs === 1) reasons.push(tr`Проём закрыт линией только с одного конца.`);
  if (evidence.arc) {
    const swing: DoorSwing = { hinge: evidence.arc.hinge, side: evidence.arc.side };
    reasons.push(tr`Есть дуга открывания двери радиусом ${widthText(evidence.arc.r)}.`);
    if (evidence.leaf && evidence.leaf.hinge === evidence.arc.hinge && evidence.leaf.side === evidence.arc.side) {
      reasons.push(tr`Есть линия полотна двери.`);
      return { kind: "door", door: swing, confidence: "high", reasons };
    }
    if (jambs > 0) return { kind: "door", door: swing, confidence: "high", reasons };
    reasons.push(tr`Нет ни линии полотна, ни линий по краям проёма: вывод только по дуге.`);
    return { kind: "door", door: swing, confidence: "low", reasons };
  }
  if (evidence.leaf) {
    reasons.push(tr`Есть линия полотна двери, но нет дуги открывания.`);
    return { kind: "door", door: { hinge: evidence.leaf.hinge, side: evidence.leaf.side }, confidence: "low", reasons };
  }
  if (evidence.glazing >= 2) {
    reasons.push(tr`Между гранями стены ${evidence.glazing} тонкие линии остекления.`);
    return { kind: "window", confidence: "high", reasons };
  }
  if (evidence.glazing === 1) {
    reasons.push(tr`Между гранями стены одна линия: возможно, подоконник или остекление.`);
    return { kind: "window", confidence: "low", reasons };
  }
  // No evidence about the kind: say so, and fall back to the likelier one by size.
  const kind = width <= 1.3 ? "door" : "window";
  reasons.push(tr`Нет ни створки, ни остекления: тип не определён, предположительно ${kind === "door" ? tr`дверь` : tr`окно`} по ширине. Проверьте и при необходимости смените тип.`);
  return { kind, confidence: "low", reasons };
}

const DEFAULT_SWING: DoorSwing = { hinge: "start", side: "left" };

export interface OpeningCandidateResult {
  candidates: OpeningCandidate[];
  /** The input or the result exceeded a limit; the result covers only part of the drawing. */
  truncated: boolean;
}

/**
 * @param segments  straight drawing lines in plan metres
 * @param curves    curve chains in plan metres
 * @param walls     the plan's walls: the only places an opening can be offered
 * @param openings  openings the plan already has; a stretch that holds one is skipped
 */
export function findOpeningCandidates(
  segments: readonly LineSegment[],
  curves: readonly CurvePolyline[],
  walls: readonly Wall[],
  openings: readonly Opening[] = [],
  options: OpeningCandidateOptions = DEFAULT_OPENING_CANDIDATE_OPTIONS,
): OpeningCandidateResult {
  let truncated = segments.length > MAX_OPENING_INPUT_SEGMENTS;
  const segmentGrid = new Grid<SegmentItem>();
  for (const segment of segments.slice(0, MAX_OPENING_INPUT_SEGMENTS)) {
    const points = [segment.start, segment.end];
    if (points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) segmentGrid.add({ box: boxOf(points), ...segment });
  }
  const curveGrid = new Grid<CurveItem>();
  for (const curve of curves.slice(0, MAX_OPENING_INPUT_SEGMENTS)) {
    if (curve.points.length >= 5 && curve.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      curveGrid.add({ box: boxOf(curve.points), points: curve.points });
    }
  }
  const found: OpeningCandidate[] = [];
  const { minWidth, maxWidth } = options;
  const taken = (wall: Wall, from: number, to: number) =>
    openings.some((item) => item.wallId === wall.id && item.offset < to - 1e-6 && item.offset + item.width > from + 1e-6);

  // 1. Openings in the walls of the plan: gaps in both face lines, and door swings over walls.
  for (const wall of walls) {
    const frame = frameOf(wall.start, wall.end, wall.thickness);
    if (!frame) continue;
    const t = wall.thickness;
    const faceTolerance = Math.max(0.02, 0.15 * t);
    const sides: [Interval[], Interval[]] = [[], []];
    const nearWall = segmentGrid.near(grow(boxOf([wall.start, wall.end]), t + 0.1));
    for (const item of nearWall) {
      const a = local(frame, item.start), b = local(frame, item.end);
      const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
      if (dx < MIN_SEGMENT || dy > dx * FACE_ANGLE + 0.005) continue;
      const y = (a.y + b.y) / 2;
      const side: 0 | 1 | null = Math.abs(y - t / 2) <= faceTolerance ? 1 : Math.abs(y + t / 2) <= faceTolerance ? 0 : null;
      if (side === null) continue;
      const from = Math.max(0, Math.min(a.x, b.x)), to = Math.min(frame.length, Math.max(a.x, b.x));
      if (to > from) sides[side].push([from, to]);
    }
    const plus = merge(sides[1]), minus = merge(sides[0]);
    const covered = (list: readonly Interval[]) => list.reduce((sum, [a, b]) => sum + (b - a), 0);
    const hasFaces = covered(plus) >= 0.4 * frame.length && covered(minus) >= 0.4 * frame.length;
    const gaps: [number, number][] = [];
    if (hasFaces) {
      for (const [x0, x1] of intersect(complement(plus, 0, frame.length), complement(minus, 0, frame.length))) {
        const width = x1 - x0;
        if (width < minWidth || width > maxWidth) continue;
        // The wall must go on at both ends of the gap; a gap at a wall end is just the end.
        if (x0 < 0.05 || x1 > frame.length - 0.05) continue;
        if (!(covers(plus, x0 - 0.05) || covers(minus, x0 - 0.05)) || !(covers(plus, x1 + 0.05) || covers(minus, x1 + 0.05))) continue;
        if (taken(wall, x0, x1)) continue;
        gaps.push([x0, x1]);
        const evidence = inspect(frame, x0, x1, segmentGrid, curveGrid);
        const result = classify(evidence, width, tr`Обе линии граней стены прерываются на этом участке.`);
        found.push(candidate(result, "face-gap", wall.id, null, frame, x0, width, t));
      }
    }
    // A door swing over a wall whose face lines run on through it.
    for (const curve of curveGrid.near(grow(boxOf([wall.start, wall.end]), MAX_DOOR + t))) {
      const swing = swingArc(frame, curve);
      if (!swing || Math.abs(swing.y) > t / 2 + 0.06 || swing.x < -0.05 || swing.x > frame.length + 0.05) continue;
      const meanY = swing.points.reduce((sum, p) => sum + p.y, 0) / swing.points.length;
      if (Math.abs(meanY) < 0.2 * swing.r) continue;
      const farX = swing.points.reduce((far, p) => (Math.abs(p.x - swing.x) > Math.abs(far - swing.x) ? p.x : far), swing.x);
      const x0 = farX >= swing.x ? swing.x : swing.x - swing.r;
      const width = swing.r;
      if (x0 < -0.05 || x0 + width > frame.length + 0.05 || width < minWidth || width > maxWidth) continue;
      if (gaps.some(([a, b]) => x0 < b - 0.05 && x0 + width > a + 0.05) || taken(wall, x0, x0 + width)) continue;
      if (found.some((item) => item.wallId === wall.id && item.offset < x0 + width - 0.05 && item.offset + item.width > x0 + 0.05)) continue;
      const evidence = inspect(frame, Math.max(0, x0), Math.min(frame.length, x0 + width), segmentGrid, curveGrid);
      const result = classify(evidence, width, tr`Линии граней стены идут сквозь проём: границы проёма определены только по дуге двери.`);
      // Without a gap in the faces the opening itself is not drawn; never "high".
      found.push(candidate({ ...result, confidence: "low" }, "arc", wall.id, null, frame, Math.max(0, x0), Math.min(width, frame.length - Math.max(0, x0)), t));
    }
  }

  // 2. Two collinear walls that stop short of each other: the gap is the opening.
  const lines = walls.map((wall) => ({ wall, frame: frameOf(wall.start, wall.end, wall.thickness) })).filter((item): item is { wall: Wall; frame: Frame } => item.frame !== null);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const cross = Math.abs(a.frame.u.x * b.frame.u.y - a.frame.u.y * b.frame.u.x);
      if (cross > FACE_ANGLE || Math.abs(a.wall.thickness - b.wall.thickness) > COLLINEAR_THICKNESS) continue;
      const bStart = local(a.frame, b.wall.start), bEnd = local(a.frame, b.wall.end);
      if (Math.abs(bStart.y) > COLLINEAR_OFFSET || Math.abs(bEnd.y) > COLLINEAR_OFFSET) continue;
      const aFrom = 0, aTo = a.frame.length;
      const bFrom = Math.min(bStart.x, bEnd.x), bTo = Math.max(bStart.x, bEnd.x);
      // `first` ends where the gap starts, `second` starts where it ends, along a's direction.
      const forward = bFrom >= aTo;
      const backward = bTo <= aFrom;
      if (!forward && !backward) continue;
      const gapFrom = forward ? aTo : bTo, gapTo = forward ? bFrom : aFrom;
      const width = gapTo - gapFrom;
      if (width < minWidth || width > maxWidth) continue;
      const mid = (gapFrom + gapTo) / 2;
      // Nothing may stand in the gap: no other collinear wall, no wall crossing it.
      const blocked = walls.some((other) => {
        if (other === a.wall || other === b.wall) return false;
        const o = frameOf(other.start, other.end, other.thickness);
        if (!o) return false;
        const p = local(o, world(a.frame, mid));
        const distance = p.x < 0 ? Math.hypot(p.x, p.y) : p.x > o.length ? Math.hypot(p.x - o.length, p.y) : Math.abs(p.y);
        return distance <= other.thickness / 2 + 0.05;
      });
      if (blocked) continue;
      // The piece uses the neighbours' own end points, so it shares their nodes exactly.
      const bNear = bStart.x <= bEnd.x === forward ? b.wall.start : b.wall.end;
      const fill = {
        start: forward ? a.wall.end : bNear,
        end: forward ? bNear : a.wall.start,
        thickness: (a.wall.thickness + b.wall.thickness) / 2,
        height: Math.min(a.wall.height, b.wall.height),
      };
      const fillFrame = frameOf(fill.start, fill.end, fill.thickness);
      if (!fillFrame) continue;
      const evidence = inspect(fillFrame, 0, fillFrame.length, segmentGrid, curveGrid);
      const result = classify(evidence, width, tr`Две стены лежат на одной оси, между ними ${widthText(width)} без стены.`);
      found.push({ ...candidate(result, "wall-gap", null, fill, fillFrame, 0, fillFrame.length, fill.thickness) });
    }
  }

  // Deterministic order: by wall (plan order), then position; one candidate per stretch.
  const order = new Map(walls.map((wall, index) => [wall.id, index]));
  found.sort((x, y) => {
    const ax = x.wallId === null ? Infinity : order.get(x.wallId)!;
    const ay = y.wallId === null ? Infinity : order.get(y.wallId)!;
    return ax - ay || x.from.x - y.from.x || x.from.y - y.from.y || x.offset - y.offset;
  });
  const result: OpeningCandidate[] = [];
  for (const item of found) {
    const clash = result.some((other) => other.wallId === item.wallId && other.wallId !== null && other.offset < item.offset + item.width - 0.05 && other.offset + other.width > item.offset + 0.05);
    if (!clash) result.push(item);
  }
  if (result.length > MAX_OPENING_CANDIDATES) truncated = true;
  return { candidates: result.slice(0, MAX_OPENING_CANDIDATES), truncated };
}

function candidate(
  result: Classified,
  source: OpeningSource,
  wallId: string | null,
  fill: OpeningCandidate["fill"],
  frame: Frame,
  offset: number,
  width: number,
  thickness: number,
): OpeningCandidate {
  return {
    kind: result.kind,
    source,
    wallId,
    fill,
    offset,
    width,
    ...(result.kind === "door" ? { door: result.door ?? { ...DEFAULT_SWING } } : {}),
    confidence: result.confidence,
    reasons: result.reasons,
    from: world(frame, offset),
    to: world(frame, offset + width),
    thickness,
  };
}

/** The opening the candidate becomes in the plan. `wallId` is the host, or the id of the added fill wall. */
export function openingFromCandidate(candidateValue: OpeningCandidate, id: string, wallId: string, kind = candidateValue.kind): Opening {
  const size = kind === "door" ? DOOR_SIZE : WINDOW_SIZE;
  return {
    id,
    wallId,
    kind,
    offset: Math.round(candidateValue.offset * 1000) / 1000,
    width: Math.round(candidateValue.width * 1000) / 1000,
    height: size.height,
    sillHeight: size.sillHeight,
    ...(kind === "door" ? { door: { ...(candidateValue.door ?? DEFAULT_SWING) } } : {}),
  };
}
