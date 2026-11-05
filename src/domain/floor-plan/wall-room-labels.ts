import { tr } from "@/lib/i18n";
import type { Point } from "@/domain/geometry";
import { floorPlanSchema, wallRoomLabelSchema } from "./schema";
import type { FloorPlan, RoomKind, WallRoomLabel } from "./types";
import { detectWallRooms, type WallRoom } from "./wall-rooms";

const EPSILON = 1e-9;
export interface WallRoomLabelValues { name: string; kind: RoomKind; color: string }
export interface ResolvedWallRoom extends WallRoom { kind: RoomKind; labelId?: string }
export interface WallRoomLabelResolution {
  rooms: ResolvedWallRoom[];
  warnings: string[];
  unassigned: WallRoomLabel[];
}
const valuesSchema = wallRoomLabelSchema.pick({ name: true, kind: true, color: true });

type Segment = readonly [Point, Point];
const ringSegments = (ring: readonly Point[]): Segment[] =>
  ring.map((point, index) => [point, ring[(index + 1) % ring.length]]);
const samePoint = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
const sameRing = (a: readonly Point[], b: readonly Point[]) =>
  a.length === b.length && a.every((point, index) => samePoint(point, b[index]));
const sameContour = (a: WallRoom, b: WallRoom) =>
  sameRing(a.outer, b.outer) && a.holes.length === b.holes.length &&
  a.holes.every((hole, index) => sameRing(hole, b.holes[index]));

/** -1 outside, 0 on boundary, 1 strictly inside. */
function locate(point: Point, ring: readonly Point[]): -1 | 0 | 1 {
  let inside = false;
  for (const [a, b] of ringSegments(ring)) {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length > 0 && Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x)) / length <= EPSILON &&
      point.x >= Math.min(a.x, b.x) - EPSILON && point.x <= Math.max(a.x, b.x) + EPSILON &&
      point.y >= Math.min(a.y, b.y) - EPSILON && point.y <= Math.max(a.y, b.y) + EPSILON) return 0;
    if (a.y > point.y !== b.y > point.y && point.x < a.x + (point.y - a.y) * dx / dy) inside = !inside;
  }
  return inside ? 1 : -1;
}
function contains(room: WallRoom, point: Point): boolean {
  return locate(point, room.outer) === 1 && room.holes.every((hole) => locate(point, hole) === -1);
}
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** A label's boundaryWallIds are the persisted key of its room (rank 2); the anchor only resolves boundary changes. */
function resolve(plan: FloorPlan) {
  const detection = detectWallRooms(plan.walls);
  const supports = detection.rooms.map((room) => room.boundaryWallIds);
  const proposals = plan.wallRoomLabels.map((label): { room: number; rank: number } | null => {
    const exact = supports.flatMap((ids, index) => sameIds(ids, label.boundaryWallIds) ? [index] : []);
    if (exact.length === 1) return { room: exact[0], rank: 2 };
    if (exact.length > 1) return null;
    const shared = supports.map((ids) => ids.filter((id) => label.boundaryWallIds.includes(id)).length);
    const containing = detection.rooms.flatMap((room, index) => contains(room, label.anchor) && shared[index] > 0 ? [index] : []);
    if (containing.length === 1) return { room: containing[0], rank: 1 };
    // Similar boundary IDs alone cannot distinguish a moved room from its neighbour.
    return null;
  });
  const assignment = new Map<number, WallRoomLabel>();
  detection.rooms.forEach((_, room) => {
    const candidates = proposals.flatMap((proposal, index) => proposal?.room === room ? [{ label: plan.wallRoomLabels[index], rank: proposal.rank }] : []);
    const exact = candidates.filter((candidate) => candidate.rank === 2);
    const winners = exact.length ? exact : candidates;
    if (winners.length === 1) assignment.set(room, winners[0].label);
  });
  const assigned = new Set([...assignment.values()].map((label) => label.id));
  const unassigned = plan.wallRoomLabels.filter((label) => !assigned.has(label.id));
  const rooms = detection.rooms.map((room, index): ResolvedWallRoom => {
    const label = assignment.get(index);
    return label ? { ...room, name: label.name, kind: label.kind, color: label.color, labelId: label.id } : { ...room, kind: "other" };
  });
  return { rooms, supports, unassigned, warnings: detection.warnings };
}

/** Stable attributes decorate fresh geometry; contours themselves are never serialized. */
export function resolveWallRoomLabels(plan: FloorPlan): WallRoomLabelResolution {
  if (plan.roomMode !== "walls") return { rooms: [], warnings: [], unassigned: plan.wallRoomLabels };
  if (!plan.wallRoomLabels.length) {
    const detection = detectWallRooms(plan.walls);
    return { rooms: detection.rooms.map((room) => ({ ...room, kind: "other" })), warnings: detection.warnings, unassigned: [] };
  }
  const result = resolve(plan);
  return {
    rooms: result.rooms,
    unassigned: result.unassigned,
    warnings: result.unassigned.length ? [...result.warnings, tr`Не привязано подписей помещений: ${result.unassigned.length}. Назначьте их вручную или удалите.`] : result.warnings,
  };
}

