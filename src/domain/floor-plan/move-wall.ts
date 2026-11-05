import { tr } from "@/lib/i18n";
import type { Point } from "@/domain/geometry";
import { floorPlanSchema } from "./schema";
import type { FloorPlan, Wall } from "./types";
import { rebaseOpenings, sameWallNode, type WallEndpoint } from "./wall-nodes";
import {
  buildWallTopology,
  type TopologyNode,
  type WallEnd,
  type WallTopology,
} from "./wall-topology";

/** Supports whose unit directions differ by less than this sine are parallel. */
const PARALLEL_TOLERANCE = 1e-9;

export const WALL_MOVE_STALE = tr`Стена изменилась во время переноса. Повторите действие.`;
const INVALID_DELTA = tr`Сдвиг стены должен быть числом.`;
const SUPPORT_LOST =
  tr`Стена опирается концом на середину другой стены и оторвалась бы от неё. Переносите её вдоль той стены.`;
const JUNCTION_LOST =
  tr`Перенос оторвал бы примыкание соседней стены. Уменьшите сдвиг или сначала измените соседние стены.`;

export interface WallMoveContext {
  readonly wallId: string;
  /**
   * Wall ends that travel by the same vector: both ends of the wall, every end
   * sharing a node with them and every end resting on the wall's interior (an
   * unsplit T whose host is the moved wall). Sorted by wall ID, start first.
   */
  readonly carried: readonly WallEnd[];
  /** Walls whose interior an end of the moved wall rests on (it is their T branch). */
  readonly supports: readonly string[];
  /**
   * Unit direction of the editor gesture: along the supports when they are all
   * parallel, so the wall slides on them; otherwise the wall's normal. Always on
   * the side of the normal, which points right of the start-to-end direction.
   */
  readonly direction: Point;
  /** Graph before the move; every junction in it must survive the move. */
  readonly topology: WallTopology;
  /** Unit normal of the wall, right of its start-to-end direction. */
  readonly normal: Point;
  /**
   * Junctions an offset recomputes: the wall's two nodes and the nodes resting on
   * its interior. Each slides along the one line through it (`along`), or moves
   * with the wall when nothing else meets it (`along: null`).
   */
  readonly offsetJoints: readonly OffsetJoint[];
  /** Why an offset that keeps every other wall's direction is impossible, or null. */
  readonly offsetBlocked: string | null;
}

export interface OffsetJoint {
  readonly ends: readonly WallEnd[];
  /** Stored position of the node, in metres. */
  readonly point: Point;
  /** Unit direction of the line the node slides along; null for a free wall end. */
  readonly along: Point | null;
}

export const OFFSET_CONTINUATION =
  tr`Стена продолжается за узлом другой стеной на той же прямой. Сохранить направления нельзя: используйте обычный перенос.`;
export const OFFSET_MIXED_NODE =
  tr`В узле этой стены сходятся стены разных направлений. Сохранить направления всех стен нельзя: используйте обычный перенос.`;
const OFFSET_COLLAPSE =
  tr`Соседняя стена сократилась бы до нуля или развернулась бы. Уменьшите сдвиг.`;
const INVALID_DISTANCE = tr`Сдвиг стены должен быть числом.`;

const cleanZero = (value: number) => (Object.is(value, -0) ? 0 : value);
const endKey = (end: WallEnd) => JSON.stringify([end.wallId, end.endpoint]);
const compareEnds = (a: WallEnd, b: WallEnd) =>
  a.wallId < b.wallId ? -1 : a.wallId > b.wallId ? 1 :
    a.endpoint === b.endpoint ? 0 : a.endpoint === "start" ? -1 : 1;

function unitAxis(wall: Wall): Point {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  return { x: dx / length, y: dy / length };
}

function nodesByEnd(topology: WallTopology): Map<string, TopologyNode> {
  const result = new Map<string, TopologyNode>();
  for (const node of topology.nodes) {
    for (const end of node.ends) result.set(endKey(end), node);
  }
  return result;
}

