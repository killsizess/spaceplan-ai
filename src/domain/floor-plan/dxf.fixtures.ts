/** A small DXF writer for tests: the real format, written the way CAD programs write it. */
export type DxfPairs = readonly (readonly [number, string | number])[];

const write = (pairs: DxfPairs) => pairs.map(([code, value]) => `  ${code}\n${value}`).join("\n");

export const dxfLine = (layer: string, x1: number, y1: number, x2: number, y2: number): DxfPairs => [
  [0, "LINE"], [8, layer], [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0],
];
export const dxfArc = (layer: string, cx: number, cy: number, r: number, from: number, to: number, extra: DxfPairs = []): DxfPairs => [
  [0, "ARC"], [8, layer], [10, cx], [20, cy], [30, 0], [40, r], [50, from], [51, to], ...extra,
];
export const dxfCircle = (layer: string, cx: number, cy: number, r: number): DxfPairs => [
  [0, "CIRCLE"], [8, layer], [10, cx], [20, cy], [40, r],
];
export const dxfLwPolyline = (layer: string, vertices: readonly (readonly [number, number, number?])[], closed = false, extra: DxfPairs = []): DxfPairs => [
  [0, "LWPOLYLINE"], [8, layer], [90, vertices.length], [70, closed ? 1 : 0], ...extra,
  ...vertices.flatMap(([x, y, bulge]): DxfPairs => [[10, x], [20, y], ...(bulge ? [[42, bulge] as const] : [])]),
];
export const dxfPolyline = (layer: string, vertices: readonly (readonly [number, number, number?])[], closed = false): DxfPairs => [
  [0, "POLYLINE"], [8, layer], [66, 1], [70, closed ? 1 : 0],
  ...vertices.flatMap(([x, y, bulge]): DxfPairs => [[0, "VERTEX"], [8, layer], [10, x], [20, y], ...(bulge ? [[42, bulge] as const] : [])]),
  [0, "SEQEND"], [8, layer],
];
export const dxfInsert = (
  layer: string,
  name: string,
  x: number,
  y: number,
  options: { sx?: number; sy?: number; rotation?: number; cols?: number; rows?: number; dx?: number; dy?: number; extrusionZ?: number } = {},
): DxfPairs => [
  [0, "INSERT"], [8, layer], [2, name], [10, x], [20, y], [30, 0],
  ...(options.sx !== undefined ? [[41, options.sx] as const] : []),
  ...(options.sy !== undefined ? [[42, options.sy] as const] : []),
  ...(options.rotation !== undefined ? [[50, options.rotation] as const] : []),
  ...(options.cols !== undefined ? [[70, options.cols] as const] : []),
  ...(options.rows !== undefined ? [[71, options.rows] as const] : []),
  ...(options.dx !== undefined ? [[44, options.dx] as const] : []),
  ...(options.dy !== undefined ? [[45, options.dy] as const] : []),
  ...(options.extrusionZ !== undefined ? [[230, options.extrusionZ] as const] : []),
];

export interface DxfBlockSource {
  name: string;
  base?: readonly [number, number];
  flags?: number;
  entities: readonly DxfPairs[];
}

