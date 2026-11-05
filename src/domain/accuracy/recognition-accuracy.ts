import { untranslated } from "@/lib/i18n";
import type { Point } from "@/domain/geometry";

/**
 * How well a drawing was read: what recognition proposed against what a person confirmed.
 * Walls are compared by length, not by count: one wall in the drawing may come out as two
 * pieces, or two as one, and either way the same metres are found or missed. Openings are
 * compared one to one, doors and windows apart. Areas are compared with the ones a
 * document states. Every number is computed here; nothing is estimated.
 */
export interface WallLike {
  start: Point;
  end: Point;
  thickness: number;
}

export interface OpeningLike {
  kind: "door" | "window";
  center: Point;
  width: number;
}

export interface AccuracyOptions {
  /** Two walls lie on one axis when they are this close, in metres. */
  axisTolerance: number;
  /** And this parallel, in degrees. */
  angleTolerance: number;
  /** An opening is the same one when its centre is this close, in metres. */
  openingTolerance: number;
  /** A confirmed wall counts as found when this share of its length is covered. */
  foundShare: number;
}

export const DEFAULT_ACCURACY_OPTIONS: AccuracyOptions = {
  axisTolerance: 0.1,
  angleTolerance: 5,
  openingTolerance: 0.3,
  foundShare: 0.8,
};

export interface WallAccuracy {
  /** Metres of confirmed walls, and of proposed walls. */
  truthLength: number;
  foundLength: number;
  /** Share of confirmed length that recognition proposed: what it found. */
  lengthRecall: number | null;
  /** Share of proposed length that is a confirmed wall: how much of it was right. */
  lengthPrecision: number | null;
  truthCount: number;
  foundCount: number;
  /** Confirmed walls covered for at least `foundShare` of their length. */
  wallsFound: number;
  /** Proposed walls with no confirmed wall along at least a fifth of them. */
  wallsExtra: number;
  /** Mean thickness difference over matched walls, in metres. */
  thicknessError: number | null;
}

export interface OpeningAccuracy {
  kind: "door" | "window";
  truthCount: number;
  foundCount: number;
  matched: number;
  /** Found in the right place but taken for the other kind. */
  wrongKind: number;
  recall: number | null;
  precision: number | null;
  /** Mean width difference over matched openings, in metres. */
  widthError: number | null;
}

export interface AreaComparison {
  name: string;
  documented: number;
  measured: number | null;
  /** measured − documented, as a share of documented. */
  share: number | null;
}

export interface AreaAccuracy {
  rooms: AreaComparison[];
  /** Mean of |share| over rooms that were measured. */
  meanAbsoluteShare: number | null;
  worstShare: number | null;
  /** Documented rooms with no room of that name on the plan. */
  missing: string[];
}