function assertDelta(delta: Point): void {
  if (!delta || ![delta.x, delta.y].every(Number.isFinite)) throw new Error(INVALID_DELTA);
}

/**
 * Derives, once per plan state, what moving one wall drags along. Read-only and
 * computed from the wall graph, so the editor gesture and the committed command
 * share one definition of "attached".
 */
export function wallMoveContext(walls: readonly Wall[], wallId: string): WallMoveContext {
  const topology = buildWallTopology(walls);
  const wall = walls.find((item) => item.id === wallId);
  if (!wall) throw new Error(tr`Стена не найдена.`);
  const byEnd = nodesByEnd(topology);
  const byKey = new Map(topology.nodes.map((node) => [node.key, node]));
  const own = (["start", "end"] as const).map((endpoint) => byEnd.get(endKey({ wallId, endpoint }))!);
  const ownKeys = new Set(own.map((node) => node.key));

  const carriedNodes = new Map(own.map((node) => [node.key, node]));
  const supports = new Set<string>();
  for (const contact of topology.contacts) {
    if (contact.wallId === wallId) carriedNodes.set(contact.node, byKey.get(contact.node)!);
    else if (ownKeys.has(contact.node)) supports.add(contact.wallId);
  }
  const carried = [...carriedNodes.values()]
    .flatMap((node) => node.ends.map((end) => ({ ...end })))
    .sort(compareEnds);

  const axis = unitAxis(wall);
  const normal = { x: -axis.y, y: axis.x };
  const byId = new Map(walls.map((item) => [item.id, item]));
  const supportIds = [...supports].sort();
  const axes = supportIds.map((id) => unitAxis(byId.get(id)!));
  const parallel = axes.length > 0 && axes.every((item) =>
    Math.abs(axes[0].x * item.y - axes[0].y * item.x) <= PARALLEL_TOLERANCE,
  );
  let direction = parallel ? axes[0] : normal;
  if (direction.x * normal.x + direction.y * normal.y < 0) direction = { x: -direction.x, y: -direction.y };

  // Offset joints: every line through a carried node other than the wall itself.
  const hostsOf = new Map<string, string[]>();
  for (const contact of topology.contacts) {
    if (contact.wallId === wallId) continue;
    hostsOf.set(contact.node, [...(hostsOf.get(contact.node) ?? []), contact.wallId]);
  }
  let offsetBlocked: string | null = null;
  const offsetJoints: OffsetJoint[] = [...carriedNodes.values()].map((node) => {
    const lineWalls = [
      ...node.ends.filter((end) => end.wallId !== wallId).map((end) => end.wallId),
      ...(hostsOf.get(node.key) ?? []),
    ];
    const lines: Point[] = [];
    for (const id of lineWalls) {
      const line = unitAxis(byId.get(id)!);
      if (!lines.some((item) => Math.abs(item.x * line.y - item.y * line.x) <= PARALLEL_TOLERANCE)) lines.push(line);
    }
    if (lines.some((line) => Math.abs(line.x * axis.y - line.y * axis.x) <= PARALLEL_TOLERANCE)) {
      offsetBlocked ??= OFFSET_CONTINUATION;
    } else if (lines.length > 1) {
      offsetBlocked ??= OFFSET_MIXED_NODE;
    }
    return {
      ends: node.ends.map((end) => ({ ...end })),
      point: { ...node.point },
      along: lines.length === 1 ? lines[0] : null,
    };
  });

  return {
    wallId,
    carried,
    supports: supportIds,
    direction: { x: cleanZero(direction.x), y: cleanZero(direction.y) },
    topology,
    normal: { x: cleanZero(normal.x), y: cleanZero(normal.y) },
    offsetJoints,
    offsetBlocked,
  };
}

/**
 * Geometry-only preview of a move: every carried end shifts by the same vector,
 * other walls keep their references. Coordinates and junctions are checked only
 * by the committed command, so a drag can show an out-of-range position first.
 */
