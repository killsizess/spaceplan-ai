import type { Point } from "@/domain/geometry";
import type { Wall } from "./types";

/**
 * Wall candidates from drawing lines (vector PDF). Architectural plans draw a wall as
 * two parallel face lines; a pair of long parallel lines at a wall-like distance
 * becomes one candidate on their centre line, with the distance as its thickness.
 * Candidates are suggestions for the user to accept or dismiss — nothing here edits a
 * plan, and lines that do not form such pairs (single-line drawings, text, furniture)
 * produce no candidates.
 */
export interface LineSegment {
  start: Point;
  end: Point;
}

export interface WallCandidate {
  start: Point;
  end: Point;
  thickness: number;
}

export interface WallCandidateOptions {
  /** Thinnest wall to look for, metres. */
  minThickness: number;
  /** Thickest wall to look for, metres. */
  maxThickness: number;
  /** Shortest candidate, metres. */
  minLength: number;
}

export const DEFAULT_WALL_CANDIDATE_OPTIONS: WallCandidateOptions = {
  minThickness: 0.05,
  maxThickness: 0.6,
  minLength: 0.3,
};

export const MAX_CANDIDATE_SEGMENTS = 20_000;
export const MAX_WALL_CANDIDATES = 300;

/** Lines within this angle are parallel; near-axis lines snap to the axis. */
const ANGLE_TOLERANCE = (0.5 * Math.PI) / 180;
const PAIR_ANGLE_TOLERANCE = (1 * Math.PI) / 180;
/** Collinear pieces closer than this across the line merge into one line. */
const OFFSET_TOLERANCE = 0.01;
/** Collinear pieces with a gap up to this along the line merge into one line. */
const GAP_TOLERANCE = 0.02;
/** Pieces shorter than this are ignored (hatching dots, arrow heads, glyph-like marks). */
const MIN_SEGMENT_LENGTH = 0.05;
/** A line with this many parallel neighbours over most of its length is a pattern. */
const PATTERN_NEIGHBOURS = 3;
/** Joints connect walls meeting at no less than this angle. */
const MIN_JOINT_ANGLE = (30 * Math.PI) / 180;

/** An infinite line `n·p = offset` with direction `u = (cos θ, sin θ)`, θ ∈ [0, π). */
interface Line {
  angle: number;
  offset: number;
  from: number;
  to: number;
}

/** Exact values on the axes: Math.cos(π/2) is 6e-17, which would leak into coordinates. */
const cos = (angle: number) => (angle === 0 ? 1 : angle === Math.PI / 2 ? 0 : Math.cos(angle));
const sin = (angle: number) => (angle === 0 ? 0 : angle === Math.PI / 2 ? 1 : Math.sin(angle));
const direction = (angle: number): Point => ({ x: cos(angle), y: sin(angle) });
const normal = (angle: number): Point => ({ x: -sin(angle), y: cos(angle) });
const along = (angle: number, point: Point) => point.x * cos(angle) + point.y * sin(angle);
const across = (angle: number, point: Point) => -point.x * sin(angle) + point.y * cos(angle);
const pointOn = (angle: number, offset: number, t: number): Point => {
  const u = direction(angle), n = normal(angle);
  return { x: u.x * t + n.x * offset + 0, y: u.y * t + n.y * offset + 0 };
};

/** Exact axis angles keep axis-aligned drawings exactly axis-aligned. */
function snapAngle(angle: number): number {
  if (angle < ANGLE_TOLERANCE || Math.PI - angle < ANGLE_TOLERANCE) return 0;
  if (Math.abs(angle - Math.PI / 2) < ANGLE_TOLERANCE) return Math.PI / 2;
  return angle;
}

function lineAngle(segment: LineSegment): number | null {
  const { start, end } = segment;
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const dx = end.x - start.x, dy = end.y - start.y;
  if (Math.hypot(dx, dy) < MIN_SEGMENT_LENGTH) return null;
  let angle = Math.atan2(dy, dx);
  if (angle < 0) angle += Math.PI;
  if (angle >= Math.PI) angle -= Math.PI;
  return snapAngle(angle);
}

/** The segment as a line at the given angle (offset averaged over both ends). */
function lineAt(segment: LineSegment, angle: number): Line {
  const { start, end } = segment;
  const a = along(angle, start), b = along(angle, end);
  return { angle, offset: (across(angle, start) + across(angle, end)) / 2, from: Math.min(a, b), to: Math.max(a, b) };
}

function toLine(segment: LineSegment): Line | null {
  const angle = lineAngle(segment);
  return angle === null ? null : lineAt(segment, angle);
}

