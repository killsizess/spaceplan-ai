import { describe, expect, it } from "vitest";
import { createEmptyPlan, createExamplePlan } from "@/domain/floor-plan/operations";
import type { Point } from "@/domain/geometry";
import { createSpatialExamplePlan } from "@/domain/floor-plan/examples";
import type { FloorPlan, Room, Wall } from "@/domain/floor-plan/types";
import { resolveWallRoomLabels, setWallRoomLabel } from "@/domain/floor-plan/wall-room-labels";
import { createPlanExportLayout, DEFAULT_EXPORT_OPTIONS } from "./export-layout";

const rectangle = (width = 5, height = 4): Room => ({ id: "room", name: "Гостиная", kind: "living", color: "#dfe8df", x: 0, y: 0, width, height });
const manual = (room = rectangle()): FloorPlan => ({ ...createEmptyPlan("export"), name: "Моя квартира", rooms: [room] });
const outline = (width = 5, height = 4): Wall[] => {
  const points = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  return points.map((start, index) => ({ id: `wall-${index}`, start, end: points[(index + 1) % 4], thickness: 0.2, height: 2.7 }));
};
const walls = (): FloorPlan => ({ ...manual(), roomMode: "walls", walls: outline() });

function pathPoints(svg: string, kind: "room" | "wall") {
  const d = svg.match(new RegExp(`<path data-${kind}="true" d="([^"]+)"`))?.[1];
  if (!d) throw new Error(`Missing ${kind} path`);
  return [...d.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function doorLabelFixture(width = Math.SQRT2): FloorPlan {
  return {
    ...manual({ ...rectangle(2, 2), name: "Bathroom" }),
    walls: [{ id: "wall", start: { x: 0, y: 2 }, end: { x: Math.max(2, width), y: 2 }, thickness: 0.1, height: 2.7 }],
    openings: [{ id: "door", wallId: "wall", kind: "door", offset: 0, width, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } }],
  };
}

/** Read the emitted SVG, including its actual opening transform, independently of the model helper. */
function printedDoorSegments(svg: string): [Point, Point][] {
  const segments: [Point, Point][] = [];
  for (const match of svg.matchAll(/<g data-opening="door"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)">([\s\S]*?)<\/g>/g)) {
    const angle = Number(match[3]) * Math.PI / 180;
    const map = (point: Point) => ({ x: Number(match[1]) + point.x * Math.cos(angle) - point.y * Math.sin(angle), y: Number(match[2]) + point.x * Math.sin(angle) + point.y * Math.cos(angle) });
    const leaf = match[4].match(/data-door-leaf="true" d="([^"]+)"/)![1];
    const leafPoints = [...leaf.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((point) => ({ x: Number(point[1]), y: Number(point[2]) }));
    const arc = match[4].match(/data-door-arc="true" points="([^"]+)"/)![1].split(" ").map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
    for (const polyline of [leafPoints, arc]) for (let index = 1; index < polyline.length; index++) {
      segments.push([map(polyline[index - 1]), map(polyline[index])]);
    }
  }
  return segments;
}

function bathroomLabel(svg: string): Point {
  const match = svg.match(/<g data-room-label="true"[^>]*><text x="([^"]+)" y="([^"]+)"[^>]*>Bathroom<\/text>/);
  if (!match) throw new Error("Missing unshortened Bathroom label");
  return { x: Number(match[1]), y: Number(match[2]) };
}

function expectBathroomClearOfDoors(svg: string) {
  const label = bathroomLabel(svg);
  // 18 mm safely encloses the 3 mm Arial name. The following area line ends
  // 5 mm below its baseline; include another physical millimetre of clear air.
  const ink = { left: label.x - 10, right: label.x + 10, top: label.y - 4, bottom: label.y + 6 };
  const hits: Point[] = [];
  for (const [start, end] of printedDoorSegments(svg)) for (let step = 0; step <= 200; step++) {
    const point = { x: start.x + (end.x - start.x) * step / 200, y: start.y + (end.y - start.y) * step / 200 };
    if (point.x >= ink.left && point.x <= ink.right && point.y >= ink.top && point.y <= ink.bottom) hits.push(point);
  }
  expect(hits).toEqual([]);
}

