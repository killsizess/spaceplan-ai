import { deleteObject, addWallsAndOpenings } from "@/domain/floor-plan/construction";
import { analyzeDoorWallCollisions } from "@/domain/floor-plan/door-collisions";
import { analyzeDoorPairCollisions } from "@/domain/floor-plan/door-pair-collisions";
import { offsetWall } from "@/domain/floor-plan/move-wall";
import { summarizePlanDiagnostics } from "@/domain/floor-plan/plan-diagnostics";
import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import { evaluateRequirements } from "@/domain/floor-plan/plan-requirements";
import { findRoomAdjacency } from "@/domain/floor-plan/room-adjacency";
import { floorPlanSchema } from "@/domain/floor-plan/schema";
import { countsInTotal, type FloorPlan, type Opening, type RoomKind, type Wall } from "@/domain/floor-plan/types";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { analyzeWallIntersections } from "@/domain/floor-plan/wall-intersections";
import { analyzeWallOverlaps } from "@/domain/floor-plan/wall-overlaps";
import {
  reconcileWallRoomLabels,
  removeWallRoomLabel,
  resolveWallRoomLabels,
  setWallRoomLabel,
  type ResolvedWallRoom,
} from "@/domain/floor-plan/wall-room-labels";
import { rulesForPlan } from "@/domain/rules/engine";
import { hasOutsideWindow, type RuleRoom } from "@/domain/rules/rule-rooms";
import type { Procedure, RuleReport } from "@/domain/rules/types";
import { formatArea, formatLength } from "@/lib/format";

/**
 * Limited variant generation. It is a search, not a model, and it is limited on purpose:
 * it only removes, adds or shifts partitions. Bearing walls, walls of unknown type, and
 * the walls of bathrooms, balconies and shafts are never touched. Every candidate goes
 * through the same checks as a variant made by hand, and the same plan always gives the
 * same result. What comes out is a proposal to look at, not a design.
 */
export type GenerationGoal = "any" | "more-rooms" | "larger-rooms";

export interface VariantMove {
  kind: "remove-partition" | "split-room" | "shift-partition";
  text: string;
}

export interface GeneratedVariant {
  /** Stable for the same input; also what makes two candidates "the same". */
  key: string;
  title: string;
  moves: readonly VariantMove[];
  /** The plan after the moves, without an origin: saving it as a variant adds one. */
  plan: FloorPlan;
  /** Checked against the source plan. Null when no rules apply to this plan. */
  rules: RuleReport | null;
  overall: Procedure | null;
  roomsBefore: number;
  roomsAfter: number;
  areaBefore: number;
  areaAfter: number;
  /** How many of the plan's own requirements are not met now; never more than before. */
  violatedRequirements: number;
}

export type RejectionReason = "forbidden" | "new-problem" | "geometry" | "requirement" | "not-buildable";

export interface GenerationResult {
  variants: GeneratedVariant[];
  /** Candidates built and checked. */
  tried: number;
  rejected: Readonly<Record<RejectionReason, number>>;
  /** Why nothing could be tried at all; empty when the search ran. */
  blockers: string[];
  /** Walls left alone because their type is not known. */
  untypedWalls: number;
}

const MAX_RESULTS = 6;
const MAX_TRIED = 120;
/** How many of the best one-step candidates are taken on to a second step. */
const SECOND_STEP_SEEDS = 5;

/** The generator's own limits for a new room; not norms. Rules may ask for more. */
const MIN_NEW_ROOM_AREA = 8;
const MIN_NEW_ROOM_WIDTH = 2;
const SHIFTS = [0.5, -0.5, 1, -1];
const DOOR_WIDTH = 0.9;
const DOOR_HEIGHT = 2.1;
const DEFAULT_PARTITION_THICKNESS = 0.1;
const NEW_ROOM_COLOR = "#d3ebd8";

