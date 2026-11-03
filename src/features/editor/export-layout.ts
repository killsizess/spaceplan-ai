import type { Point } from "@/domain/geometry";
import { floorPlanSchema } from "@/domain/floor-plan/schema";
import type { FloorPlan, Opening, Room, Wall } from "@/domain/floor-plan/types";
import { DEFAULT_DOOR_SWING, doorSwingLocal, doorSwingWorld } from "@/domain/floor-plan/door-swing";
import { resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import { wallFootprint, type WallRoom } from "@/domain/floor-plan/wall-rooms";
import { readableRoomInk } from "@/lib/color-contrast";
import { formatArea } from "@/lib/format";
import { getRoomDimensionLayout, type DimensionLabel, type RoomDimensionLayout } from "./room-dimensions";

export type PlanExportOptions = {
  orientation: "landscape" | "portrait";
  scale: "auto" | number;
  dimensions: boolean;
};

export const DEFAULT_EXPORT_OPTIONS: PlanExportOptions = {
  orientation: "landscape",
  scale: "auto",
  dimensions: true,
};

export interface PlanExportLayout {
  svg: string;
  widthMm: number;
  heightMm: number;
  scaleDenominator: number;
  roomCount: number;
  totalArea: number;
  warnings: string[];
}

type Bounds = WallRoom["bounds"];
type Box = { x: number; y: number; width: number; height: number };
type MapPoint = (point: Point) => Point;
type DoorStroke = { points: readonly Point[]; halfWidthMm: number; bounds: Bounds };
type CompactDimension = Extract<RoomDimensionLayout, { kind: "compact" }>;
const EPSILON = 1e-8;
const CSS_PIXELS_PER_MM = 96 / 25.4;
const INK = "#243336";
const NICE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
const n = (value: number) => String(Number(value.toFixed(6)));
const preciseNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 8, useGrouping: false });

/** Text is never inserted as markup or used as an SVG attribute name. */
function xml(value: string): string {
  return value.toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function text(x: number, y: number, value: string, size: number, extra = ""): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" ${extra}>${xml(value)}</text>`;
}

function ringPath(points: readonly Point[], map: MapPoint): string {
  return points.map((point, index) => {
    const mapped = map(point);
    return `${index ? "L" : "M"}${n(mapped.x)} ${n(mapped.y)}`;
  }).join(" ") + " Z";
}

function manualContour(room: Room): WallRoom {
  return {
    ...room,
    outer: [
      { x: room.x, y: room.y }, { x: room.x + room.width, y: room.y },
      { x: room.x + room.width, y: room.y + room.height }, { x: room.x, y: room.y + room.height },
    ],
    holes: [],
    area: room.width * room.height,
    perimeter: 2 * (room.width + room.height),
    labelPoint: { x: room.x + room.width / 2, y: room.y + room.height / 2 },
    bounds: { minX: room.x, minY: room.y, maxX: room.x + room.width, maxY: room.y + room.height },
    boundaryWallIds: [],
  };
}

function nextNiceScale(minimum: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, minimum)));
  return NICE_STEPS.find((step) => step * magnitude >= minimum - EPSILON)! * magnitude;
}

