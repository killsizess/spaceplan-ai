import { describe, expect, it } from "vitest";
import { decodeDxf, dxfGeometry, MAX_DXF_ENTITIES, parseDxf } from "./dxf";
import {
  apartmentDxf,
  dxfArc,
  dxfCircle,
  dxfFile,
  dxfInsert,
  dxfLine,
  dxfLwPolyline,
  dxfPolyline,
  type DxfPairs,
} from "./dxf.fixtures";
import { findOpeningCandidates } from "./opening-candidates";
import { createEmptyPlan } from "./operations";
import { findWallCandidates } from "./wall-candidates";
import { detectWallRooms } from "./wall-rooms";
import { addWallsAndOpenings } from "./construction";
import type { FloorPlan, Wall } from "./types";

const onCircle = (points: readonly { x: number; y: number }[], cx: number, cy: number, r: number) =>
  points.every((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) < 1e-9);

describe("DXF units", () => {
  it.each([
    [4, 0.001, "миллиметры"],
    [5, 0.01, "сантиметры"],
    [6, 1, "метры"],
    [1, 0.0254, "дюймы"],
    [14, 0.1, "дециметры"],
  ])("reads $INSUNITS %i as a known unit", (code, metres, label) => {
    const { units } = parseDxf(dxfFile({ units: code, entities: [dxfLine("A", 0, 0, 1, 0)] }));
    expect(units).toEqual({ code, metresPerUnit: metres, label });
  });

  it("does not assume a unit when the file does not state one", () => {
    expect(parseDxf(dxfFile({ entities: [dxfLine("A", 0, 0, 1, 0)] })).units.metresPerUnit).toBeNull();
    expect(parseDxf(dxfFile({ units: 0, entities: [dxfLine("A", 0, 0, 1, 0)] })).units.metresPerUnit).toBeNull();
    expect(parseDxf(dxfFile({ units: 99, entities: [dxfLine("A", 0, 0, 1, 0)] })).units.metresPerUnit).toBeNull();
  });

  it("reads the drawing version", () => {
    expect(parseDxf(dxfFile({ version: "AC1015", entities: [] })).version).toBe("AC1015");
  });
});