/**
 * Clusters sorted values whose consecutive gaps stay within `tolerance`; a cluster
 * never spans more than `maxSpan`, so finely segmented arcs do not chain into one.
 */
function clusters<T>(items: readonly T[], value: (item: T) => number, tolerance: number, maxSpan = Infinity): T[][] {
  const sorted = [...items].sort((a, b) => value(a) - value(b));
  const result: T[][] = [];
  for (const item of sorted) {
    const last = result.at(-1);
    if (last && value(item) - value(last[last.length - 1]) <= tolerance && value(item) - value(last[0]) <= maxSpan) last.push(item);
    else result.push([item]);
  }
  return result;
}

/**
 * Collinear pieces (dashes, segments split at junctions) become continuous lines.
 * Every line of one direction cluster gets the same angle, so offsets of parallel
 * lines are directly comparable anywhere on the sheet.
 */
function mergeCollinear(segments: readonly LineSegment[]): Line[] {
  const merged: Line[] = [];
  const angled = segments.flatMap((segment) => {
    const angle = lineAngle(segment);
    return angle === null ? [] : [{ segment, angle }];
  });
  for (const byAngle of clusters(angled, (item) => item.angle, ANGLE_TOLERANCE, 2 * ANGLE_TOLERANCE)) {
    const angle = snapAngle(byAngle.reduce((sum, item) => sum + item.angle, 0) / byAngle.length);
    const lines = byAngle.map((item) => lineAt(item.segment, angle));
    for (const group of clusters(lines, (line) => line.offset, OFFSET_TOLERANCE, 2 * OFFSET_TOLERANCE)) {
      const offset = group.reduce((sum, line) => sum + line.offset, 0) / group.length;
      const intervals = group.map((line) => [line.from, line.to] as const).sort((a, b) => a[0] - b[0]);
      let [from, to] = intervals[0];
      for (const [start, end] of intervals.slice(1)) {
        if (start - to <= GAP_TOLERANCE) to = Math.max(to, end);
        else {
          merged.push({ angle, offset, from, to });
          [from, to] = [start, end];
        }
      }
      merged.push({ angle, offset, from, to });
    }
  }
  return merged;
}

const overlap = (a: Line, b: Line) => Math.min(a.to, b.to) - Math.max(a.from, b.from);
const angleGap = (a: number, b: number) => {
  const gap = Math.abs(a - b);
  return Math.min(gap, Math.PI - gap);
};

/** Free parts of `[from, to]` after removing the used intervals. */
function freeParts(from: number, to: number, used: readonly (readonly [number, number])[]): [number, number][] {
  let parts: [number, number][] = [[from, to]];
  for (const [start, end] of used) {
    parts = parts.flatMap(([a, b]): [number, number][] => {
      if (end <= a || start >= b) return [[a, b]];
      return [...(start > a ? [[a, start] as [number, number]] : []), ...(end < b ? [[end, b] as [number, number]] : [])];
    });
  }
  return parts;
}

interface Placed extends WallCandidate {
  angle: number;
  offset: number;
}

/** Intersection of two placed lines, computed in a fixed order so equal inputs give equal bits. */
function intersection(first: Placed, second: Placed): Point | null {
  const [a, b] = first.angle < second.angle || (first.angle === second.angle && first.offset <= second.offset)
    ? [first, second]
    : [second, first];
  const na = normal(a.angle), nb = normal(b.angle);
  const determinant = na.x * nb.y - na.y * nb.x;
  if (Math.abs(determinant) < 1e-12) return null;
  return {
    x: (a.offset * nb.y - b.offset * na.y) / determinant + 0,
    y: (na.x * b.offset - nb.x * a.offset) / determinant + 0,
  };
}

/**
 * Pairing stops face lines at the faces of the walls they meet, so centre lines end
 * short of each other. Each end moves to the centre-line intersection with the
 * nearest crossing candidate, giving shared corner nodes and T-contacts.
 */
function joinEnds(candidates: Placed[]): Placed[] {
  const moved = candidates.map((candidate, index) => {
    const ends = (["start", "end"] as const).map((key) => {
      const point = candidate[key];
      let best: { point: Point; distance: number } | null = null;
      candidates.forEach((other, otherIndex) => {
        if (otherIndex === index || angleGap(candidate.angle, other.angle) < MIN_JOINT_ANGLE) return;
        const cross = intersection(candidate, other);
        if (!cross) return;
        const distance = Math.hypot(cross.x - point.x, cross.y - point.y);
        if (distance > Math.max(candidate.thickness, other.thickness) + 0.05) return;
        // The joint must lie on the other wall, allowing for this wall's half thickness.
        const t = along(other.angle, cross);
        const a = along(other.angle, other.start), b = along(other.angle, other.end);
        const reach = candidate.thickness / 2 + 0.05;
        if (t < Math.min(a, b) - reach || t > Math.max(a, b) + reach) return;
        if (!best || distance < best.distance) best = { point: cross, distance };
      });
      return (best as { point: Point } | null)?.point ?? point;
    });
    return { ...candidate, start: ends[0], end: ends[1] };
  });
  return moved;
}

