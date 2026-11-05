import { currentLocale, tr } from "@/lib/i18n";
import type { Point } from "@/domain/geometry";
import type { CurvePolyline } from "./opening-candidates";
import type { LineSegment } from "./wall-candidates";

/**
 * Reads the geometry of an ASCII DXF drawing: pure, no DOM, no dependencies.
 *
 * Read: LINE, LWPOLYLINE and POLYLINE (with bulges), MLINE, ARC, CIRCLE, ELLIPSE, and
 * INSERT with nested blocks, scale, rotation, arrays and the mirror an extrusion of
 * (0, 0, −1) means. Not read, and reported: SPLINE and external references. Ignored as
 * not being plan geometry: text, dimensions, hatches, points, paper space.
 *
 * Coordinates stay in drawing units with Y upwards until `dxfGeometry` turns the chosen
 * layers into plan metres. Nothing here decides what is a wall.
 */

export const MAX_DXF_FILE_BYTES = 30 * 1024 * 1024;
/** After blocks are expanded; a drawing past this is reported as cut. */
export const MAX_DXF_ENTITIES = 200_000;
const MAX_BLOCK_DEPTH = 8;
const MAX_ARRAY_COPIES = 1000;
/** Arcs are sampled about every 11°, so a door swing keeps enough points to be recognised. */
const ARC_STEP = Math.PI / 16;

export interface DxfUnits {
  /** The value of $INSUNITS; 0 when the file does not say. */
  code: number;
  /** Null when the file does not say: the user has to choose, it is never assumed. */
  metresPerUnit: number | null;
  label: string;
}

export interface DxfLayer {
  name: string;
  segments: number;
  curves: number;
  /** False when the layer is off or frozen in the file. */
  visible: boolean;
}

export interface DxfDrawing {
  version: string | null;
  units: DxfUnits;
  layers: DxfLayer[];
  segments: (LineSegment & { layer: string })[];
  curves: (CurvePolyline & { layer: string })[];
  warnings: string[];
  truncated: boolean;
}

export const DXF_UNIT_CHOICES: readonly { label: string; metresPerUnit: number }[] = [
  { label: tr`миллиметры`, metresPerUnit: 0.001 },
  { label: tr`сантиметры`, metresPerUnit: 0.01 },
  { label: tr`дециметры`, metresPerUnit: 0.1 },
  { label: tr`метры`, metresPerUnit: 1 },
  { label: tr`дюймы`, metresPerUnit: 0.0254 },
  { label: tr`футы`, metresPerUnit: 0.3048 },
];

function unitsOf(code: number): DxfUnits {
  const known: Record<number, [number, string]> = {
    1: [0.0254, tr`дюймы`],
    2: [0.3048, tr`футы`],
    4: [0.001, tr`миллиметры`],
    5: [0.01, tr`сантиметры`],
    6: [1, tr`метры`],
    10: [0.9144, tr`ярды`],
    14: [0.1, tr`дециметры`],
  };
  const unit = known[code];
  return unit
    ? { code, metresPerUnit: unit[0], label: unit[1] }
    : { code, metresPerUnit: null, label: tr`не указаны в файле` };
}

/**
 * Text of a DXF file. Files since AutoCAD 2007 are UTF-8; older ones carry their code
 * page in the header, which matters for Cyrillic layer names. DWG and binary DXF cannot
 * be read here and say so instead of failing strangely.
 */