const PROTECTED_KINDS: readonly RoomKind[] = ["bathroom", "shaft", "balcony"];
const SPLITTABLE_KINDS: readonly RoomKind[] = ["living", "bedroom", "other"];
const SHIFT_KINDS: readonly RoomKind[] = ["living", "bedroom", "other", "hall"];

const PROCEDURE_RANK: Readonly<Record<Procedure, number>> = { simplified: 0, unknown: 1, project: 2, specialist: 3, forbidden: 4 };
const NO_RULES_RANK = 1;

type Step = { plan: FloorPlan; move: VariantMove };

const roomsOf = (plan: FloorPlan): ResolvedWallRoom[] => resolveWallRoomLabels(plan).rooms;
const beside = (rooms: readonly ResolvedWallRoom[], wall: Wall) => rooms.filter((room) => room.boundaryWallIds.includes(wall.id));
const wallNumber = (plan: FloorPlan, wall: Wall) => plan.walls.findIndex((item) => item.id === wall.id) + 1;
const totalArea = (rooms: readonly ResolvedWallRoom[]) =>
  rooms.filter((room) => countsInTotal(room.kind)).reduce((sum, room) => sum + room.area, 0);

function freshId(plan: FloorPlan, prefix: string): string {
  const used = new Set([...plan.walls, ...plan.openings, ...plan.wallRoomLabels, ...plan.rooms].map((item) => item.id));
  for (let index = 1; ; index++) {
    const id = `${prefix}-${index}`;
    if (!used.has(id)) return id;
  }
}

function removals(plan: FloorPlan): Step[] {
  const rooms = roomsOf(plan);
  const steps: Step[] = [];
  for (const wall of plan.walls) {
    if (wall.kind !== "partition") continue;
    const sides = beside(rooms, wall);
    if (sides.length !== 2 || sides.some((room) => PROTECTED_KINDS.includes(room.kind))) continue;
    try {
      // The merged room keeps the name of the larger one; the other label would be left over.
      const smaller = sides[0].area <= sides[1].area ? sides[0] : sides[1];
      const larger = smaller === sides[0] ? sides[1] : sides[0];
      const without = smaller.labelId ? removeWallRoomLabel(plan, smaller.labelId) : plan;
      const next = reconcileWallRoomLabels(without, deleteObject(without, wall.id));
      steps.push({ plan: next, move: { kind: "remove-partition", text: `Убрать стену ${wallNumber(plan, wall)} между «${larger.name}» и «${smaller.name}»` } });
    } catch {
      // A plan this would break is simply not a candidate.
    }
  }
  return steps;
}

function shifts(plan: FloorPlan): Step[] {
  const rooms = roomsOf(plan);
  const steps: Step[] = [];
  for (const wall of plan.walls) {
    if (wall.kind !== "partition") continue;
    const sides = beside(rooms, wall);
    if (sides.length !== 2 || !sides.every((room) => SHIFT_KINDS.includes(room.kind))) continue;
    for (const distance of SHIFTS) {
      try {
        const next = reconcileWallRoomLabels(plan, offsetWall(plan, wall.id, distance));
        const after = roomsOf(next);
        const grown = sides.find((room) => {
          const same = after.find((item) => item.labelId && item.labelId === room.labelId) ?? after.find((item) => item.id === room.id);
          return same && same.area > room.area;
        });
        const text = grown
          ? `Сдвинуть стену ${wallNumber(plan, wall)} на ${formatLength(Math.abs(distance))} м, чтобы увеличить «${grown.name}»`
          : `Сдвинуть стену ${wallNumber(plan, wall)} на ${formatLength(Math.abs(distance))} м`;
        steps.push({ plan: next, move: { kind: "shift-partition", text } });
      } catch {
        // A shift that collapses a neighbour or loses a joint is not a candidate.
      }
    }
  }
  return steps;
}

const snap = (value: number) => Math.round(value * 10) / 10;

