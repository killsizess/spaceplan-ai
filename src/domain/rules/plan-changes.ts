import type { FloorPlan, Opening, RoomKind, Wall } from "@/domain/floor-plan/types";
import { overlapArea, sameShape, type RuleRoom } from "./rule-rooms";

const EPSILON = 1e-6;

const same = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= EPSILON;

const sameAxis = (a: Wall, b: Wall) =>
  (same(a.start, b.start) && same(a.end, b.end)) || (same(a.start, b.end) && same(a.end, b.start));

/**
 * True when other walls of the same thickness lie along this wall's whole axis. Joining
 * walls splits one into two with new IDs: that is not a wall removed and two added.
 */
function coveredBy(wall: Wall, others: readonly Wall[]): boolean {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (length <= EPSILON) return true;
  const ux = (wall.end.x - wall.start.x) / length, uy = (wall.end.y - wall.start.y) / length;
  const across = (point: { x: number; y: number }) =>
    Math.abs((point.x - wall.start.x) * -uy + (point.y - wall.start.y) * ux);
  const along = (point: { x: number; y: number }) =>
    (point.x - wall.start.x) * ux + (point.y - wall.start.y) * uy;
  const spans = others
    .filter((other) => Math.abs(other.thickness - wall.thickness) <= EPSILON)
    .filter((other) => across(other.start) <= EPSILON && across(other.end) <= EPSILON)
    .map((other) => [along(other.start), along(other.end)].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
  let reached = 0;
  for (const [from, to] of spans) {
    if (from > reached + EPSILON) return false;
    reached = Math.max(reached, to);
  }
  return reached >= length - EPSILON;
}

export interface WallChanges {
  added: Wall[];
  removed: Wall[];
  moved: { before: Wall; after: Wall }[];
  /** Same axis, another thickness. */
  thickened: { before: Wall; after: Wall }[];
  /** Same geometry, another type. */
  retyped: { before: Wall; after: Wall }[];
}

export function wallChanges(source: Pick<FloorPlan, "walls">, plan: Pick<FloorPlan, "walls">): WallChanges {
  const changes: WallChanges = { added: [], removed: [], moved: [], thickened: [], retyped: [] };
  const before = new Map(source.walls.map((wall) => [wall.id, wall]));
  const after = new Map(plan.walls.map((wall) => [wall.id, wall]));
  for (const wall of source.walls) {
    const next = after.get(wall.id);
    if (!next) {
      if (!coveredBy(wall, plan.walls)) changes.removed.push(wall);
    } else if (!sameAxis(wall, next)) {
      if (!coveredBy(next, source.walls) || !coveredBy(wall, plan.walls)) {
        changes.moved.push({ before: wall, after: next });
      }
    } else if (Math.abs(wall.thickness - next.thickness) > EPSILON) {
      changes.thickened.push({ before: wall, after: next });
    } else if ((wall.kind ?? "unknown") !== (next.kind ?? "unknown")) {
      changes.retyped.push({ before: wall, after: next });
    }
  }
  for (const wall of plan.walls) {
    if (!before.has(wall.id) && !coveredBy(wall, source.walls)) changes.added.push(wall);
  }
  return changes;
}

export interface OpeningChanges {
  added: Opening[];
  removed: Opening[];
  moved: { before: Opening; after: Opening }[];
}

const sameSize = (a: Opening, b: Opening) =>
  a.kind === b.kind &&
  Math.abs(a.width - b.width) <= EPSILON &&
  Math.abs(a.height - b.height) <= EPSILON &&
  Math.abs(a.sillHeight - b.sillHeight) <= EPSILON;

function centreOf(opening: Opening, walls: ReadonlyMap<string, Wall>) {
  const wall = walls.get(opening.wallId);
  if (!wall) return null;
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1;
  const along = opening.offset + opening.width / 2;
  return {
    x: wall.start.x + ((wall.end.x - wall.start.x) / length) * along,
    y: wall.start.y + ((wall.end.y - wall.start.y) / length) * along,
  };
}

/**
 * An opening keeps its place if its numbers on its wall did not change (the wall itself may
 * have moved: that is the wall's change) or if it stands at the same point of the plan
 * (a wall split gives it another host and another offset).
 */
export function openingChanges(
  source: Pick<FloorPlan, "walls" | "openings">,
  plan: Pick<FloorPlan, "walls" | "openings">,
): OpeningChanges {
  const changes: OpeningChanges = { added: [], removed: [], moved: [] };
  const wallsBefore = new Map(source.walls.map((wall) => [wall.id, wall]));
  const wallsAfter = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const after = new Map(plan.openings.map((item) => [item.id, item]));
  const before = new Map(source.openings.map((item) => [item.id, item]));
  for (const opening of source.openings) {
    const next = after.get(opening.id);
    if (!next) {
      changes.removed.push(opening);
      continue;
    }
    if (next.wallId === opening.wallId && Math.abs(next.offset - opening.offset) <= EPSILON && sameSize(opening, next)) continue;
    const from = centreOf(opening, wallsBefore), to = centreOf(next, wallsAfter);
    if (from && to && same(from, to) && sameSize(opening, next)) continue;
    changes.moved.push({ before: opening, after: next });
  }
  for (const opening of plan.openings) if (!before.has(opening.id)) changes.added.push(opening);
  return changes;
}

export interface RoomKindChanges {
  /** No room of this kind stood mostly on this spot before. */
  created: RuleRoom[];
  /** Mostly on the old spot, with other boundaries. */
  resized: { before: RuleRoom; after: RuleRoom }[];
  /** No room of this kind stands mostly on this spot now. */
  gone: RuleRoom[];
}

/** Two rooms count as "the same room, changed" when each lies at least half inside the other. */
const SAME_ROOM_SHARE = 0.5;

export function roomKindChanges(
  before: readonly RuleRoom[],
  after: readonly RuleRoom[],
  kind: RoomKind,
): RoomKindChanges {
  const was = before.filter((room) => room.kind === kind);
  const now = after.filter((room) => room.kind === kind);
  const changes: RoomKindChanges = { created: [], resized: [], gone: [] };
  const matched = new Set<RuleRoom>();
  for (const room of now) {
    const exact = was.find((old) => !matched.has(old) && sameShape(old, room));
    if (exact) {
      matched.add(exact);
      continue;
    }
    const near = was.find((old) => {
      if (matched.has(old)) return false;
      const shared = overlapArea(old, room);
      return shared >= old.area * SAME_ROOM_SHARE && shared >= room.area * SAME_ROOM_SHARE;
    });
    if (near) {
      matched.add(near);
      changes.resized.push({ before: near, after: room });
    } else {
      changes.created.push(room);
    }
  }
  for (const old of was) if (!matched.has(old)) changes.gone.push(old);
  return changes;
}