function sampledDoorHits(svg: string, box: { left: number; right: number; top: number; bottom: number }): Point[] {
  const hits: Point[] = [];
  for (const [start, end] of printedDoorSegments(svg)) for (let step = 0; step <= 200; step++) {
    const point = { x: start.x + (end.x - start.x) * step / 200, y: start.y + (end.y - start.y) * step / 200 };
    if (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) hits.push(point);
  }
  return hits;
}

describe("physical A4 plan export", () => {
  it("prints metres at the exact physical scale independently of the camera", () => {
    const result = createPlanExportLayout(manual(), { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    expect(result.widthMm).toBe(297);
    expect(result.heightMm).toBe(210);
    expect(result.svg).toContain('width="297mm" height="210mm" viewBox="0 0 297 210"');
    expect(result.svg).toContain('data-mm-per-meter="20"');
    const points = pathPoints(result.svg, "room");
    expect(Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))).toBeCloseTo(100, 6);
    expect(Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))).toBeCloseTo(80, 6);
    expect(result.svg).toContain("Масштаб 1:50");
    expect(result.svg).toContain("Печатать A4, масштаб 100%");
    expect(result.svg).toContain("5 м");
    expect(result.svg).toContain("4 м");
    expect(result.roomCount).toBe(1);
    expect(result.totalArea).toBe(20);
    expect(result.warnings).toEqual([]);
  });

  it("swaps physical A4 dimensions in portrait and selects a fitting nice scale", () => {
    const result = createPlanExportLayout(manual(rectangle(10, 8)), { ...DEFAULT_EXPORT_OPTIONS, orientation: "portrait" });
    expect(result.widthMm).toBe(210);
    expect(result.heightMm).toBe(297);
    expect(result.scaleDenominator).toBe(75);
    const points = pathPoints(result.svg, "room");
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(16);
      expect(point.x).toBeLessThanOrEqual(194);
      expect(point.y).toBeGreaterThanOrEqual(37);
      expect(point.y).toBeLessThanOrEqual(257);
    }
  });

  it("never silently clips an explicit scale which cannot fit", () => {
    const plan = manual(rectangle(10, 8));
    expect(() => createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 20 })).toThrow(/не помещается.*1:20/);
    expect(createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS).scaleDenominator).toBe(75);
  });

  it("allows the exact physical boundary and rejects the first larger plan", () => {
    const plan = manual(rectangle(10, 6.65));
    expect(createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 }).scaleDenominator).toBe(50);
    expect(() => createPlanExportLayout(manual(rectangle(10, 6.651)), { ...DEFAULT_EXPORT_OPTIONS, scale: 50 })).toThrow(/не помещается/);
  });

  it("exports only active manual areas even when walls and labels are retained", () => {
    const plan = { ...walls(), roomMode: "manual" as const };
    const result = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
    expect(result.roomCount).toBe(1);
    expect(result.totalArea).toBe(20);
    expect(result.svg).toContain("Гостиная");
    expect(result.svg).not.toContain("Помещение 1");
    expect(result.svg).toContain('data-wall="true"');
  });

  it("uses inner wall faces, saved names and colours without counting inactive rectangles", () => {
    const original = walls();
    const room = resolveWallRoomLabels(original).rooms[0];
    const plan = setWallRoomLabel(original, room, { name: "Моя спальня", kind: "bedroom", color: "#101010" }, "label");
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    expect(result.roomCount).toBe(1);
    expect(result.totalArea).toBeCloseTo(4.8 * 3.8, 10);
    expect(result.svg).toContain("Моя спальня");
    expect(result.svg).toContain('fill="#101010" fill-rule="evenodd"');
    expect(result.svg).toContain('data-room-label="true" fill="#ffffff"');
    expect(result.svg).toContain("4,8 м");
    expect(result.svg).toContain("3,8 м");
    expect(result.svg).not.toContain("Гостиная");
  });

  it("preserves a physical island as an unfilled hole and excludes its area", () => {
    const plan = walls();
    plan.walls.push({ id: "column", start: { x: 2, y: 2 }, end: { x: 2.4, y: 2 }, thickness: 0.4, height: 2.7 });
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    expect(result.roomCount).toBe(1);
    expect(result.totalArea).toBeCloseTo(4.8 * 3.8 - 0.4 * 0.4, 10);
    const path = result.svg.match(/<path data-room="true" d="([^"]+)"/)![1];
    expect((path.match(/ Z/g) ?? []).length).toBe(2);
    expect(result.svg).toContain('fill-rule="evenodd"');
    expect(result.svg).not.toContain("Внутри");
    expect(result.warnings).toContain("Внутренние размеры показаны только у прямоугольных помещений, где для них достаточно места.");
  });

  it("shows open walls with zero area rather than exporting inactive manual rooms", () => {
    const plan = { ...walls(), walls: outline().slice(0, 3) };
    const result = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
    expect(result.roomCount).toBe(0);
    expect(result.totalArea).toBe(0);
    expect(result.svg).not.toContain('data-room="true"');
    expect(result.svg).toContain('data-wall="true"');
    expect(result.warnings.join(" ")).toContain("Замкнутые помещения не найдены");
  });

  it("fits actual thick diagonal footprints, including negative coordinates", () => {
    const plan = { ...createEmptyPlan("diagonal"), roomMode: "walls" as const, walls: [{ id: "wall", start: { x: -30, y: -10 }, end: { x: 20, y: 10 }, thickness: 5, height: 3 }] };
    const result = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
    const points = pathPoints(result.svg, "wall");
    expect(points).toHaveLength(4);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(16 - 1e-6);
      expect(point.x).toBeLessThanOrEqual(281 + 1e-6);
      expect(point.y).toBeGreaterThanOrEqual(37 - 1e-6);
      expect(point.y).toBeLessThanOrEqual(170 + 1e-6);
    }
  });

  it("renders doors and windows from semantic offsets without changing areas", () => {
    const plan = createSpatialExamplePlan();
    plan.roomMode = "walls";
    const result = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
    expect(result.roomCount).toBe(6);
    expect(result.totalArea).toBeCloseTo(73.4208, 4);
    expect((result.svg.match(/data-opening="door"/g) ?? []).length).toBe(7);
    expect((result.svg.match(/data-opening="window"/g) ?? []).length).toBe(5);
    const withoutOpenings = createPlanExportLayout({ ...plan, openings: [] }, DEFAULT_EXPORT_OPTIONS);
    expect(result.totalArea).toBe(withoutOpenings.totalArea);
    expect(result.scaleDenominator).toBe(withoutOpenings.scaleDenominator);
    const visibleLabels = (result.svg.match(/data-room-label="true"/g) ?? []).length;
    expect(visibleLabels).toBeGreaterThanOrEqual(5);
    if (visibleLabels < 6) expect(result.warnings.join(" ")).toContain(`Подписи ${6 - visibleLabels} помещений скрыты`);
    expect(result.svg).toContain("Внутри");
  });

  it("relocates the entire name and area away from a quarter arc crossing the old label position", () => {
    const plan = doorLabelFixture();
    const before = JSON.stringify(plan);
    const options = { ...DEFAULT_EXPORT_OPTIONS, scale: 50, dimensions: false };
    const control = createPlanExportLayout({ ...plan, openings: [] }, options);
    const result = createPlanExportLayout(plan, options);
    const initial = bathroomLabel(control.svg), relocated = bathroomLabel(result.svg);
    expect(Math.hypot(initial.x - relocated.x, initial.y - relocated.y)).toBeGreaterThan(2);
    expectBathroomClearOfDoors(result.svg);
    expect(result.warnings).toEqual([]);
    expect(result.svg).not.toMatch(/<mask|<clipPath/);
    expect(createPlanExportLayout(plan, options)).toEqual(result);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("also moves a label away from the actual open leaf, independently of the distant arc", () => {
    const plan = doorLabelFixture(1);
    plan.walls[0] = { ...plan.walls[0], start: { x: 1, y: 0 }, end: { x: 1, y: 2 } };
    plan.openings[0] = { ...plan.openings[0], offset: 1 };
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50, dimensions: false });
    expectBathroomClearOfDoors(result.svg);
    expect(result.warnings).toEqual([]);
  });

  it("keeps labels inside a large swept sector when its actual leaf and arc stay clear", () => {
    const result = createPlanExportLayout(doorLabelFixture(4), { ...DEFAULT_EXPORT_OPTIONS, scale: 50, dimensions: false });
    const room = pathPoints(result.svg, "room");
    const center = { x: (room[0].x + room[2].x) / 2, y: (room[0].y + room[2].y) / 2 };
    const label = bathroomLabel(result.svg);
    expect(label.x).toBeCloseTo(center.x, 6);
    expect(label.y).toBeCloseTo(center.y - 1, 6);
    expectBathroomClearOfDoors(result.svg);
    expect(result.warnings).toEqual([]);
  });

  it("warns and omits a label when door leaves occupy every available position", () => {
    const plan = doorLabelFixture();
    plan.walls = Array.from({ length: 10 }, (_, index) => ({
      id: `wall-${index}`, start: { x: 0, y: 0.1 + index * 0.2 }, end: { x: 0, y: 2.1 + index * 0.2 }, thickness: 0.1, height: 2.7,
    }));
    plan.openings = plan.walls.map((wall, index) => ({
      id: `door-${index}`, wallId: wall.id, kind: "door", offset: 0, width: 2, height: 2.1, sillHeight: 0,
    }));
    const before = JSON.stringify(plan);
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50, dimensions: false });
    expect(result.svg).not.toContain('data-room-label="true"');
    expect(result.warnings.join(" ")).toContain("Подписи 1 помещений скрыты");
    expect(JSON.stringify(plan)).toBe(before);
    const withDimensions = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    expect(withDimensions.svg).not.toContain('data-compact-dimension="true"');
    expect(withDimensions.warnings).toContain("Внутренние размеры показаны только у прямоугольных помещений, где для них достаточно места.");
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("moves the compact kitchen dimensions clear of the real six-room door arc and all name/area text", () => {
    let plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
    const names = ["Гостиная у окна", "Кухня", "Прихожая", "Спальня", "Кабинет", "Ванная"];
    for (const [index, room] of resolveWallRoomLabels(plan).rooms.entries()) {
      plan = setWallRoomLabel(plan, room, { name: names[index], kind: "other", color: room.color }, `label-${index}`);
    }
    const before = JSON.stringify(plan);
    const result = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
    const match = result.svg.match(/<g data-compact-dimension="true"[^>]*><g transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(0\)"><text x="([-\d.]+)" y="([-\d.]+)"[^>]*>2,88 × 3,84 м внутри<\/text>/);
    if (!match) throw new Error("Missing genuine compact kitchen dimensions");
    const center = { x: Number(match[1]) + Number(match[3]), y: Number(match[2]) + Number(match[4]) };
    const halfWidth = Number(match[3]), halfHeight = Number(match[4]);
    const box = { left: center.x - halfWidth - 1, right: center.x + halfWidth + 1, top: center.y - halfHeight - 1, bottom: center.y + halfHeight + 1 };
    expect(sampledDoorHits(result.svg, box)).toEqual([]);
    const kitchen = resolveWallRoomLabels(plan).rooms.find((room) => room.name === "Кухня")!;
    const roomPath = [...result.svg.matchAll(/<path data-room="true" d="([^"]+)"/g)][1][1];
    const roomY = [...roomPath.matchAll(/[ML]-?\d+(?:\.\d+)? (-?\d+(?:\.\d+)?)/g)].map((point) => Number(point[1]));
    expect(box.top).toBeGreaterThan(Math.min(...roomY));
    expect(box.bottom).toBeLessThan(Math.max(...roomY));
    // The former bottom position crosses the door in the actual output,
    // independently of our placement algorithm or the model's curve helper.
    const previousCenterY = Math.max(...roomY) - 16 * 25.4 / 96;
    expect(sampledDoorHits(result.svg, { ...box, top: previousCenterY - halfHeight - 1, bottom: previousCenterY + halfHeight + 1 }).length).toBeGreaterThan(0);
    const name = result.svg.match(/<g data-room-label="true"[^>]*><text x="[^"]+" y="([^"]+)"[^>]*>Кухня<\/text><text x="[^"]+" y="([^"]+)"[^>]*>/)!;
    expect(box.bottom < Number(name[1]) - 3 || box.top > Number(name[2]) + 1).toBe(true);
    expect(kitchen.area).toBeCloseTo(2.88 * 3.84, 8);
    expect((result.svg.match(/data-room-label="true"/g) ?? []).length).toBe(6);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it.each(["door", "window"] as const)("cuts a %s only from its owner and keeps a crossing wall continuous", (kind) => {
    const plan: FloorPlan = {
      ...createEmptyPlan("crossing"), roomMode: "walls",
      walls: [
        { id: "horizontal", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 },
        { id: "vertical", start: { x: 2.5, y: -2 }, end: { x: 2.5, y: 2 }, thickness: 0.2, height: 2.7 },
      ],
      openings: [{ id: "opening", wallId: "horizontal", kind, offset: 2, width: 1, height: 1.2, sillHeight: kind === "window" ? 0.9 : 0 }],
    };
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    const solids = [...result.svg.matchAll(/<path data-wall="true" d="([^"]+)" data-wall-id="([^"]+)"/g)].map((match) => ({
      wallId: match[2],
      points: [...match[1].matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((point) => ({ x: Number(point[1]), y: Number(point[2]) })),
    }));
    const horizontal = solids.filter((solid) => solid.wallId === "horizontal");
    const vertical = solids.filter((solid) => solid.wallId === "vertical");
    expect(horizontal).toHaveLength(2);
    expect(vertical).toHaveLength(1);
    expect(Math.max(...vertical[0].points.map((point) => point.y)) - Math.min(...vertical[0].points.map((point) => point.y))).toBeCloseTo(80, 6);
    expect(Math.max(...vertical[0].points.map((point) => point.x)) - Math.min(...vertical[0].points.map((point) => point.x))).toBeCloseTo(4, 6);
    const crossingX = (vertical[0].points[0].x + vertical[0].points[1].x) / 2;
    const gapLeft = Math.max(...horizontal[0].points.map((point) => point.x));
    const gapRight = Math.min(...horizontal[1].points.map((point) => point.x));
    expect(crossingX).toBeGreaterThan(gapLeft);
    expect(crossingX).toBeLessThan(gapRight);
    expect(gapRight - gapLeft).toBeCloseTo(20, 6);
    // Every remaining solid is painted after the white cavity and its symbol.
    expect(result.svg.lastIndexOf('data-opening="')).toBeLessThan(result.svg.indexOf('data-wall="true"'));
    expect(result.totalArea).toBe(0);
    expect(result.scaleDenominator).toBe(createPlanExportLayout({ ...plan, openings: [] }, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 }).scaleDenominator);
  });

  it("cuts touching openings in a reversed wall without leaving a false wall strip", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("reversed"),
      walls: [{ id: "wall", start: { x: 5, y: 0 }, end: { x: 0, y: 0 }, thickness: 0.2, height: 2.7 }],
      openings: [
        { id: "door", wallId: "wall", kind: "door", offset: 1, width: 1, height: 2.1, sillHeight: 0 },
        { id: "window", wallId: "wall", kind: "window", offset: 2, width: 1, height: 1.2, sillHeight: 0.9 },
      ],
    };
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    const solidPaths = [...result.svg.matchAll(/<path data-wall="true" d="([^"]+)"/g)];
    expect(solidPaths).toHaveLength(2);
    const spans = solidPaths.map((match) => {
      const xs = [...match[1].matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((point) => Number(point[1]));
      return Math.max(...xs) - Math.min(...xs);
    });
    expect(spans).toEqual([20, 40]);
  });

  it("escapes names as XML and never adds scripts, external images or embedded underlay", () => {
    const plan = manual({ ...rectangle(), name: '<script>alert("x")</script>&' });
    plan.name = '<img src="https://example.com/x" onerror="bad()"> & дом';
    plan.underlay = { name: "private", dataUrl: "data:image/png;base64,AAAA", pixelWidth: 1, pixelHeight: 1, x: 0, y: 0, metersPerPixel: 1, visible: true, calibrated: true, opacity: 0.5 };
    const result = createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS);
    expect(result.svg).toContain("&lt;img");
    expect(result.svg).toContain("&quot;");
    expect(result.svg).toContain("&amp;");
    expect(result.svg).not.toMatch(/<script|<image|<img|href=|url\(|data:image/);
    expect(result.warnings.join(" ")).toContain("Подложка не включается");
  });

  it("hides dimensions when requested and warns instead of squeezing tiny room labels", () => {
    const plan = manual(rectangle());
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 1000, dimensions: false });
    expect(result.svg).not.toContain("Внутри");
    expect(result.svg).not.toContain('data-room-label="true"');
    expect(result.warnings.join(" ")).toContain("Подписи 1 помещений скрыты");
    expect(result.svg).toContain("Размеры скрыты");
  });

  it("labels a small scale bar with its true length rather than rounding centimetres away", () => {
    const plan: FloorPlan = { ...createEmptyPlan("short-wall"), walls: [{ id: "wall", start: { x: 0, y: 0 }, end: { x: 0.05, y: 0 }, thickness: 0.01, height: 2.7 }] };
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 1 });
    expect(result.svg).toContain(">0,025 м</text>");
    expect(result.svg).not.toContain(">0,03 м</text>");
    const bar = result.svg.match(/data-scale-bar="true" d="M([\d.]+) [\d.]+ V[\d.]+ M[\d.]+ [\d.]+ H([\d.]+)/)!;
    expect(Number(bar[2]) - Number(bar[1])).toBeCloseTo(25, 6);
  });

  it("warns when very long room names must be shortened on the physical sheet", () => {
    const plan = manual({ ...rectangle(2, 2), name: "Оченьдлинноеназваниепомещения".repeat(2) });
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 75, dimensions: false });
    expect(result.warnings.join(" ")).toContain("сокращены на листе");
    expect(result.svg).toContain("…");
  });

  it("rejects empty geometry, invalid finite values and invalid export settings", () => {
    expect(() => createPlanExportLayout(createEmptyPlan("empty"), DEFAULT_EXPORT_OPTIONS)).toThrow(/План пуст/);
    const plan = manual();
    for (const scale of [NaN, Infinity, -1, 0, 0.5, 1_000_001]) {
      expect(() => createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale })).toThrow(/масштаб/);
    }
    expect(() => createPlanExportLayout(manual({ ...rectangle(), x: NaN }), DEFAULT_EXPORT_OPTIONS)).toThrow(/некорректные данные/);
  });

  it("does not mutate a plan, saved labels, underlay or export options", () => {
    const plan = createExamplePlan();
    const before = JSON.stringify(plan);
    const options = { ...DEFAULT_EXPORT_OPTIONS };
    const expected = { ...options };
    const first = createPlanExportLayout(plan, options);
    const second = createPlanExportLayout(plan, options);
    expect(first).toEqual(second);
    expect(JSON.stringify(plan)).toBe(before);
    expect(options).toEqual(expected);
  });

  it.each([
    ["start", "left", "M0 0 L0 -20"],
    ["start", "right", "M0 0 L0 20"],
    ["end", "left", "M20 0 L20 -20"],
    ["end", "right", "M20 0 L20 20"],
  ] as const)("prints a %s-hinged %s door leaf at its true physical size", (hinge, side, path) => {
    const plan: FloorPlan = {
      ...createEmptyPlan("door-sheet"),
      walls: [{ id: "wall", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 }],
      openings: [{ id: "door", wallId: "wall", kind: "door", offset: 1, width: 1, height: 2.1, sillHeight: 0, door: { hinge, side } }],
    };
    const before = JSON.stringify(plan);
    const result = createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 50 });
    expect(result.svg).toContain(`data-opening="door" data-hinge="${hinge}" data-side="${side}"`);
    expect(result.svg).toContain(`data-door-leaf="true" d="${path}"`);
    expect(result.svg).toContain('data-door-arc="true"');
    expect(result.svg.indexOf('data-door-leaf="true"')).toBeLessThan(result.svg.indexOf('data-wall="true"'));
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("fits the whole opening sector, rejecting a fixed scale that fits only the walls", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("door-fit"),
      walls: [{ id: "wall", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 }],
      openings: [{ id: "door", wallId: "wall", kind: "door", offset: 1, width: 3, height: 2.1, sillHeight: 0 }],
    };
    expect(createPlanExportLayout({ ...plan, openings: [] }, { ...DEFAULT_EXPORT_OPTIONS, scale: 20 }).scaleDenominator).toBe(20);
    expect(() => createPlanExportLayout(plan, { ...DEFAULT_EXPORT_OPTIONS, scale: 20 })).toThrow(/не помещается/);
    expect(createPlanExportLayout(plan, DEFAULT_EXPORT_OPTIONS).scaleDenominator).toBe(25);
    const window = { ...plan, openings: [{ id: "window", wallId: "wall", kind: "window" as const, offset: 1, width: 3, height: 1.2, sillHeight: 0.9 }] };
    expect(createPlanExportLayout(window, DEFAULT_EXPORT_OPTIONS).svg).not.toContain('data-door-leaf="true"');
    expect(createPlanExportLayout(window, DEFAULT_EXPORT_OPTIONS).scaleDenominator).toBe(20);
  });
});