export function dxfFile({
  units,
  version = "AC1027",
  layers = [],
  blocks = [],
  entities = [],
}: {
  units?: number;
  version?: string;
  layers?: readonly { name: string; flags?: number; color?: number }[];
  blocks?: readonly DxfBlockSource[];
  entities?: readonly DxfPairs[];
}): string {
  const header: DxfPairs = [
    [0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, version],
    ...(units !== undefined ? [[9, "$INSUNITS"] as const, [70, units] as const] : []),
    [0, "ENDSEC"],
  ];
  const tables: DxfPairs = [
    [0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, "LAYER"], [70, layers.length],
    ...layers.flatMap((layer): DxfPairs => [[0, "LAYER"], [2, layer.name], [70, layer.flags ?? 0], [62, layer.color ?? 7], [6, "CONTINUOUS"]]),
    [0, "ENDTAB"], [0, "ENDSEC"],
  ];
  const blockSection: DxfPairs = [
    [0, "SECTION"], [2, "BLOCKS"],
    ...blocks.flatMap((block): DxfPairs => [
      [0, "BLOCK"], [8, "0"], [2, block.name], [70, block.flags ?? 0], [10, block.base?.[0] ?? 0], [20, block.base?.[1] ?? 0], [30, 0], [3, block.name],
      ...block.entities.flat(),
      [0, "ENDBLK"], [8, "0"],
    ]),
    [0, "ENDSEC"],
  ];
  const entitySection: DxfPairs = [[0, "SECTION"], [2, "ENTITIES"], ...entities.flat(), [0, "ENDSEC"]];
  return `${write([...header, ...tables, ...blockSection, ...entitySection, [0, "EOF"]])}\n`;
}

/**
 * The same 10 × 6 m apartment as the PDF fixture, in millimetres, on separate layers:
 * walls with a door gap, a window gap and a bare gap; the door is a block, as in real
 * CAD drawings (a leaf and a swing arc), the window has two glazing lines; a sofa on its
 * own layer, off by default, plus a table on a layer the user has to switch off.
 */
export function apartmentDxf(): string {
  const mm = (value: number) => Math.round(value * 1000);
  const faces: readonly (readonly [number, number, number, number])[] = [
    [-0.1, -0.1, 2.0, -0.1], [2.9, -0.1, 10.1, -0.1],
    [10.1, -0.1, 10.1, 2.0], [10.1, 3.2, 10.1, 6.1],
    [10.1, 6.1, -0.1, 6.1],
    [-0.1, 6.1, -0.1, 4.9], [-0.1, 4.0, -0.1, -0.1],
    [0.1, 0.1, 2.0, 0.1], [2.9, 0.1, 9.9, 0.1],
    [9.9, 0.1, 9.9, 2.0], [9.9, 3.2, 9.9, 5.9],
    [9.9, 5.9, 0.1, 5.9],
    [0.1, 5.9, 0.1, 4.9], [0.1, 4.0, 0.1, 0.1],
  ];
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => dxfLine(layer, mm(x1), mm(y1), mm(x2), mm(y2));
  return dxfFile({
    units: 4,
    layers: [{ name: "СТЕНЫ" }, { name: "ДВЕРИ" }, { name: "ОКНА" }, { name: "МЕБЕЛЬ" }, { name: "ОФОРМЛЕНИЕ", color: -7 }],
    blocks: [{
      name: "ДВЕРЬ-900",
      entities: [dxfLine("0", 0, 0, 0, 900), dxfArc("0", 0, 0, 900, 0, 90), dxfLine("0", 0, -100, 0, 100), dxfLine("0", 900, -100, 900, 100)],
    }],
    entities: [
      ...faces.map(([x1, y1, x2, y2]) => line("СТЕНЫ", x1, y1, x2, y2)),
      // The door block: hinge at x = 2.0 m on the bottom wall axis, opening up into the room.
      dxfInsert("ДВЕРИ", "ДВЕРЬ-900", mm(2.0), 0),
      // The window in the right wall: jambs and two glazing lines.
      line("ОКНА", 9.9, 2.0, 10.1, 2.0), line("ОКНА", 9.9, 3.2, 10.1, 3.2),
      line("ОКНА", 9.95, 2.0, 9.95, 3.2), line("ОКНА", 10.05, 2.0, 10.05, 3.2),
      // A round table and a stray line that only make noise.
      dxfCircle("МЕБЕЛЬ", mm(5), mm(3), 500), line("МЕБЕЛЬ", 6, 4, 8, 4), line("МЕБЕЛЬ", 6, 4.2, 8, 4.2),
      // Off in the file: must start switched off.
      line("ОФОРМЛЕНИЕ", -5, -5, 15, -5),
    ],
  });
}