/** Conservative Arial advances keep wide letters (Ш/W) inside the physical label box. */
function advance(character: string, size: number): number {
  if (/\s/.test(character)) return size * 0.36;
  if (/[ilI!.,:;'|]/.test(character)) return size * 0.35;
  if (/[ШЩЖЮМФшщжюмфWMwm@%]/.test(character)) return size * 1.08;
  if (/[А-ЯA-Z]/.test(character)) return size * 0.82;
  if (/[а-яa-z0-9()\-²]/.test(character)) return size * 0.67;
  return size * 1.1;
}

function estimateTextWidth(value: string, size: number): number {
  return Array.from(value).reduce((sum, character) => sum + advance(character, size), 0);
}

function prefixLength(chars: readonly string[], width: number, size: number): number {
  let used = 0, length = 0;
  for (const character of chars) {
    used += advance(character, size);
    if (used > width) break;
    length++;
  }
  return length;
}

function fitText(value: string, width: number, size: number): string {
  const chars = Array.from(value);
  if (prefixLength(chars, width, size) === chars.length) return value;
  return chars.slice(0, prefixLength(chars, width - advance("…", size), size)).join("") + "…";
}

function wrapName(value: string, width: number, size: number): { lines: string[]; shortened: boolean } {
  const remaining = Array.from(value);
  const lines: string[] = [];
  while (remaining.length && lines.length < 3) {
    const capacity = Math.max(1, prefixLength(remaining, width, size));
    if (remaining.length <= capacity) {
      lines.push(remaining.splice(0).join(""));
      break;
    }
    let end = capacity;
    const candidate = remaining.slice(0, capacity + 1);
    const space = candidate.lastIndexOf(" ");
    if (space > capacity / 2) end = space;
    lines.push(remaining.splice(0, end).join("").trim());
    while (remaining[0] === " ") remaining.shift();
  }
  if (remaining.length) lines[lines.length - 1] = fitText(lines.at(-1)! + remaining.join(""), width, size);
  return { lines, shortened: remaining.length > 0 };
}

function pointInside(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index], b = ring[(index + 1) % ring.length];
    if (a.y > point.y !== b.y > point.y && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Corners alone are insufficient: a hole or a concave edge could enter the label box. */
function insideRoom(box: Box, room: WallRoom): boolean {
  const corners = [
    { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height },
  ];
  const rings = [room.outer, ...room.holes];
  if (corners.some((point) => !pointInside(point, room.outer) || room.holes.some((hole) => pointInside(point, hole)))) return false;
  for (const ring of rings) {
    if (ring.some((point) => point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height)) return false;
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      for (let side = 0; side < 4; side++) {
        const c = corners[side], d = corners[(side + 1) % 4];
        if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
      }
    }
  }
  return true;
}

function dimensionLabel(label: DimensionLabel, map: MapPoint, mmPerMeter: number): string {
  const origin = map(label);
  const width = label.width * mmPerMeter, height = label.height * mmPerMeter;
  return `<g transform="translate(${n(origin.x)} ${n(origin.y)}) rotate(${label.rotation})">` +
    text(width / 2, height / 2, label.text, label.fontSize * mmPerMeter, 'text-anchor="middle" dominant-baseline="central"') + "</g>";
}

function dimensionsSvg(layout: RoomDimensionLayout | null, map: MapPoint, mmPerMeter: number, ink: string): string {
  if (!layout) return "";
  if (layout.kind === "compact") return `<g data-compact-dimension="true" fill="${ink}">${dimensionLabel(layout.label, map, mmPerMeter)}</g>`;
  const segments = layout.segments.map(([x1, y1, x2, y2]) => {
    const a = map({ x: x1, y: y1 }), b = map({ x: x2, y: y2 });
    return `<path d="M${n(a.x)} ${n(a.y)} L${n(b.x)} ${n(b.y)}"/>`;
  }).join("");
  return `<g fill="none" stroke="${ink}" stroke-width="${n(layout.strokeWidth * mmPerMeter)}">${segments}</g>` +
    `<g fill="${ink}">${[layout.horizontalLabel, layout.verticalLabel, layout.caption].map((label) => dimensionLabel(label, map, mmPerMeter)).join("")}</g>`;
}

/** Slab clipping includes touching strokes, even when neither endpoint is in the box. */
function segmentTouchesBox(a: Point, b: Point, box: Box): boolean {
  let enter = 0, leave = 1;
  for (const axis of ["x", "y"] as const) {
    const minimum = box[axis];
    const maximum = minimum + (axis === "x" ? box.width : box.height);
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) <= EPSILON) {
      if (a[axis] < minimum || a[axis] > maximum) return false;
      continue;
    }
    const first = (minimum - a[axis]) / delta, second = (maximum - a[axis]) / delta;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter > leave) return false;
  }
  return true;
}

function overlapsBounds(box: Box, bounds: Bounds): boolean {
  return box.x <= bounds.maxX && box.x + box.width >= bounds.minX &&
    box.y <= bounds.maxY && box.y + box.height >= bounds.minY;
}

function avoidsDoors(box: Box, strokes: readonly DoorStroke[], mmPerMeter: number): boolean {
  return strokes.every((stroke) => {
    // Leave one physical millimetre around the estimated ink, plus the stroke radius.
    const padding = (1 + stroke.halfWidthMm) / mmPerMeter;
    const padded = { x: box.x - padding, y: box.y - padding, width: box.width + 2 * padding, height: box.height + 2 * padding };
    if (!overlapsBounds(padded, stroke.bounds)) return true;
    return stroke.points.every((point, index) => index === 0 || !segmentTouchesBox(stroke.points[index - 1], point, padded));
  });
}