function coversExisting(candidate: Placed, walls: readonly Wall[]): boolean {
  const length = Math.hypot(candidate.end.x - candidate.start.x, candidate.end.y - candidate.start.y);
  return walls.some((wall) => {
    const line = toLine(wall);
    if (!line || angleGap(line.angle, candidate.angle) > PAIR_ANGLE_TOLERANCE) return false;
    const reference = line.angle;
    const distance = Math.abs(across(reference, candidate.start) - line.offset) + Math.abs(across(reference, candidate.end) - line.offset);
    if (distance / 2 > Math.max(wall.thickness, candidate.thickness) / 2) return false;
    const a = along(reference, candidate.start), b = along(reference, candidate.end);
    const shared = Math.min(Math.max(a, b), line.to) - Math.max(Math.min(a, b), line.from);
    return shared >= length / 2;
  });
}

export interface WallCandidateResult {
  candidates: WallCandidate[];
  /** Input or output exceeded the limits; the result covers only part of the drawing. */
  truncated: boolean;
}

export function findWallCandidates(
  segments: readonly LineSegment[],
  existing: readonly Wall[] = [],
  options: WallCandidateOptions = DEFAULT_WALL_CANDIDATE_OPTIONS,
): WallCandidateResult {
  const { minThickness, maxThickness, minLength } = options;
  let truncated = segments.length > MAX_CANDIDATE_SEGMENTS;
  const lines = mergeCollinear(segments.slice(0, MAX_CANDIDATE_SEGMENTS));

  // Parallel neighbours within wall distance, per line. Lines of one direction share
  // an exact angle, so sorting by (angle, offset) lets each scan stop early.
  const sorted = [...lines].sort((a, b) => a.angle - b.angle || a.offset - b.offset);
  const neighbours = new Map<Line, { line: Line; distance: number }[]>(sorted.map((line) => [line, []]));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      if (b.angle !== a.angle) break;
      const distance = b.offset - a.offset;
      if (distance > maxThickness) break;
      if (overlap(a, b) <= 0) continue;
      neighbours.get(a)!.push({ line: b, distance });
      neighbours.get(b)!.push({ line: a, distance });
    }
  }
  // Hatching and glazing lines run between many parallels; wall faces do not.
  const pattern = (line: Line) =>
    neighbours.get(line)!.filter(({ line: other }) => overlap(line, other) >= (line.to - line.from) / 2).length >= PATTERN_NEIGHBOURS;

  const pairs: { a: Line; b: Line; distance: number }[] = [];
  for (const line of sorted) {
    if (pattern(line)) continue;
    for (const { line: other, distance } of neighbours.get(line)!) {
      if (other.offset <= line.offset || pattern(other)) continue;
      if (distance >= minThickness && overlap(line, other) >= minLength) pairs.push({ a: line, b: other, distance });
    }
  }
  pairs.sort((first, second) => first.distance - second.distance || overlap(second.a, second.b) - overlap(first.a, first.b));

  // Closest pairs first; each stretch of a face line belongs to one wall.
  const used = new Map<Line, [number, number][]>();
  const placed: Placed[] = [];
  for (const { a, b, distance } of pairs) {
    const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to);
    let parts = freeParts(from, to, used.get(a) ?? []);
    parts = parts.flatMap(([start, end]) => freeParts(start, end, used.get(b) ?? []));
    const angle = a.angle;
    const offset = (a.offset + b.offset) / 2;
    const thickness = Math.round(distance * 1000) / 1000;
    for (const [start, end] of parts) {
      if (end - start < Math.max(minLength, thickness * 1.5)) continue;
      placed.push({ angle, offset, thickness, start: pointOn(angle, offset, start), end: pointOn(angle, offset, end) });
      used.set(a, [...(used.get(a) ?? []), [start, end]]);
      used.set(b, [...(used.get(b) ?? []), [start, end]]);
    }
  }

  const joined = joinEnds(placed).filter((candidate) => !coversExisting(candidate, existing));
  if (joined.length > MAX_WALL_CANDIDATES) truncated = true;
  return {
    candidates: joined.slice(0, MAX_WALL_CANDIDATES).map(({ start, end, thickness }) => ({ start, end, thickness })),
    truncated,
  };
}