/** The points where a straight line across a rectangular room meets the walls around it. */
function crossingEnds(plan: FloorPlan, room: ResolvedWallRoom, vertical: boolean, at: number) {
  const walls = plan.walls.filter((wall) => room.boundaryWallIds.includes(wall.id));
  const hits = walls.filter((wall) => {
    const parallel = vertical ? wall.start.y === wall.end.y : wall.start.x === wall.end.x;
    if (!parallel) return false;
    const [from, to] = vertical ? [wall.start.x, wall.end.x] : [wall.start.y, wall.end.y];
    return at > Math.min(from, to) && at < Math.max(from, to);
  });
  const low = vertical ? room.bounds.minY : room.bounds.minX;
  const high = vertical ? room.bounds.maxY : room.bounds.maxX;
  const axis = (wall: Wall) => (vertical ? wall.start.y : wall.start.x);
  const first = hits.filter((wall) => axis(wall) <= low + 1e-6).sort((a, b) => axis(b) - axis(a))[0];
  const second = hits.filter((wall) => axis(wall) >= high - 1e-6).sort((a, b) => axis(a) - axis(b))[0];
  if (!first || !second) return null;
  // A new wall must not land in a door or a window of the wall it stands against.
  const blocked = [first, second].some((wall) => {
    const along = vertical ? Math.abs(at - wall.start.x) : Math.abs(at - wall.start.y);
    return plan.openings.some((opening) =>
      opening.wallId === wall.id && along > opening.offset - 0.1 && along < opening.offset + opening.width + 0.1);
  });
  if (blocked) return null;
  return vertical
    ? { start: { x: at, y: axis(first) }, end: { x: at, y: axis(second) } }
    : { start: { x: axis(first), y: at }, end: { x: axis(second), y: at } };
}

function splits(plan: FloorPlan): Step[] {
  const rooms = roomsOf(plan);
  const thickness = plan.walls.find((wall) => wall.kind === "partition")?.thickness ?? DEFAULT_PARTITION_THICKNESS;
  const steps: Step[] = [];
  for (const room of rooms) {
    if (!SPLITTABLE_KINDS.includes(room.kind) || room.holes.length || room.outer.length !== 4) continue;
    const { minX, maxX, minY, maxY } = room.bounds;
    const width = maxX - minX, depth = maxY - minY;
    if (Math.abs(width * depth - room.area) > 0.01) continue;
    const height = Math.min(...plan.walls.filter((wall) => room.boundaryWallIds.includes(wall.id)).map((wall) => wall.height));
    for (const vertical of [true, false]) {
      const span = vertical ? width : depth;
      const across = vertical ? depth : width;
      const origin = vertical ? minX : minY;
      for (const share of [0.5, 0.4, 0.6]) {
        const at = snap(origin + span * share);
        const part = Math.min(at - origin, origin + span - at) - thickness / 2;
        if (part < MIN_NEW_ROOM_WIDTH || part * across < MIN_NEW_ROOM_AREA) continue;
        const ends = crossingEnds(plan, room, vertical, at);
        if (!ends) continue;
        const length = Math.hypot(ends.end.x - ends.start.x, ends.end.y - ends.start.y);
        if (length < DOOR_WIDTH + 0.4) continue;
        const wallId = freshId(plan, "generated-wall");
        const wall: Wall = { id: wallId, ...ends, thickness, height, kind: "partition" };
        for (const side of ["left", "right"] as const) {
          const door: Opening = {
            id: freshId(plan, "generated-door"),
            wallId,
            kind: "door",
            offset: snap((length - DOOR_WIDTH) / 2),
            width: DOOR_WIDTH,
            height: DOOR_HEIGHT,
            sillHeight: 0,
            door: { hinge: "start", side },
          };
          try {
            let next = reconcileWallRoomLabels(plan, addWallsAndOpenings(plan, [wall], [door]));
            const parts = roomsOf(next).filter((item) => item.boundaryWallIds.includes(wallId));
            if (parts.length !== 2) continue;
            // Both parts need daylight: a room without a window is no room to offer.
            if (parts.some((item) => !hasOutsideWindow(next, item as RuleRoom, roomsOf(next)))) continue;
            const number = roomsOf(next).filter((item) => item.kind === "bedroom").length + 1;
            let newName = "";
            for (const unnamed of parts.filter((item) => !item.labelId)) {
              newName = `Спальня ${number}`;
              next = setWallRoomLabel(next, unnamed, { name: newName, kind: "bedroom", color: NEW_ROOM_COLOR }, freshId(next, "generated-room"));
            }
            steps.push({ plan: next, move: { kind: "split-room", text: `Разделить «${room.name}» на ${parts.map((item) => formatArea(item.area)).join(" и ")} перегородкой с дверью${newName ? `: появится «${newName}»` : ""}` } });
            // The door's swing is not a different layout: one working side is enough.
            break;
          } catch {
            // Not buildable: not a candidate.
          }
        }
      }
    }
  }
  return steps;
}