function labelCandidates(room: WallRoom, mmPerMeter: number): Point[] {
  const candidates = [room.labelPoint];
  for (const distanceMm of [4, 8, 12]) {
    const step = distanceMm / mmPerMeter;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      candidates.push({ x: room.labelPoint.x + dx * step, y: room.labelPoint.y + dy * step });
    }
  }
  for (const y of [0.5, 0.25, 0.75]) for (const x of [0.5, 0.25, 0.75]) {
    candidates.push({ x: room.bounds.minX + (room.bounds.maxX - room.bounds.minX) * x, y: room.bounds.minY + (room.bounds.maxY - room.bounds.minY) * y });
  }
  return candidates;
}

function placeCompactDimension(layout: CompactDimension, room: WallRoom, mmPerMeter: number, doorStrokes: readonly DoorStroke[], roomNameBox?: Box): CompactDimension | null {
  const label = layout.label;
  const center = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  const inkWidth = estimateTextWidth(label.text, label.fontSize * mmPerMeter) / mmPerMeter;
  const padding = 1 / mmPerMeter;
  const candidates = [center];
  for (const offsetMm of [4, 8, 12, 16, 20]) {
    candidates.push({ x: center.x, y: center.y - offsetMm / mmPerMeter });
    candidates.push({ x: center.x, y: center.y + offsetMm / mmPerMeter });
  }
  candidates.push({ x: center.x, y: room.bounds.minY + 5 / mmPerMeter }, ...labelCandidates(room, mmPerMeter));
  for (const candidate of candidates) {
    const inkBox = { x: candidate.x - inkWidth / 2, y: candidate.y - label.height / 2, width: inkWidth, height: label.height };
    const padded = { x: inkBox.x - padding, y: inkBox.y - padding, width: inkBox.width + 2 * padding, height: inkBox.height + 2 * padding };
    if (!insideRoom(padded, room) || !avoidsDoors(inkBox, doorStrokes, mmPerMeter)) continue;
    if (roomNameBox && overlapsBounds(padded, { minX: roomNameBox.x, minY: roomNameBox.y, maxX: roomNameBox.x + roomNameBox.width, maxY: roomNameBox.y + roomNameBox.height })) continue;
    return { ...layout, label: { ...label, x: candidate.x - label.width / 2, y: candidate.y - label.height / 2 } };
  }
  return null;
}

function roomLabel(room: WallRoom, dimension: RoomDimensionLayout | null, map: MapPoint, mmPerMeter: number, doorStrokes: readonly DoorStroke[]): { svg: string; hidden: boolean; shortened: boolean; inkBox?: Box } {
  const size = 3;
  const bounds = room.bounds;
  const relevantDoors = doorStrokes.filter((stroke) => overlapsBounds({
    x: bounds.minX - 1.3 / mmPerMeter, y: bounds.minY - 1.3 / mmPerMeter,
    width: bounds.maxX - bounds.minX + 2.6 / mmPerMeter,
    height: bounds.maxY - bounds.minY + 2.6 / mmPerMeter,
  }, stroke.bounds));
  const area = formatArea(room.area);
  for (const candidate of labelCandidates(room, mmPerMeter)) {
    const center = map(candidate);
    let width = Math.min(56, 2 * Math.min(candidate.x - bounds.minX, bounds.maxX - candidate.x) * mmPerMeter - 5);
    if (dimension?.kind === "lines") width = Math.min(width, 2 * ((bounds.maxX - candidate.x) * mmPerMeter - 11));
    for (; width >= 16; width -= 2) {
      const wrapped = wrapName(room.name, width, size);
      const height = wrapped.lines.length * 4 + 4;
      const inkWidth = Math.max(estimateTextWidth(area, 2.8), ...wrapped.lines.map((line) => estimateTextWidth(line, size)));
      const inkBox = { x: candidate.x - inkWidth / mmPerMeter / 2, y: candidate.y - height / mmPerMeter / 2, width: inkWidth / mmPerMeter, height: height / mmPerMeter };
      const box = { x: inkBox.x - 1 / mmPerMeter, y: inkBox.y - 1 / mmPerMeter, width: inkBox.width + 2 / mmPerMeter, height: inkBox.height + 2 / mmPerMeter };
      if (!insideRoom(box, room)) continue;
      const topMm = map({ x: box.x, y: box.y }).y;
      const bottomMm = topMm + box.height * mmPerMeter;
      if (dimension?.kind === "lines" && topMm < map({ x: bounds.minX, y: bounds.minY }).y + 11) continue;
      if (dimension?.kind === "compact" && bottomMm > map({ x: bounds.maxX, y: bounds.maxY }).y - 8) continue;
      if (!avoidsDoors(inkBox, relevantDoors, mmPerMeter)) continue;
      const ink = readableRoomInk(room.color, INK);
      const start = center.y - height / 2 + 3;
      const names = wrapped.lines.map((line, index) => text(center.x, start + index * 4, line, size, 'font-weight="600"')).join("");
      return { svg: `<g data-room-label="true" fill="${ink}" text-anchor="middle">${names}${text(center.x, start + wrapped.lines.length * 4, area, 2.8)}</g>`, hidden: false, shortened: wrapped.shortened, inkBox };
    }
  }
  return { svg: "", hidden: true, shortened: false };
}