export function previewWallMove(
  walls: readonly Wall[],
  context: WallMoveContext,
  delta: Point,
): readonly Wall[] {
  assertDelta(delta);
  if (delta.x === 0 && delta.y === 0) return walls;
  const moving = new Map<string, Set<WallEndpoint>>();
  for (const end of context.carried) {
    const ends = moving.get(end.wallId) ?? new Set<WallEndpoint>();
    ends.add(end.endpoint);
    moving.set(end.wallId, ends);
  }
  const shift = (point: Point): Point => ({
    x: cleanZero(point.x + delta.x),
    y: cleanZero(point.y + delta.y),
  });
  return walls.map((wall) => {
    const ends = moving.get(wall.id);
    if (!ends) return wall;
    return {
      ...wall,
      start: ends.has("start") ? shift(wall.start) : wall.start,
      end: ends.has("end") ? shift(wall.end) : wall.end,
    };
  });
}

/**
 * Geometry-only preview of an offset that keeps every other wall's direction: the
 * wall's line moves by `distance` along its normal and each joint goes to where
 * its own line crosses the new one (a free end just moves with the wall). Throws
 * the context's reason when such an offset is impossible.
 */
export function previewWallOffset(
  walls: readonly Wall[],
  context: WallMoveContext,
  distance: number,
): readonly Wall[] {
  if (!Number.isFinite(distance)) throw new Error(INVALID_DISTANCE);
  if (context.offsetBlocked) throw new Error(context.offsetBlocked);
  if (distance === 0) return walls;
  const wall = walls.find((item) => item.id === context.wallId);
  if (!wall) throw new Error(tr`Стена не найдена.`);
  const { normal } = context;
  const axis = { x: normal.y, y: -normal.x };
  const origin = { x: wall.start.x + normal.x * distance, y: wall.start.y + normal.y * distance };
  const moved = new Map<string, Point>();
  for (const joint of context.offsetJoints) {
    let point: Point;
    if (!joint.along) {
      point = { x: joint.point.x + normal.x * distance, y: joint.point.y + normal.y * distance };
    } else {
      // joint.point + t * along lies on the new wall line through `origin`.
      const along = joint.along;
      const t = ((origin.x - joint.point.x) * axis.y - (origin.y - joint.point.y) * axis.x) /
        (along.x * axis.y - along.y * axis.x);
      point = { x: joint.point.x + along.x * t, y: joint.point.y + along.y * t };
    }
    const clean = { x: cleanZero(point.x), y: cleanZero(point.y) };
    for (const end of joint.ends) moved.set(endKey(end), clean);
  }
  return walls.map((item) => {
    const start = moved.get(endKey({ wallId: item.id, endpoint: "start" }));
    const end = moved.get(endKey({ wallId: item.id, endpoint: "end" }));
    return start || end ? { ...item, start: start ?? item.start, end: end ?? item.end } : item;
  });
}

/**
 * Explicit "move the wall, keep the others' directions" command (CAD-style
 * offset). The wall moves by `distance` along its normal (right of start → end);
 * walls meeting it at its corners or resting on it grow or shrink along their own
 * lines, and its ends slide along the walls it rests on. Openings on the moved
 * walls keep their plan position along each axis. Rejected as a whole when a node
 * joins walls of several directions, a wall would collapse or turn round, any
 * junction would be lost, an opening cut or the format limits left.
 */