describe("DXF entities", () => {
  it("reads lines with their layers and counts them per layer", () => {
    const drawing = parseDxf(dxfFile({ entities: [dxfLine("B", 1, 2, 3, 4), dxfLine("A", 0, 0, 5, 0), dxfLine("B", 0, 0, 0, 5)] }));
    expect(drawing.segments[0]).toEqual({ layer: "B", start: { x: 1, y: 2 }, end: { x: 3, y: 4 } });
    expect(drawing.layers).toEqual([
      { name: "A", segments: 1, curves: 0, visible: true },
      { name: "B", segments: 2, curves: 0, visible: true },
    ]);
  });

  it("skips zero-length lines", () => {
    expect(parseDxf(dxfFile({ entities: [dxfLine("A", 1, 1, 1, 1)] })).segments).toEqual([]);
  });

  it("reads a closed LWPOLYLINE as its edges, and an open one without the last edge", () => {
    const square = [[0, 0], [2, 0], [2, 2], [0, 2]] as const;
    expect(parseDxf(dxfFile({ entities: [dxfLwPolyline("A", square, true)] })).segments).toHaveLength(4);
    expect(parseDxf(dxfFile({ entities: [dxfLwPolyline("A", square, false)] })).segments).toHaveLength(3);
  });

  it("turns a bulge into an arc on the correct side", () => {
    const quarter = Math.tan(Math.PI / 8);
    // From (1, 0) to (0, 1) counter-clockwise: the unit circle around the origin.
    const ccw = parseDxf(dxfFile({ entities: [dxfLwPolyline("A", [[1, 0, quarter], [0, 1]])] }));
    expect(ccw.segments).toEqual([]);
    expect(ccw.curves).toHaveLength(1);
    expect(onCircle(ccw.curves[0].points, 0, 0, 1)).toBe(true);
    expect(ccw.curves[0].points[0]).toEqual({ x: 1, y: 0 });
    // The other way round bulges to the far side: the circle around (1, 1).
    const cw = parseDxf(dxfFile({ entities: [dxfLwPolyline("A", [[1, 0, -quarter], [0, 1]])] }));
    expect(onCircle(cw.curves[0].points, 1, 1, 1)).toBe(true);
  });

  it("mixes straight and bulged edges in one polyline, keeping a door swing's points", () => {
    const quarter = Math.tan(Math.PI / 8);
    const { segments, curves } = parseDxf(dxfFile({ entities: [dxfLwPolyline("A", [[0, 0], [1, 0, quarter], [0, 1], [0, 0]])] }));
    expect(segments).toHaveLength(2);
    expect(curves).toHaveLength(1);
    expect(curves[0].points.length).toBeGreaterThanOrEqual(5);
  });

  it("reads POLYLINE with VERTEX records, and the entity after its SEQEND", () => {
    const drawing = parseDxf(dxfFile({ entities: [dxfPolyline("A", [[0, 0], [3, 0], [3, 3]]), dxfLine("B", 9, 9, 10, 10)] }));
    expect(drawing.segments.filter((s) => s.layer === "A")).toHaveLength(2);
    expect(drawing.segments.filter((s) => s.layer === "B")).toHaveLength(1);
  });

  it("does not take a mesh POLYLINE for plan lines", () => {
    const mesh: DxfPairs = [[0, "POLYLINE"], [8, "A"], [66, 1], [70, 16], [0, "VERTEX"], [8, "A"], [10, 0], [20, 0], [0, "VERTEX"], [8, "A"], [10, 1], [20, 0], [0, "SEQEND"], [8, "A"]];
    expect(parseDxf(dxfFile({ entities: [mesh] })).segments).toEqual([]);
  });

  it("samples an ARC counter-clockwise, including one that crosses 0°", () => {
    const quarter = parseDxf(dxfFile({ entities: [dxfArc("A", 5, 5, 2, 0, 90)] })).curves[0];
    expect(onCircle(quarter.points, 5, 5, 2)).toBe(true);
    expect(quarter.points[0].x).toBeCloseTo(7, 9);
    expect(quarter.points.at(-1)!.y).toBeCloseTo(7, 9);
    expect(quarter.points.length).toBeGreaterThanOrEqual(5);
    const crossing = parseDxf(dxfFile({ entities: [dxfArc("A", 0, 0, 1, 350, 10)] })).curves[0];
    expect(crossing.points[0].x).toBeCloseTo(Math.cos((350 * Math.PI) / 180), 9);
    expect(crossing.points.at(-1)!.y).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 9);
    expect(crossing.points.every((p) => p.x > 0.9)).toBe(true);
  });

  it("mirrors an ARC whose extrusion is (0, 0, −1)", () => {
    const { curves } = parseDxf(dxfFile({ entities: [dxfArc("A", 2, 0, 1, 0, 90, [[210, 0], [220, 0], [230, -1]])] }));
    expect(onCircle(curves[0].points, -2, 0, 1)).toBe(true);
    expect(curves[0].points[0].x).toBeCloseTo(-3, 9);
  });

  it("reads CIRCLE and ELLIPSE as curves", () => {
    const circle = parseDxf(dxfFile({ entities: [dxfCircle("A", 1, 1, 2)] })).curves[0];
    expect(onCircle(circle.points, 1, 1, 2)).toBe(true);
    const ellipse: DxfPairs = [[0, "ELLIPSE"], [8, "A"], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [41, 0], [42, Math.PI / 2]];
    const { points } = parseDxf(dxfFile({ entities: [ellipse] })).curves[0];
    expect(points[0].x).toBeCloseTo(2, 9);
    expect(points.at(-1)!.y).toBeCloseTo(1, 9);
  });

  it("reads an MLINE as one line per element, shifted along the miter", () => {
    const mline: DxfPairs = [
      [0, "MLINE"], [8, "A"], [40, 1], [70, 0], [71, 1], [72, 2], [73, 2], [10, 0], [20, 0],
      [11, 0], [21, 0], [12, 1], [22, 0], [13, 0], [23, 1], [74, 2], [41, 100], [41, 0], [75, 0], [74, 2], [41, -100], [41, 0], [75, 0],
      [11, 5000], [21, 0], [12, 1], [22, 0], [13, 0], [23, 1], [74, 2], [41, 100], [41, 0], [75, 0], [74, 2], [41, -100], [41, 0], [75, 0],
    ];
    const { segments } = parseDxf(dxfFile({ entities: [mline] }));
    expect(segments.map((s) => [s.start.y, s.end.y, s.end.x])).toEqual([[100, 100, 5000], [-100, -100, 5000]]);
  });

  it("ignores text, dimensions, hatches and points, and paper space", () => {
    const paper: DxfPairs = [[0, "LINE"], [67, 1], [8, "A"], [10, 0], [20, 0], [11, 9], [21, 9]];
    const paperPolyline: DxfPairs = [[0, "POLYLINE"], [67, 1], [8, "A"], [66, 1], [70, 0], [0, "VERTEX"], [8, "A"], [10, 0], [20, 0], [0, "VERTEX"], [8, "A"], [10, 1], [20, 1], [0, "SEQEND"], [8, "A"]];
    const noise: DxfPairs[] = [
      [[0, "TEXT"], [8, "T"], [10, 0], [20, 0], [1, "Гостиная"]],
      [[0, "DIMENSION"], [8, "D"], [2, "*D1"], [10, 0], [20, 0]],
      [[0, "HATCH"], [8, "H"], [10, 0], [20, 0]],
      [[0, "POINT"], [8, "P"], [10, 1], [20, 1]],
    ];
    const drawing = parseDxf(dxfFile({ entities: [paper, paperPolyline, ...noise, dxfLine("A", 0, 0, 1, 0)] }));
    expect(drawing.segments).toHaveLength(1);
    expect(drawing.curves).toEqual([]);
    expect(drawing.layers.map((layer) => layer.name)).toEqual(["A"]);
  });

  it("marks layers that are off or frozen in the file", () => {
    const drawing = parseDxf(dxfFile({
      layers: [{ name: "ON" }, { name: "OFF", color: -7 }, { name: "FROZEN", flags: 1 }],
      entities: [dxfLine("ON", 0, 0, 1, 0), dxfLine("OFF", 0, 0, 1, 0), dxfLine("FROZEN", 0, 0, 1, 0), dxfLine("UNDECLARED", 0, 0, 1, 0)],
    }));
    expect(Object.fromEntries(drawing.layers.map((layer) => [layer.name, layer.visible]))).toEqual({ ON: true, OFF: false, FROZEN: false, UNDECLARED: true });
  });

  it("says which things it could not read", () => {
    const spline: DxfPairs = [[0, "SPLINE"], [8, "A"], [70, 8]];
    const drawing = parseDxf(dxfFile({
      blocks: [{ name: "XREF", flags: 4, entities: [] }],
      entities: [spline, spline, dxfInsert("A", "XREF", 0, 0), dxfInsert("A", "НЕТ", 0, 0), dxfLine("A", 0, 0, 1, 0)],
    }));
    const text = drawing.warnings.join(" ");
    expect(text).toMatch(/Сплайны не прочитаны: 2/);
    expect(text).toMatch(/Внешние ссылки не загружены: XREF/);
    expect(text).toMatch(/нет описания блоков: НЕТ/);
  });
});