function openingSvg(wall: Wall, opening: Opening, map: MapPoint, mmPerMeter: number): string {
  const { offset, width, kind } = opening;
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const ux = (wall.end.x - wall.start.x) / length, uy = (wall.end.y - wall.start.y) / length;
  const start = map({ x: wall.start.x + ux * offset, y: wall.start.y + uy * offset });
  const angle = Math.atan2(uy, ux) * 180 / Math.PI;
  const w = width * mmPerMeter, t = wall.thickness * mmPerMeter;
  const swing = doorSwingLocal(opening);
  const door = opening.door ?? DEFAULT_DOOR_SWING;
  const symbol = !swing
    ? `<path d="M0 ${n(-t / 4)} H${n(w)} M0 ${n(t / 4)} H${n(w)}" fill="none" stroke="#377a93" stroke-width="0.3"/>`
    : `<path data-door-leaf="true" d="M${n(swing.hinge.x * mmPerMeter)} 0 L${n(swing.openEnd.x * mmPerMeter)} ${n(swing.openEnd.y * mmPerMeter)}" fill="none" stroke="#8f6748" stroke-width="0.45"/>` +
      `<polyline data-door-arc="true" points="${swing.arc.map((point) => `${n(point.x * mmPerMeter)},${n(point.y * mmPerMeter)}`).join(" ")}" fill="none" stroke="#8f6748" stroke-width="0.25" stroke-dasharray="1.1 0.7"/>`;
  const orientation = kind === "door" ? ` data-hinge="${door.hinge}" data-side="${door.side}"` : "";
  return `<g data-opening="${kind}"${orientation} transform="translate(${n(start.x)} ${n(start.y)}) rotate(${n(angle)})"><rect x="0" y="${n(-t / 2)}" width="${n(w)}" height="${n(t)}" fill="#ffffff"/>${symbol}<path d="M0 ${n(-t / 2)} V${n(t / 2)} M${n(w)} ${n(-t / 2)} V${n(t / 2)}" stroke="${INK}" stroke-width="0.2"/></g>`;
}

/** A 2D cut belongs only to its wall; it never removes another wall at a crossing. */
function solidWallFootprints(wall: Wall, openings: readonly Opening[]): Point[][] {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const ux = (wall.end.x - wall.start.x) / length, uy = (wall.end.y - wall.start.y) / length;
  const segments: Point[][] = [];
  const pointAt = (offset: number): Point => offset === 0 ? wall.start : offset === length ? wall.end : {
    x: wall.start.x + ux * offset, y: wall.start.y + uy * offset,
  };
  const append = (start: number, end: number) => {
    // Ignore only the same sub-nanometre boundary noise accepted by the domain.
    if (end - start <= 1e-9) return;
    const segment = {
      ...wall,
      start: pointAt(start),
      end: pointAt(end),
    };
    segments.push(wallFootprint(segment)[0].map(([x, y]) => ({ x, y })));
  };
  let cursor = 0;
  for (const opening of openings.filter((candidate) => candidate.wallId === wall.id).sort((a, b) => a.offset - b.offset)) {
    const start = Math.min(length, Math.max(cursor, opening.offset));
    append(cursor, start);
    cursor = Math.max(cursor, Math.min(length, opening.offset + opening.width));
  }
  append(cursor, length);
  return segments;
}