function validate(plan: FloorPlan): FloorPlan {
  const parsed = floorPlanSchema.safeParse(plan);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? tr`Проверьте свойства помещения.`);
  return parsed.data;
}
function currentRoom(plan: FloorPlan, snapshot: WallRoom) {
  if (plan.roomMode !== "walls") throw new Error(tr`Переключитесь в режим помещений по стенам.`);
  const result = resolve(plan);
  const index = result.rooms.findIndex((room) => sameContour(room, snapshot));
  if (index < 0) throw new Error(tr`Помещение изменилось. Выберите его заново.`);
  return { room: result.rooms[index], boundaryWallIds: result.supports[index] };
}
function validateBinding(plan: FloorPlan, room: WallRoom, labelId: string): FloorPlan {
  const next = validate(plan);
  if (!resolveWallRoomLabels(next).rooms.some((candidate) => candidate.labelId === labelId && sameContour(candidate, room))) {
    throw new Error(tr`Несколько сохранённых записей соответствуют этому помещению. Удалите лишние параметры и повторите привязку.`);
  }
  return next;
}

export function setWallRoomLabel(plan: FloorPlan, snapshot: WallRoom, values: WallRoomLabelValues, labelId: string): FloorPlan {
  const { room, boundaryWallIds } = currentRoom(plan, snapshot);
  const existing = room.labelId ? plan.wallRoomLabels.find((label) => label.id === room.labelId) : undefined;
  if (!existing && plan.wallRoomLabels.some((label) => label.id === labelId)) throw new Error(tr`Подпись уже существует. Назначьте её помещению вручную.`);
  const attributes = valuesSchema.safeParse(values);
  if (!attributes.success) throw new Error(attributes.error.issues[0]?.message ?? tr`Проверьте свойства помещения.`);
  const parsed = wallRoomLabelSchema.safeParse({ id: existing?.id ?? labelId, ...attributes.data, anchor: room.labelPoint, boundaryWallIds });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? tr`Проверьте название, назначение и цвет помещения.`);
  const label = parsed.data;
  if (existing && existing.name === label.name && existing.kind === label.kind && existing.color === label.color) return plan;
  return validateBinding({ ...plan, wallRoomLabels: existing ? plan.wallRoomLabels.map((item) => item.id === existing.id ? label : item) : [...plan.wallRoomLabels, label] }, room, label.id);
}

export function assignWallRoomLabel(plan: FloorPlan, labelId: string, snapshot: WallRoom): FloorPlan {
  const { room, boundaryWallIds } = currentRoom(plan, snapshot);
  const label = plan.wallRoomLabels.find((item) => item.id === labelId);
  if (!label) throw new Error(tr`Подпись помещения не найдена.`);
  if (room.labelId || !resolveWallRoomLabels(plan).unassigned.some((item) => item.id === labelId)) throw new Error(tr`Подпись или помещение уже связаны. Обновите выбор.`);
  return validateBinding({ ...plan, wallRoomLabels: plan.wallRoomLabels.map((item) => item.id === labelId ? { ...item, anchor: room.labelPoint, boundaryWallIds } : item) }, room, labelId);
}

export function removeWallRoomLabel(plan: FloorPlan, labelId: string): FloorPlan {
  if (!plan.wallRoomLabels.some((label) => label.id === labelId)) throw new Error(tr`Подпись помещения не найдена.`);
  return validate({ ...plan, wallRoomLabels: plan.wallRoomLabels.filter((label) => label.id !== labelId) });
}

/** Rebase safe bindings inside the same geometry transaction; orphan records stay untouched. */
export function reconcileWallRoomLabels(previous: FloorPlan, next: FloorPlan): FloorPlan {
  if (next === previous || next.roomMode !== "walls" || !next.wallRoomLabels.length) return next;
  let result: ReturnType<typeof resolve>;
  try {
    result = resolve(next);
  } catch {
    // The rooms cannot be computed (an opened project may be like that): the labels stay
    // exactly as saved, nothing is dropped, and the editor reports the cause.
    return next;
  }
  let changed = false;
  const labels = next.wallRoomLabels.map((label) => {
    const index = result.rooms.findIndex((room) => room.labelId === label.id);
    if (index < 0) return label;
    const room = result.rooms[index], ids = result.supports[index];
    if (samePoint(label.anchor, room.labelPoint) && sameIds(label.boundaryWallIds, ids)) return label;
    changed = true;
    return { ...label, anchor: { ...room.labelPoint }, boundaryWallIds: [...ids] };
  });
  return changed ? { ...next, wallRoomLabels: labels } : next;
}