describe("DXF blocks", () => {
  const box = { name: "B", entities: [dxfLine("L", 0, 0, 2, 0)] };

  it("places a block by position, base point, scale and rotation", () => {
    const placed = parseDxf(dxfFile({ blocks: [{ ...box, base: [1, 0] }], entities: [dxfInsert("A", "B", 10, 20, { sx: 2, sy: 2, rotation: 90 })] })).segments[0];
    expect(placed.start.x).toBeCloseTo(10, 9);
    expect(placed.start.y).toBeCloseTo(18, 9);
    expect(placed.end.x).toBeCloseTo(10, 9);
    expect(placed.end.y).toBeCloseTo(22, 9);
  });

  it("gives entities on layer 0 the layer of the insert and keeps the others", () => {
    const drawing = parseDxf(dxfFile({
      blocks: [{ name: "B", entities: [dxfLine("0", 0, 0, 1, 0), dxfLine("СВОЙ", 0, 0, 0, 1)] }],
      entities: [dxfInsert("ДВЕРИ", "B", 0, 0)],
    }));
    expect(drawing.segments.map((s) => s.layer)).toEqual(["ДВЕРИ", "СВОЙ"]);
  });

  it("expands nested blocks through their transforms", () => {
    const drawing = parseDxf(dxfFile({
      blocks: [box, { name: "OUTER", entities: [dxfInsert("0", "B", 5, 0)] }],
      entities: [dxfInsert("A", "OUTER", 0, 10)],
    }));
    expect(drawing.segments[0].start).toEqual({ x: 5, y: 10 });
    expect(drawing.segments[0].end).toEqual({ x: 7, y: 10 });
  });

  it("repeats an array insert", () => {
    const { segments } = parseDxf(dxfFile({ blocks: [box], entities: [dxfInsert("A", "B", 0, 0, { cols: 3, rows: 2, dx: 10, dy: 5 })] }));
    expect(segments).toHaveLength(6);
    expect(segments.map((s) => [s.start.x, s.start.y])).toContainEqual([20, 5]);
  });

  it("mirrors by a negative scale and by extrusion, as CAD does for a door opening the other way", () => {
    const door = { name: "D", entities: [dxfArc("0", 0, 0, 1, 0, 90)] };
    const scaled = parseDxf(dxfFile({ blocks: [door], entities: [dxfInsert("A", "D", 0, 0, { sx: -1 })] })).curves[0];
    expect(scaled.points[0].x).toBeCloseTo(-1, 9);
    const extruded = parseDxf(dxfFile({ blocks: [door], entities: [dxfInsert("A", "D", 3, 0, { extrusionZ: -1 })] })).curves[0];
    expect(extruded.points[0].x).toBeCloseTo(-4, 9);
  });

  it("survives a block that contains itself", () => {
    const loop = { name: "LOOP", entities: [dxfLine("L", 0, 0, 1, 0), dxfInsert("0", "LOOP", 1, 0)] };
    const { segments } = parseDxf(dxfFile({ blocks: [loop], entities: [dxfInsert("A", "LOOP", 0, 0)] }));
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThan(20);
  });

  it("stops at the limit and says so", () => {
    const big = { name: "BIG", entities: Array.from({ length: 300 }, (_, i) => dxfLine("L", i, 0, i, 1)) };
    const huge = { name: "HUGE", entities: [dxfInsert("0", "BIG", 0, 0, { cols: 1000 })] };
    const drawing = parseDxf(dxfFile({ blocks: [big, huge], entities: [dxfInsert("A", "HUGE", 0, 0, { cols: 1000 })] }));
    expect(drawing.truncated).toBe(true);
    expect(drawing.segments.length + drawing.curves.length).toBe(MAX_DXF_ENTITIES);
    expect(drawing.warnings.join(" ")).toMatch(/слишком большой/);
  });
});