function diagnosticsCount(plan: FloorPlan): number {
  return summarizePlanDiagnostics({
    connections: analyzeWallConnections(plan.walls).filter((item) => item.kind !== "junction"),
    intersections: analyzeWallIntersections(plan.walls),
    overlaps: analyzeWallOverlaps(plan.walls),
    doorWalls: analyzeDoorWallCollisions(plan.walls, plan.openings),
    doorPairs: analyzeDoorPairCollisions(plan.walls, plan.openings),
  }).total;
}

function violatedCount(plan: FloorPlan): number {
  const rooms = roomsOf(plan);
  const adjacency = findRoomAdjacency(rooms, plan.walls, plan.openings);
  return evaluateRequirements(plan, rooms, adjacency).filter((result) => result.status === "violated").length;
}

/** What makes two plans the same candidate: their walls and openings, in any order. */
function signature(plan: FloorPlan): string {
  const point = (value: { x: number; y: number }) => `${Math.round(value.x * 1000)},${Math.round(value.y * 1000)}`;
  const walls = plan.walls.map((wall) => [point(wall.start), point(wall.end)].sort().join("|")).sort();
  const openings = plan.openings.map((item) => `${item.kind}:${item.width}`).sort();
  return `${walls.join(";")}#${openings.join(";")}`;
}

const newProblems = (rules: RuleReport | null, before: ReadonlySet<string>) =>
  (rules?.findings ?? []).filter((finding) => finding.state === "problem" && !finding.procedure && !before.has(finding.title));