/** Standalone physical sheet; no canvas camera, DOM, image URLs or editor state is read. */
export function createPlanExportLayout(plan: FloorPlan, options: PlanExportOptions): PlanExportLayout {
  if ((options.orientation !== "landscape" && options.orientation !== "portrait") ||
    typeof options.dimensions !== "boolean" ||
    (options.scale !== "auto" && (!Number.isFinite(options.scale) || options.scale < 1 || options.scale > 1_000_000))) {
    throw new Error("Проверьте ориентацию и масштаб экспорта: знаменатель масштаба — от 1 до 1 000 000.");
  }
  if (!floorPlanSchema.safeParse(plan).success) throw new Error("План содержит некорректные данные. Исправьте их перед экспортом.");
  const resolution = resolveWallRoomLabels(plan);
  const rooms = plan.roomMode === "walls" ? resolution.rooms : plan.rooms.map(manualContour);
  const footprints = plan.walls.map((wall) => wallFootprint(wall)[0].map(([x, y]) => ({ x, y })));
  const wallsById = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const points = [...rooms.flatMap((room) => room.outer), ...footprints.flat()];
  const doorStrokes: DoorStroke[] = [];
  for (const opening of plan.openings) {
    const swing = doorSwingWorld(wallsById.get(opening.wallId)!, opening);
    if (swing) {
      points.push(
        { x: swing.bounds.minX, y: swing.bounds.minY },
        { x: swing.bounds.maxX, y: swing.bounds.maxY },
      );
      doorStrokes.push(
        { points: [swing.hinge, swing.openEnd], halfWidthMm: 0.225, bounds: swing.bounds },
        { points: swing.arc, halfWidthMm: 0.125, bounds: swing.bounds },
      );
    }
  }
  if (!points.length) throw new Error("План пуст. Добавьте комнату или стену перед экспортом.");
  const bounds: Bounds = points.reduce((result, point) => ({ minX: Math.min(result.minX, point.x), minY: Math.min(result.minY, point.y), maxX: Math.max(result.maxX, point.x), maxY: Math.max(result.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const widthMm = options.orientation === "landscape" ? 297 : 210;
  const heightMm = options.orientation === "landscape" ? 210 : 297;
  // Four millimetres of air surround all physical geometry, including thick/diagonal walls.
  const drawing: Box = { x: 16, y: 37, width: widthMm - 32, height: heightMm - 77 };
  const worldWidth = bounds.maxX - bounds.minX, worldHeight = bounds.maxY - bounds.minY;
  const minimum = Math.max(worldWidth * 1000 / drawing.width, worldHeight * 1000 / drawing.height);
  const scaleDenominator = options.scale === "auto" ? nextNiceScale(minimum) : options.scale;
  const mmPerMeter = 1000 / scaleDenominator;
  if (worldWidth * mmPerMeter > drawing.width + EPSILON || worldHeight * mmPerMeter > drawing.height + EPSILON) {
    throw new Error(`План не помещается на A4 в масштабе 1:${preciseNumber.format(scaleDenominator)}. Выберите «Подобрать под лист» или уменьшите масштаб.`);
  }
  const map: MapPoint = (point) => ({ x: drawing.x + (drawing.width - worldWidth * mmPerMeter) / 2 + (point.x - bounds.minX) * mmPerMeter, y: drawing.y + (drawing.height - worldHeight * mmPerMeter) / 2 + (point.y - bounds.minY) * mmPerMeter });
  const warnings = [...resolution.warnings];
  if (plan.underlay) warnings.push("Подложка не включается в экспорт: на листе показана редактируемая геометрия.");
  if (plan.roomMode === "walls" && !rooms.length) warnings.push("Замкнутые помещения не найдены. На листе показаны стены и проёмы; площадь равна нулю.");
  if (plan.roomMode === "walls" && resolution.unassigned.length) warnings.push("Непривязанные названия помещений не включены в лист.");
  const fills = rooms.map((room) => `<path data-room="true" d="${[room.outer, ...room.holes].map((ring) => ringPath(ring, map)).join(" ")}" fill="${room.color}" fill-rule="evenodd" stroke="#83918e" stroke-width="0.2"/>`).join("");
  const walls = plan.walls.flatMap((wall) => solidWallFootprints(wall, plan.openings)
    .map((ring) => `<path data-wall="true" d="${ringPath(ring, map)}" data-wall-id="${xml(wall.id)}" fill="${INK}"/>`)).join("");
  const openings = plan.openings.map((opening) => openingSvg(wallsById.get(opening.wallId)!, opening, map, mmPerMeter)).join("");
  let hiddenLabels = 0, shortenedNames = 0, visibleDimensions = 0;
  const annotations = rooms.map((room) => {
    let dimension = options.dimensions ? getRoomDimensionLayout(room, mmPerMeter * CSS_PIXELS_PER_MM) : null;
    const label = roomLabel(room, dimension, map, mmPerMeter, doorStrokes);
    if (dimension?.kind === "compact") dimension = placeCompactDimension(dimension, room, mmPerMeter, doorStrokes, label.inkBox);
    if (dimension) visibleDimensions++;
    if (label.hidden) hiddenLabels++;
    if (label.shortened) shortenedNames++;
    return dimensionsSvg(dimension, map, mmPerMeter, readableRoomInk(room.color, INK)) + label.svg;
  }).join("");
  if (hiddenLabels) warnings.push(`Подписи ${hiddenLabels} помещений скрыты: при выбранном масштабе внутри контура недостаточно места.`);
  if (shortenedNames) warnings.push(`Названия ${shortenedNames} помещений сокращены на листе. Полные названия сохраняются в проекте и JSON.`);
  if (options.dimensions && visibleDimensions < rooms.length) warnings.push("Внутренние размеры показаны только у прямоугольных помещений, где для них достаточно места.");
  const title = fitText(plan.name, widthMm - 24, 5);
  if (title !== plan.name) warnings.push("Название проекта сокращено в заголовке листа.");
  const totalArea = rooms.reduce((sum, room) => sum + room.area, 0);
  const mode = plan.roomMode === "walls" ? "Помещения по стенам" : "Ручные комнаты";
  const scaleTarget = 38 / mmPerMeter;
  const scalePower = 10 ** Math.floor(Math.log10(scaleTarget));
  const scaleMeters = [1, 2, 2.5, 5, 10].filter((step) => step * scalePower <= scaleTarget + EPSILON).at(-1)! * scalePower;
  const barWidth = scaleMeters * mmPerMeter;
  const barX = widthMm - 78, barY = heightMm - 20;
  const footerLeftWidth = widthMm - 104;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}" role="img" aria-label="План помещений на листе A4">` +
    `<rect width="${widthMm}" height="${heightMm}" fill="#ffffff"/><g font-family="Arial, Helvetica, sans-serif" fill="${INK}">` +
    text(12, 18, title, 5, 'font-weight="700"') +
    text(12, 25, `SpacePlan AI · ${mode} · ${rooms.length} помещ. · метры`, 3) +
    `<path d="M12 30 H${widthMm - 12} M12 ${heightMm - 32} H${widthMm - 12}" stroke="#c6d1cd" stroke-width="0.25"/>` +
    `<g data-plan="true" data-mm-per-meter="${n(mmPerMeter)}">${fills}${openings}${walls}${annotations}</g>` +
    text(12, heightMm - 25, fitText(`Общая площадь: ${formatArea(totalArea)}`, footerLeftWidth, 3.5), 3.5, 'font-weight="600"') +
    text(12, heightMm - 19, fitText(mode, footerLeftWidth, 2.7), 2.7) +
    text(12, heightMm - 13, options.dimensions ? "Размеры внутри помещений, м" : "Размеры скрыты", 2.7) +
    `<path d="M12 ${heightMm - 7} v-3 M12 ${heightMm - 10} A3 3 0 0 1 15 ${heightMm - 7}" fill="none" stroke="#8f6748" stroke-width="0.3"/>` + text(19, heightMm - 6, "дверь", 2.5) +
    `<path d="M35 ${heightMm - 7.5} h5 M35 ${heightMm - 6.5} h5" stroke="#377a93" stroke-width="0.3"/>` + text(42, heightMm - 6, "окно", 2.5) +
    text(barX, heightMm - 26, `Масштаб 1:${preciseNumber.format(scaleDenominator)}`, 3, 'font-weight="600"') +
    `<path data-scale-bar="true" d="M${n(barX)} ${n(barY - 1.5)} V${n(barY + 1.5)} M${n(barX)} ${n(barY)} H${n(barX + barWidth)} M${n(barX + barWidth)} ${n(barY - 1.5)} V${n(barY + 1.5)}" stroke="${INK}" stroke-width="0.35"/>` +
    text(barX, barY + 5, "0", 2.5) + text(barX + barWidth, barY + 5, `${preciseNumber.format(scaleMeters)} м`, 2.5, 'text-anchor="end"') +
    text(barX, heightMm - 8, "Печатать A4, масштаб 100%", 2.5) + "</g></svg>";
  return { svg, widthMm, heightMm, scaleDenominator, roomCount: rooms.length, totalArea, warnings: [...new Set(warnings)] };
}