export function decodeDxf(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
  if (/^AC10\d\d/.test(head)) {
    throw new Error(tr`Это файл DWG. Сохраните чертёж как DXF (ASCII) в вашей CAD-программе и загрузите его.`);
  }
  if (head.startsWith("AutoCAD Binary DXF")) {
    throw new Error(tr`Это двоичный DXF. Сохраните чертёж как текстовый DXF (ASCII) и загрузите его.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    const page = /\$DWGCODEPAGE\s+3\s+ANSI_(\d+)/.exec(head)?.[1] ?? "1251";
    try {
      return new TextDecoder(`windows-${page}`).decode(bytes);
    } catch {
      return new TextDecoder("windows-1251").decode(bytes);
    }
  }
}

/** Older files write non-ASCII letters as \U+0410. */
const unescapeText = (value: string) =>
  value.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

type Pair = readonly [number, string];
type MutablePoint = { x: number; y: number };
interface Vertex {
  p: MutablePoint;
  bulge: number;
}

class Reader {
  private at = 0;
  private line = 0;
  private currentCode = -1;
  private currentValue = "";
  private held = false;
  constructor(private readonly text: string) {}
  private readLine(): string | null {
    if (this.at >= this.text.length) return null;
    let end = this.text.indexOf("\n", this.at);
    if (end < 0) end = this.text.length;
    const line = this.text.slice(this.at, end).trim();
    this.at = end + 1;
    this.line++;
    return line;
  }
  /** Moves to the next pair; false at the end of the file. */
  next(): boolean {
    if (this.held) {
      this.held = false;
      return true;
    }
    const code = this.readLine();
    if (code === null) return false;
    const value = this.readLine();
    if (value === null) return false;
    // Blank lines at the end of a file are harmless.
    if (code === "" && value === "") return this.next();
    const parsed = Number(code);
    if (code === "" || !Number.isInteger(parsed)) {
      throw new Error(tr`Файл не похож на текстовый DXF: строка ${this.line - 1} должна содержать код группы.`);
    }
    this.currentCode = parsed;
    this.currentValue = value;
    return true;
  }
  // Methods, not fields: a value read before `next()` must not stay narrowed after it.
  code(): number {
    return this.currentCode;
  }
  value(): string {
    return this.currentValue;
  }
  /** The pair just read is read again by the next `next()`. */
  hold() {
    this.held = true;
  }
  /** Reads the pairs of the current entity, up to the next code 0. */
  body(): Pair[] {
    const pairs: Pair[] = [];
    while (this.next()) {
      if (this.currentCode === 0) {
        this.hold();
        break;
      }
      pairs.push([this.currentCode, this.currentValue]);
    }
    return pairs;
  }
}

/** a, b, c, d, e, f: x' = a·x + c·y + e, y' = b·x + d·y + f */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

interface LocalLine {
  layer: string;
  a: Point;
  b: Point;
}
interface LocalCurve {
  layer: string;
  points: Point[];
}
interface LocalInsert {
  layer: string;
  name: string;
  /** The placement of one copy, in the coordinates of its container. */
  matrices: Matrix[];
}
interface Container {
  lines: LocalLine[];
  curves: LocalCurve[];
  inserts: LocalInsert[];
  base: Point;
}

const emptyContainer = (base: Point = { x: 0, y: 0 }): Container => ({ lines: [], curves: [], inserts: [], base });

function number(pairs: readonly Pair[], code: number, fallback = 0): number {
  for (const [key, value] of pairs) {
    if (key === code) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }
  return fallback;
}
function text(pairs: readonly Pair[], code: number, fallback = ""): string {
  for (const [key, value] of pairs) if (key === code) return value;
  return fallback;
}

/** An extrusion of (0, 0, −1) is a mirror in X, which is what mirrored CAD blocks store. */
const mirrored = (pairs: readonly Pair[]) => number(pairs, 230, 1) < 0;
const flipIf = (flip: boolean, p: Point): Point => (flip ? { x: -p.x, y: p.y } : p);

function arcPoints(cx: number, cy: number, r: number, from: number, sweep: number): Point[] {
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = from + (sweep * i) / steps;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

/** The arc a polyline bulge draws from a to b. A positive bulge runs counter-clockwise. */
function bulgePoints(a: Point, b: Point, bulge: number): Point[] {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(d > 0)) return [a];
  const theta = 4 * Math.atan(bulge);
  const h = d / (2 * Math.tan(theta / 2));
  const cx = (a.x + b.x) / 2 + (-(b.y - a.y) / d) * h;
  const cy = (a.y + b.y) / 2 + ((b.x - a.x) / d) * h;
  const from = Math.atan2(a.y - cy, a.x - cx);
  const points = arcPoints(cx, cy, Math.hypot(a.x - cx, a.y - cy), from, theta);
  // The ends are the polyline's own vertices, exactly.
  points[0] = a;
  points[points.length - 1] = b;
  return points;
}

/** Vertices with bulges become straight lines and curve chains. */
function addPolyline(
  into: Container,
  layer: string,
  vertices: readonly { p: Point; bulge: number }[],
  closed: boolean,
  flip: boolean,
) {
  const count = closed ? vertices.length : vertices.length - 1;
  let chain: Point[] | null = null;
  const endChain = () => {
    if (chain) into.curves.push({ layer, points: chain });
    chain = null;
  };
  for (let i = 0; i < count; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    if (Math.abs(a.bulge) > 1e-9) {
      const points = bulgePoints(a.p, b.p, a.bulge).map((p) => flipIf(flip, p));
      if (chain) chain.push(...points.slice(1));
      else chain = points;
    } else {
      endChain();
      if (a.p.x !== b.p.x || a.p.y !== b.p.y) into.lines.push({ layer, a: flipIf(flip, a.p), b: flipIf(flip, b.p) });
    }
  }
  endChain();
}

function lwpolyline(pairs: readonly Pair[]): Vertex[] {
  const vertices: Vertex[] = [];
  for (const [code, value] of pairs) {
    const parsed = Number(value);
    if (code === 10) vertices.push({ p: { x: parsed, y: 0 }, bulge: 0 });
    else if (code === 20 && vertices.length) vertices[vertices.length - 1].p.y = parsed;
    else if (code === 42 && vertices.length) vertices[vertices.length - 1].bulge = parsed;
  }
  return vertices.filter((v) => Number.isFinite(v.p.x) && Number.isFinite(v.p.y));
}

/** A multiline: each element runs through its vertices, shifted along the miter by its own offset. */
function mline(into: Container, layer: string, pairs: readonly Pair[]) {
  const vertices: { p: MutablePoint; miter: MutablePoint; offsets: number[] }[] = [];
  const closed = (number(pairs, 71) & 2) !== 0;
  let reading: "none" | "params" = "none";
  let left = 0;
  let element: number[] | null = null;
  for (const [code, value] of pairs) {
    const parsed = Number(value);
    const last = vertices[vertices.length - 1];
    if (code === 11) vertices.push({ p: { x: parsed, y: 0 }, miter: { x: 0, y: 0 }, offsets: [] });
    else if (code === 21 && last) last.p.y = parsed;
    else if (code === 13 && last) last.miter.x = parsed;
    else if (code === 23 && last) last.miter.y = parsed;
    else if (code === 74) {
      if (parsed > 0) {
        reading = "params";
        left = parsed;
        element = [];
      } else if (last) {
        last.offsets.push(0);
      }
    } else if (code === 41 && reading === "params" && element) {
      element.push(parsed);
      left--;
      if (left <= 0) {
        if (last) last.offsets.push(element[0] ?? 0);
        reading = "none";
        element = null;
      }
    }
  }
  const elements = vertices[0]?.offsets.length ?? 0;
  for (let e = 0; e < elements; e++) {
    const points = vertices.map((v) => ({
      p: { x: v.p.x + v.miter.x * (v.offsets[e] ?? 0), y: v.p.y + v.miter.y * (v.offsets[e] ?? 0) },
      bulge: 0,
    }));
    addPolyline(into, layer, points, closed, false);
  }
}

interface Counters {
  splines: number;
  xrefs: Set<string>;
  missingBlocks: Set<string>;
}

function readEntity(
  type: string,
  pairs: readonly Pair[],
  reader: Reader,
  into: Container,
  counters: Counters,
  skipPaperSpace: boolean,
) {
  if (skipPaperSpace && number(pairs, 67) === 1) {
    // A polyline's vertices follow it; skip them with it.
    if (type === "POLYLINE") readPolylineVertices(reader);
    return;
  }
  const layer = unescapeText(text(pairs, 8, "0"));
  const flip = mirrored(pairs);
  switch (type) {
    case "LINE": {
      const a = { x: number(pairs, 10), y: number(pairs, 20) }, b = { x: number(pairs, 11), y: number(pairs, 21) };
      if (a.x !== b.x || a.y !== b.y) into.lines.push({ layer, a, b });
      break;
    }
    case "LWPOLYLINE":
      addPolyline(into, layer, lwpolyline(pairs), (number(pairs, 70) & 1) !== 0, flip);
      break;
    case "POLYLINE": {
      const vertices = readPolylineVertices(reader);
      const flags = number(pairs, 70);
      // Polygon and polyface meshes are not plan lines.
      if (!(flags & 16) && !(flags & 64)) addPolyline(into, layer, vertices, (flags & 1) !== 0, flip);
      break;
    }
    case "MLINE":
      mline(into, layer, pairs);
      break;
    case "ARC": {
      const start = (number(pairs, 50) * Math.PI) / 180;
      let end = (number(pairs, 51) * Math.PI) / 180;
      if (end <= start) end += 2 * Math.PI;
      const points = arcPoints(number(pairs, 10), number(pairs, 20), number(pairs, 40), start, end - start);
      into.curves.push({ layer, points: points.map((p) => flipIf(flip, p)) });
      break;
    }
    case "CIRCLE": {
      const points = arcPoints(number(pairs, 10), number(pairs, 20), number(pairs, 40), 0, 2 * Math.PI);
      into.curves.push({ layer, points: points.map((p) => flipIf(flip, p)) });
      break;
    }
    case "ELLIPSE": {
      const cx = number(pairs, 10), cy = number(pairs, 20), mx = number(pairs, 11), my = number(pairs, 21);
      const ratio = number(pairs, 40, 1), from = number(pairs, 41), to = number(pairs, 42, 2 * Math.PI);
      const sweep = to > from ? to - from : to - from + 2 * Math.PI;
      const steps = Math.max(4, Math.ceil(sweep / ARC_STEP));
      const points: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = from + (sweep * i) / steps;
        points.push(flipIf(flip, {
          x: cx + mx * Math.cos(t) - my * ratio * Math.sin(t),
          y: cy + my * Math.cos(t) + mx * ratio * Math.sin(t),
        }));
      }
      into.curves.push({ layer, points });
      break;
    }
    case "INSERT": {
      const name = unescapeText(text(pairs, 2));
      const x = number(pairs, 10), y = number(pairs, 20);
      const sx = number(pairs, 41, 1), sy = number(pairs, 42, 1);
      const rotation = (number(pairs, 50) * Math.PI) / 180;
      const cols = Math.max(1, number(pairs, 70, 1)), rows = Math.max(1, number(pairs, 71, 1));
      const dx = number(pairs, 44), dy = number(pairs, 45);
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      const matrices: Matrix[] = [];
      for (let row = 0; row < rows && matrices.length < MAX_ARRAY_COPIES; row++) {
        for (let col = 0; col < cols && matrices.length < MAX_ARRAY_COPIES; col++) {
          const ox = dx * col, oy = dy * row;
          const placed: Matrix = [cos * sx, sin * sx, -sin * sy, cos * sy, x + cos * ox - sin * oy, y + sin * ox + cos * oy];
          matrices.push(flip ? multiply([-1, 0, 0, 1, 0, 0], placed) : placed);
        }
      }
      into.inserts.push({ layer, name, matrices });
      break;
    }
    case "SPLINE":
      counters.splines++;
      break;
    default:
      break;
  }
}

function readPolylineVertices(reader: Reader): Vertex[] {
  const vertices: Vertex[] = [];
  while (reader.next()) {
    if (reader.code() !== 0) continue;
    if (reader.value() === "VERTEX") {
      const pairs = reader.body();
      // Spline frame points (flag 16) are not on the line.
      if (!(number(pairs, 70) & 16)) {
        vertices.push({ p: { x: number(pairs, 10), y: number(pairs, 20) }, bulge: number(pairs, 42) });
      }
    } else if (reader.value() === "SEQEND") {
      reader.body();
      break;
    } else {
      reader.hold();
      break;
    }
  }
  return vertices;
}

/** Parses an ASCII DXF text. Throws a message for the user when it is not one. */
export function parseDxf(source: string): DxfDrawing {
  const reader = new Reader(source);
  const tableLayers = new Map<string, boolean>();
  const blocks = new Map<string, Container>();
  const xrefBlocks = new Set<string>();
  const model = emptyContainer();
  const counters: Counters = { splines: 0, xrefs: new Set(), missingBlocks: new Set() };
  let version: string | null = null;
  let insUnits = 0;
  let sawEntities = false;

  while (reader.next()) {
    if (reader.code() !== 0 || reader.value() !== "SECTION") continue;
    if (!reader.next() || reader.code() !== 2) continue;
    const section = reader.value();
    if (section === "HEADER") {
      let variable = "";
      while (reader.next()) {
        if (reader.code() === 0 && reader.value() === "ENDSEC") break;
        if (reader.code() === 9) variable = reader.value();
        else if (variable === "$ACADVER" && reader.code() === 1) version = reader.value();
        else if (variable === "$INSUNITS" && reader.code() === 70) insUnits = Number(reader.value()) || 0;
      }
    } else if (section === "TABLES") {
      while (reader.next()) {
        if (reader.code() !== 0) continue;
        if (reader.value() === "ENDSEC") break;
        if (reader.value() === "LAYER") {
          const pairs = reader.body();
          const name = unescapeText(text(pairs, 2));
          if (name) tableLayers.set(name, !(number(pairs, 70) & 1) && number(pairs, 62, 7) >= 0);
        }
      }
    } else if (section === "BLOCKS") {
      let block: Container | null = null;
      while (reader.next()) {
        if (reader.code() !== 0) continue;
        if (reader.value() === "ENDSEC") break;
        const type = reader.value();
        const pairs = reader.body();
        if (type === "BLOCK") {
          const name = unescapeText(text(pairs, 2));
          block = emptyContainer({ x: number(pairs, 10), y: number(pairs, 20) });
          blocks.set(name, block);
          if (number(pairs, 70) & 4) xrefBlocks.add(name);
        } else if (type === "ENDBLK") {
          block = null;
        } else if (block) {
          readEntity(type, pairs, reader, block, counters, false);
        }
      }
    } else if (section === "ENTITIES") {
      sawEntities = true;
      while (reader.next()) {
        if (reader.code() !== 0) continue;
        if (reader.value() === "ENDSEC") break;
        const type = reader.value();
        const pairs = reader.body();
        readEntity(type, pairs, reader, model, counters, true);
      }
    } else {
      while (reader.next()) if (reader.code() === 0 && reader.value() === "ENDSEC") break;
    }
  }
  if (!sawEntities) {
    throw new Error(tr`Файл не похож на чертёж DXF: в нём нет раздела с объектами.`);
  }

  const segments: DxfDrawing["segments"] = [];
  const curves: DxfDrawing["curves"] = [];
  let truncated = false;
  const emit = (container: Container, matrix: Matrix, inherited: string | null, depth: number) => {
    const layerOf = (layer: string) => (layer === "0" && inherited ? inherited : layer);
    for (const line of container.lines) {
      if (segments.length + curves.length >= MAX_DXF_ENTITIES) {
        truncated = true;
        return;
      }
      segments.push({ layer: layerOf(line.layer), start: apply(matrix, line.a), end: apply(matrix, line.b) });
    }
    for (const curve of container.curves) {
      if (segments.length + curves.length >= MAX_DXF_ENTITIES) {
        truncated = true;
        return;
      }
      curves.push({ layer: layerOf(curve.layer), points: curve.points.map((p) => apply(matrix, p)) });
    }
    if (depth >= MAX_BLOCK_DEPTH) return;
    for (const insert of container.inserts) {
      if (xrefBlocks.has(insert.name)) {
        counters.xrefs.add(insert.name);
        continue;
      }
      const block = blocks.get(insert.name);
      if (!block) {
        counters.missingBlocks.add(insert.name);
        continue;
      }
      const base: Matrix = [1, 0, 0, 1, -block.base.x, -block.base.y];
      for (const placed of insert.matrices) {
        emit(block, multiply(multiply(matrix, placed), base), layerOf(insert.layer), depth + 1);
        if (truncated) return;
      }
    }
  };
  emit(model, IDENTITY, null, 0);

  const counts = new Map<string, { segments: number; curves: number }>();
  const entry = (layer: string) => {
    let value = counts.get(layer);
    if (!value) counts.set(layer, (value = { segments: 0, curves: 0 }));
    return value;
  };
  for (const segment of segments) entry(segment.layer).segments++;
  for (const curve of curves) entry(curve.layer).curves++;
  const layers: DxfLayer[] = [...counts.entries()]
    .map(([name, count]) => ({ name, ...count, visible: tableLayers.get(name) ?? true }))
    .sort((a, b) => a.name.localeCompare(b.name, currentLocale()));

  const warnings: string[] = [];
  if (counters.splines) warnings.push(tr`Сплайны не прочитаны: ${counters.splines}. Дуга двери, нарисованная сплайном, не будет найдена.`);
  if (counters.xrefs.size) warnings.push(tr`Внешние ссылки не загружены: ${[...counters.xrefs].slice(0, 5).join(", ")}. Их геометрии в файле нет.`);
  if (counters.missingBlocks.size) warnings.push(tr`В файле нет описания блоков: ${[...counters.missingBlocks].slice(0, 5).join(", ")}.`);
  if (truncated) warnings.push(tr`Чертёж слишком большой: прочитаны первые ${MAX_DXF_ENTITIES.toLocaleString(currentLocale())} объектов.`);

  return { version, units: unitsOf(insUnits), layers, segments, curves, warnings, truncated };
}

export interface DxfGeometry {
  /** Size of the chosen layers, in metres. */
  width: number;
  height: number;
  /** Plan metres, with the drawing's top left corner at the origin and Y downwards. */
  segments: LineSegment[];
  curves: CurvePolyline[];
}

/** Largest drawing that fits the plan's coordinate limits. */
export const MAX_DXF_SIZE_METRES = 1000;

/**
 * The chosen layers in plan metres. Returns null when there is nothing to show;
 * throws when the size makes no sense for the plan, which usually means a wrong unit.
 */
export function dxfGeometry(
  drawing: Pick<DxfDrawing, "segments" | "curves">,
  metresPerUnit: number,
  layers: ReadonlySet<string>,
): DxfGeometry | null {
  if (!(metresPerUnit > 0) || !Number.isFinite(metresPerUnit)) throw new Error(tr`Выберите единицы чертежа.`);
  const lines = drawing.segments.filter((item) => layers.has(item.layer));
  const arcs = drawing.curves.filter((item) => layers.has(item.layer));
  if (!lines.length && !arcs.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (p: Point) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };
  for (const line of lines) {
    include(line.start);
    include(line.end);
  }
  for (const arc of arcs) arc.points.forEach(include);
  const width = (maxX - minX) * metresPerUnit, height = (maxY - minY) * metresPerUnit;
  if (Math.max(width, height) > MAX_DXF_SIZE_METRES) {
    throw new Error(tr`Чертёж получается ${Math.round(Math.max(width, height))} м в длину. Проверьте единицы или отключите слои с объектами далеко от плана.`);
  }
  if (!(Math.max(width, height) > 0)) throw new Error(tr`У выбранных слоёв нет размера.`);
  // DXF Y grows upwards, plan Y downwards.
  const toPlan = (p: Point): Point => ({ x: (p.x - minX) * metresPerUnit, y: (maxY - p.y) * metresPerUnit });
  return {
    width,
    height,
    segments: lines.map((line) => ({ start: toPlan(line.start), end: toPlan(line.end) })),
    curves: arcs.map((arc) => ({ points: arc.points.map(toPlan) })),
  };
}