const length = (wall: WallLike) => Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** Length of `wall` that walls of `others` lie along, within the tolerances. */
function coveredLength(wall: WallLike, others: readonly WallLike[], options: AccuracyOptions): number {
  const total = length(wall);
  if (total <= 0) return 0;
  const ux = (wall.end.x - wall.start.x) / total, uy = (wall.end.y - wall.start.y) / total;
  const along = (point: Point) => (point.x - wall.start.x) * ux + (point.y - wall.start.y) * uy;
  const across = (point: Point) => Math.abs((point.x - wall.start.x) * -uy + (point.y - wall.start.y) * ux);
  const maxSine = Math.sin((options.angleTolerance * Math.PI) / 180);
  const spans: [number, number][] = [];
  for (const other of others) {
    const otherLength = length(other);
    if (otherLength <= 0) continue;
    const sine = Math.abs(((other.end.x - other.start.x) * uy - (other.end.y - other.start.y) * ux) / otherLength);
    if (sine > maxSine) continue;
    if (across(other.start) > options.axisTolerance || across(other.end) > options.axisTolerance) continue;
    const from = Math.max(0, Math.min(along(other.start), along(other.end)));
    const to = Math.min(total, Math.max(along(other.start), along(other.end)));
    if (to > from) spans.push([from, to]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0, reach = 0;
  for (const [from, to] of spans) {
    const start = Math.max(from, reach);
    if (to > start) covered += to - start;
    reach = Math.max(reach, to);
  }
  return covered;
}

export function measureWalls(
  found: readonly WallLike[],
  truth: readonly WallLike[],
  options: AccuracyOptions = DEFAULT_ACCURACY_OPTIONS,
): WallAccuracy {
  const truthLength = truth.reduce((sum, wall) => sum + length(wall), 0);
  const foundLength = found.reduce((sum, wall) => sum + length(wall), 0);
  const truthCovered = truth.map((wall) => coveredLength(wall, found, options));
  const foundCovered = found.map((wall) => coveredLength(wall, truth, options));
  const thicknessErrors: number[] = [];
  truth.forEach((wall, index) => {
    if (truthCovered[index] < length(wall) * options.foundShare) return;
    // The proposed piece that covers this wall most stands for it.
    const best = found
      .map((candidate) => ({ candidate, cover: coveredLength(wall, [candidate], options) }))
      .sort((a, b) => b.cover - a.cover)[0];
    if (best && best.cover > 0) thicknessErrors.push(Math.abs(best.candidate.thickness - wall.thickness));
  });
  return {
    truthLength,
    foundLength,
    lengthRecall: ratio(truthCovered.reduce((sum, value) => sum + value, 0), truthLength),
    lengthPrecision: ratio(foundCovered.reduce((sum, value) => sum + value, 0), foundLength),
    truthCount: truth.length,
    foundCount: found.length,
    wallsFound: truth.filter((wall, index) => truthCovered[index] >= length(wall) * options.foundShare).length,
    wallsExtra: found.filter((wall, index) => foundCovered[index] < length(wall) * 0.2).length,
    thicknessError: thicknessErrors.length ? thicknessErrors.reduce((sum, value) => sum + value, 0) / thicknessErrors.length : null,
  };
}

export function measureOpenings(
  found: readonly OpeningLike[],
  truth: readonly OpeningLike[],
  kind: "door" | "window",
  options: AccuracyOptions = DEFAULT_ACCURACY_OPTIONS,
): OpeningAccuracy {
  const distance = (a: OpeningLike, b: OpeningLike) => Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
  const truthOfKind = truth.filter((item) => item.kind === kind);
  const foundOfKind = found.filter((item) => item.kind === kind);
  // Closest pairs first, each opening used once.
  const pairs = truthOfKind.flatMap((real) => foundOfKind.map((guess) => ({ real, guess, gap: distance(real, guess) })))
    .filter((pair) => pair.gap <= options.openingTolerance)
    .sort((a, b) => a.gap - b.gap);
  const usedReal = new Set<OpeningLike>(), usedGuess = new Set<OpeningLike>();
  const widthErrors: number[] = [];
  for (const { real, guess } of pairs) {
    if (usedReal.has(real) || usedGuess.has(guess)) continue;
    usedReal.add(real);
    usedGuess.add(guess);
    widthErrors.push(Math.abs(real.width - guess.width));
  }
  const otherKind = found.filter((item) => item.kind !== kind);
  const wrongKind = truthOfKind.filter((real) => !usedReal.has(real) && otherKind.some((guess) => distance(real, guess) <= options.openingTolerance)).length;
  return {
    kind,
    truthCount: truthOfKind.length,
    foundCount: foundOfKind.length,
    matched: usedReal.size,
    wrongKind,
    recall: ratio(usedReal.size, truthOfKind.length),
    precision: ratio(usedGuess.size, foundOfKind.length),
    widthError: widthErrors.length ? widthErrors.reduce((sum, value) => sum + value, 0) / widthErrors.length : null,
  };
}

const normalName = (name: string) => name.trim().toLowerCase().replace(/ё/g, untranslated("е")).replace(/\s+/g, " ");

/** Areas the app computes for named rooms, against the ones a document states for them. */
export function measureAreas(
  measured: readonly { name: string; area: number }[],
  documented: readonly { name: string; area: number }[],
): AreaAccuracy {
  const rooms = documented.map((item): AreaComparison => {
    const match = measured.find((room) => normalName(room.name) === normalName(item.name));
    return {
      name: item.name,
      documented: item.area,
      measured: match ? match.area : null,
      share: match && item.area > 0 ? (match.area - item.area) / item.area : null,
    };
  });
  const shares = rooms.flatMap((room) => (room.share === null ? [] : [Math.abs(room.share)]));
  return {
    rooms,
    meanAbsoluteShare: shares.length ? shares.reduce((sum, value) => sum + value, 0) / shares.length : null,
    worstShare: shares.length ? Math.max(...shares) : null,
    missing: rooms.filter((room) => room.measured === null).map((room) => room.name),
  };
}

/** Where an opening sits on the plan: the middle of it on its wall's axis. */
export function openingCenter(wall: WallLike, offset: number, width: number): Point {
  const total = length(wall) || 1;
  const along = offset + width / 2;
  return {
    x: wall.start.x + ((wall.end.x - wall.start.x) / total) * along,
    y: wall.start.y + ((wall.end.y - wall.start.y) / total) * along,
  };
}