describe("DXF files", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("explains that DWG and binary DXF cannot be read", () => {
    expect(() => decodeDxf(bytes("AC1032\u0000\u0000binary"))).toThrow(/DWG/);
    expect(() => decodeDxf(bytes("AutoCAD Binary DXF\r\n\u001a\u0000"))).toThrow(/двоичный DXF/);
  });

  it("refuses what is not a DXF", () => {
    expect(() => parseDxf("это просто текст\nи ещё строка\n")).toThrow(/не похож/);
    expect(() => parseDxf("")).toThrow(/не похож/);
    expect(() => parseDxf("  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n")).toThrow(/нет раздела/);
  });

  it("decodes UTF-8 and old Windows-1251 files, so Cyrillic layer names stay readable", () => {
    const text = dxfFile({ entities: [dxfLine("СТЕНЫ", 0, 0, 1, 0)] });
    expect(parseDxf(decodeDxf(bytes(text))).layers[0].name).toBe("СТЕНЫ");
    // "СТЕНЫ" in Windows-1251, which is not valid UTF-8.
    const legacy = `  0\nSECTION\n  2\nHEADER\n  9\n$DWGCODEPAGE\n  3\nANSI_1251\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n`;
    const tail = `\n 10\n0\n 20\n0\n 11\n1\n 21\n0\n  0\nENDSEC\n  0\nEOF\n`;
    const data = new Uint8Array([...bytes(legacy), 0xd1, 0xd2, 0xc5, 0xcd, 0xdb, ...bytes(tail)]);
    expect(parseDxf(decodeDxf(data)).layers[0].name).toBe("СТЕНЫ");
    expect(parseDxf(dxfFile({ entities: [dxfLine("\\U+0421\\U+0422", 0, 0, 1, 0)] })).layers[0].name).toBe("СТ");
  });

  it("accepts Windows line endings and a trailing blank", () => {
    const text = dxfFile({ units: 4, entities: [dxfLine("A", 0, 0, 1, 0)] }).replace(/\n/g, "\r\n");
    expect(parseDxf(`${text}\r\n\r\n`).segments).toHaveLength(1);
  });
});