export function offsetWall(
  plan: FloorPlan,
  wallId: string,
  distance: number,
  expected?: { readonly start: Point; readonly end: Point },
): FloorPlan {
  if (!Number.isFinite(distance)) throw new Error(INVALID_DISTANCE);
  const wall = plan.walls.find((item) => item.id === wallId);
  if (!wall) throw new Error(tr`Стена не найдена.`);
  if (expected && !(sameWallNode(wall.start, expected.start) && sameWallNode(wall.end, expected.end))) {
    throw new Error(WALL_MOVE_STALE);
  }
  if (distance === 0) return plan;
  const context = wallMoveContext(plan.walls, wallId);
  const walls = previewWallOffset(plan.walls, context, distance);
  const before = new Map(plan.walls.map((item) => [item.id, item]));
  for (const item of walls) {
    const original = before.get(item.id)!;
    if (item === original) continue;
    const ox = original.end.x - original.start.x, oy = original.end.y - original.start.y;
    const nx = item.end.x - item.start.x, ny = item.end.y - item.start.y;
    if (Math.hypot(nx, ny) <= 1e-9 || ox * nx + oy * ny <= 0) throw new Error(OFFSET_COLLAPSE);
  }
  const lost = lostJunction(context, walls);
  if (lost) throw new Error(lost);
  const parsed = floorPlanSchema.safeParse({
    ...plan,
    walls: [...walls],
    openings: [...rebaseOpenings(plan.walls, walls, plan.openings)],
  });
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom");
    throw new Error(issue?.message ?? tr`Проверьте размеры, координаты и свойства стен.`);
  }
  return parsed.data;
}

/**
 * The graph after the move must still contain every junction of the graph
 * before it: shared nodes stay together, and every T keeps its branch on the
 * host's axis (or on the host's end). New junctions are allowed.
 */
function lostJunction(context: WallMoveContext, walls: readonly Wall[]): string | null {
  const after = buildWallTopology(walls);
  const afterByEnd = nodesByEnd(after);
  const afterContacts = new Map<string, Set<string>>();
  for (const contact of after.contacts) {
    const hosts = afterContacts.get(contact.node) ?? new Set<string>();
    hosts.add(contact.wallId);
    afterContacts.set(contact.node, hosts);
  }
  const before = new Map(context.topology.nodes.map((node) => [node.key, node]));
  let support = false;
  let other = false;
  for (const node of context.topology.nodes) {
    if (new Set(node.ends.map((end) => afterByEnd.get(endKey(end))!.key)).size > 1) other = true;
  }
  for (const contact of context.topology.contacts) {
    const node = before.get(contact.node)!;
    const current = afterByEnd.get(endKey(node.ends[0]))!;
    if (
      current.ends.some((end) => end.wallId === contact.wallId) ||
      afterContacts.get(current.key)?.has(contact.wallId)
    ) continue;
    if (node.ends.some((end) => end.wallId === context.wallId)) support = true;
    else other = true;
  }
  return support ? SUPPORT_LOST : other ? JUNCTION_LOST : null;
}

/**
 * Explicit "move the whole wall" command, one undoable transaction. The wall
 * and everything resting on it move by `delta`: its openings, the walls sharing
 * its corner nodes and the walls whose ends touch its interior (unsplit T), so
 * those junctions keep their position along the wall, like its openings. Moved
 * walls rebase their openings by the shared rules of `rebaseOpenings`. A move
 * that would detach any existing junction, cut an opening or leave the format
 * limits is rejected as a whole; the previous plan stays untouched.
 */
export function moveWall(
  plan: FloorPlan,
  wallId: string,
  delta: Point,
  expected?: { readonly start: Point; readonly end: Point },
): FloorPlan {
  assertDelta(delta);
  const wall = plan.walls.find((item) => item.id === wallId);
  if (!wall) throw new Error(tr`Стена не найдена.`);
  if (expected && !(sameWallNode(wall.start, expected.start) && sameWallNode(wall.end, expected.end))) {
    throw new Error(WALL_MOVE_STALE);
  }
  if (delta.x === 0 && delta.y === 0) return plan;
  const context = wallMoveContext(plan.walls, wallId);
  const walls = previewWallMove(plan.walls, context, delta);
  const lost = lostJunction(context, walls);
  if (lost) throw new Error(lost);
  const parsed = floorPlanSchema.safeParse({
    ...plan,
    walls: [...walls],
    openings: [...rebaseOpenings(plan.walls, walls, plan.openings)],
  });
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.code === "custom");
    throw new Error(issue?.message ?? tr`Проверьте размеры, координаты и свойства стен.`);
  }
  return parsed.data;
}