export function generateVariants(
  source: FloorPlan,
  options: { goal: GenerationGoal; at: string },
): GenerationResult {
  const rejected: Record<RejectionReason, number> = { forbidden: 0, "new-problem": 0, geometry: 0, requirement: 0, "not-buildable": 0 };
  const untypedWalls = source.walls.filter((wall) => !wall.kind || wall.kind === "unknown").length;
  const empty = (blockers: string[]): GenerationResult => ({ variants: [], tried: 0, rejected, blockers, untypedWalls });
  if (source.roomMode !== "walls") return empty(["Варианты подбираются по стенам. Сейчас помещения заданы вручную: включите режим «По стенам» и нарисуйте стены."]);
  if (!source.walls.length) return empty(["На плане нет стен. Нарисуйте их или загрузите чертёж."]);
  if (!source.walls.some((wall) => wall.kind === "partition")) {
    return empty(["Нет ни одной стены с отметкой «перегородка», а менять можно только их. Отметьте типы стен."]);
  }
  let startRooms: ResolvedWallRoom[];
  try {
    startRooms = roomsOf(source);
  } catch (error) {
    return empty([error instanceof Error ? error.message : "Помещения не определены."]);
  }
  if (!startRooms.length) return empty(["На плане нет замкнутых помещений."]);

  const { origin: _previous, ...base } = source;
  void _previous;
  const start = base as FloorPlan;
  const sourceRules = rulesForPlan(start);
  const sourceProblems = new Set(
    (sourceRules?.findings ?? []).filter((finding) => finding.state === "problem").map((finding) => finding.title),
  );
  const startDiagnostics = diagnosticsCount(start);
  const startViolated = violatedCount(start);
  const startArea = totalArea(startRooms);
  const largest = (rooms: readonly ResolvedWallRoom[]) => Math.max(0, ...rooms.filter((room) => room.kind === "living" || room.kind === "bedroom").map((room) => room.area));

  const seen = new Set<string>([signature(start)]);
  const accepted: GeneratedVariant[] = [];
  let tried = 0;

  const consider = (moves: readonly VariantMove[], plan: FloorPlan): GeneratedVariant | null => {
    const key = signature(plan);
    if (seen.has(key) || tried >= MAX_TRIED) return null;
    seen.add(key);
    tried += 1;
    if (!floorPlanSchema.safeParse(plan).success) {
      rejected["not-buildable"] += 1;
      return null;
    }
    let rooms: ResolvedWallRoom[];
    try {
      rooms = roomsOf(plan);
    } catch {
      rejected["not-buildable"] += 1;
      return null;
    }
    if (diagnosticsCount(plan) > startDiagnostics) {
      rejected.geometry += 1;
      return null;
    }
    const violated = violatedCount(plan);
    if (violated > startViolated) {
      rejected.requirement += 1;
      return null;
    }
    const checked = { ...plan, origin: createPlanOrigin(start, options.at) };
    const rules = rulesForPlan(checked);
    if (rules?.overall === "forbidden") {
      rejected.forbidden += 1;
      return null;
    }
    if (newProblems(rules, sourceProblems).length) {
      rejected["new-problem"] += 1;
      return null;
    }
    const variant: GeneratedVariant = {
      key,
      title: moves.map((move) => move.text).join(", затем "),
      moves,
      plan,
      rules,
      overall: rules?.overall ?? null,
      roomsBefore: startRooms.length,
      roomsAfter: rooms.length,
      areaBefore: startArea,
      areaAfter: totalArea(rooms),
      violatedRequirements: violated,
    };
    accepted.push(variant);
    return variant;
  };

  const movesFrom = (plan: FloorPlan) => [...splits(plan), ...removals(plan), ...shifts(plan)];
  const firstStep: GeneratedVariant[] = [];
  for (const step of movesFrom(start)) {
    const variant = consider([step.move], step.plan);
    if (variant) firstStep.push(variant);
  }

  const rankOf = (variant: GeneratedVariant) => (variant.overall ? PROCEDURE_RANK[variant.overall] : NO_RULES_RANK);
  const matchesGoal = (variant: GeneratedVariant) => {
    if (options.goal === "more-rooms") return variant.roomsAfter > variant.roomsBefore;
    if (options.goal === "larger-rooms") return largest(roomsOf(variant.plan)) > largest(startRooms);
    return true;
  };
  const compare = (a: GeneratedVariant, b: GeneratedVariant) =>
    a.violatedRequirements - b.violatedRequirements ||
    rankOf(a) - rankOf(b) ||
    a.moves.length - b.moves.length ||
    a.title.localeCompare(b.title, "ru");

  // A second step only from the most promising first steps, so the search stays bounded.
  for (const seed of [...firstStep].sort(compare).slice(0, SECOND_STEP_SEEDS)) {
    for (const step of movesFrom(seed.plan)) consider([...seed.moves, step.move], step.plan);
  }

  return {
    variants: accepted.filter(matchesGoal).sort(compare).slice(0, MAX_RESULTS),
    tried,
    rejected,
    blockers: [],
    untypedWalls,
  };
}

/** One line about the size of a candidate, for the card. */
export function variantSummary(variant: GeneratedVariant): string {
  return `Помещений: ${variant.roomsBefore} → ${variant.roomsAfter}. Площадь: ${formatArea(Math.round(variant.areaBefore * 100) / 100)} → ${formatArea(Math.round(variant.areaAfter * 100) / 100)}.`;
}