describe("DXF to plan metres", () => {
  const drawing = parseDxf(dxfFile({ units: 4, entities: [dxfLine("A", 1000, 1000, 3000, 1000), dxfLine("A", 1000, 1000, 1000, 2000), dxfLine("B", 90000, 0, 90000, 1)] }));

  it("scales by the unit, puts the corner at the origin and turns Y downwards", () => {
    const geometry = dxfGeometry(drawing, 0.001, new Set(["A"]))!;
    expect(geometry.width).toBeCloseTo(2, 9);
    expect(geometry.height).toBeCloseTo(1, 9);
    // The horizontal line was at the bottom of the drawing, so it is at the plan's lower edge.
    expect(geometry.segments[0]).toEqual({ start: { x: 0, y: 1 }, end: { x: 2, y: 1 } });
    expect(geometry.segments[1]).toEqual({ start: { x: 0, y: 1 }, end: { x: 0, y: 0 } });
  });

  it("counts only the chosen layers, and has nothing to show without any", () => {
    expect(dxfGeometry(drawing, 0.001, new Set(["A", "B"]))!.width).toBeCloseTo(89, 6);
    expect(dxfGeometry(drawing, 0.001, new Set())).toBeNull();
  });

  it("refuses a size that makes no sense, which usually means a wrong unit", () => {
    expect(() => dxfGeometry(drawing, 1, new Set(["A", "B"]))).toThrow(/Проверьте единицы/);
    expect(() => dxfGeometry(drawing, 0, new Set(["A"]))).toThrow(/единицы/);
    expect(() => dxfGeometry(drawing, Number.NaN, new Set(["A"]))).toThrow(/единицы/);
  });
});

describe("a whole DXF apartment", () => {
  const drawing = parseDxf(decodeDxf(new TextEncoder().encode(apartmentDxf())));
  const on = (names: string[]) => dxfGeometry(drawing, drawing.units.metresPerUnit!, new Set(names))!;
  const planLayers = ["СТЕНЫ", "ДВЕРИ", "ОКНА"];

  it("reads its layers and units", () => {
    expect(drawing.units.label).toBe("миллиметры");
    expect(drawing.layers.map((layer) => layer.name)).toEqual(["ДВЕРИ", "МЕБЕЛЬ", "ОКНА", "ОФОРМЛЕНИЕ", "СТЕНЫ"]);
    expect(drawing.layers.find((layer) => layer.name === "ОФОРМЛЕНИЕ")!.visible).toBe(false);
  });

  it("has the size of the apartment when the noise layers are off", () => {
    const geometry = on(planLayers);
    expect(geometry.width).toBeCloseTo(10.2, 6);
    // The door leaf stands inside the room, so the height is the walls' 6.2 m.
    expect(geometry.height).toBeCloseTo(6.2, 6);
  });

  it("gives walls and openings through the same detectors as a PDF, and closes the room", () => {
    const geometry = on(planLayers);
    const { candidates: wallCandidates } = findWallCandidates(geometry.segments);
    expect(wallCandidates).toHaveLength(7);
    const walls: Wall[] = wallCandidates.map((candidate, index) => ({
      id: `w${index}`, start: candidate.start, end: candidate.end, thickness: candidate.thickness, height: 2.7,
    }));
    for (const wall of walls) expect(wall.thickness).toBeCloseTo(0.2, 3);

    const { candidates } = findOpeningCandidates(geometry.segments, geometry.curves, walls);
    expect(candidates).toHaveLength(3);
    const door = candidates.find((item) => item.kind === "door" && item.confidence === "high")!;
    expect(door).toBeDefined();
    expect(door.source).toBe("wall-gap");
    expect(door.width).toBeCloseTo(0.9, 3);
    // DXF Y up means the door opens to −Y in plan coordinates; it runs along +X.
    expect(door.door).toEqual({ hinge: "start", side: "left" });
    expect(door.reasons.join(" ")).toMatch(/дуга открывания/);
    const window = candidates.find((item) => item.kind === "window" && item.confidence === "high")!;
    expect(window.width).toBeCloseTo(1.2, 3);
    const bare = candidates.find((item) => item.confidence === "low")!;
    expect(bare.width).toBeCloseTo(0.9, 3);
    expect(bare.reasons.join(" ")).toMatch(/тип не определён/);

    let plan: FloorPlan = { ...createEmptyPlan("dxf"), roomMode: "walls", walls };
    expect(detectWallRooms(plan.walls).rooms).toHaveLength(0);
    const fills = candidates.map((item, index): Wall => ({ id: `fill${index}`, ...item.fill! }));
    plan = addWallsAndOpenings(plan, fills, []);
    expect(detectWallRooms(plan.walls).rooms).toHaveLength(1);
    // The room inside 0.2 m walls of a 10 × 6 m axis rectangle.
    expect(detectWallRooms(plan.walls).rooms[0].area).toBeCloseTo(9.8 * 5.8, 2);
  });

  it("finds the same walls with furniture on, except where furniture really looks like a wall", () => {
    const noisy = findWallCandidates(on([...planLayers, "МЕБЕЛЬ"]).segments).candidates;
    // Two parallel lines of furniture 0.2 m apart pair up: why the dialog lets the layer be switched off.
    expect(noisy).toHaveLength(8);
  });
});
