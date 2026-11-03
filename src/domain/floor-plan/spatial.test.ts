import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "./operations";
import {
  buildWallSolids,
  FLOOR_THICKNESS,
  spatialBounds,
  type WallSolid,
} from "./spatial";
import type { Opening, Room, Wall } from "./types";

const wall: Wall = {
  id: "wall",
  start: { x: 0, y: 0 },
  end: { x: 3, y: 4 },
  thickness: 0.2,
  height: 3,
};
const door: Opening = {
  id: "door",
  wallId: wall.id,
  kind: "door",
  offset: 1,
  width: 0.9,
  height: 2.1,
  sillHeight: 0,
};
const room: Room = {
  id: "room",
  name: "Комната",
  kind: "living",
  color: "#e1e8db",
  x: -2,
  y: 7,
  width: 4,
  height: 2,
};

function volume(solids: WallSolid[]): number {
  return solids.reduce(
    (total, solid) => total + solid.length * solid.height * solid.thickness,
    0,
  );
}

describe("buildWallSolids", () => {
  it("creates a solid along the actual diagonal wall length", () => {
    expect(buildWallSolids(wall, [])).toEqual([
      {
        wallId: wall.id,
        offset: 0,
        length: 5,
        bottom: 0,
        height: 3,
        thickness: 0.2,
      },
    ]);
  });

  it("subtracts a door from floor level and retains its lintel", () => {
    const solids = buildWallSolids(wall, [door]);
    expect(solids).toHaveLength(3);
    expect(solids.map((solid) => solid.offset)).toEqual([0, 1, 1.9]);
    expect(solids[1].bottom).toBe(2.1);
    expect(solids[1].height).toBeCloseTo(0.9);
    expect(volume(solids)).toBeCloseTo(5 * 3 * 0.2 - 0.9 * 2.1 * 0.2);
    expect(solids.every((solid) => solid.height > 0 && solid.length > 0)).toBe(
      true,
    );
  });

  it("keeps both sill and lintel above and below a window", () => {
    const window: Opening = {
      ...door,
      kind: "window",
      width: 2,
      sillHeight: 0.8,
      height: 1.5,
    };
    const solids = buildWallSolids(wall, [window]);
    expect(solids).toHaveLength(4);
    expect(solids[1]).toMatchObject({
      offset: 1,
      length: 2,
      bottom: 0,
      height: 0.8,
    });
    expect(solids[2].bottom).toBeCloseTo(2.3);
    expect(solids[2].height).toBeCloseTo(0.7);
    expect(volume(solids)).toBeCloseTo(3 - 2 * 1.5 * 0.2);
  });

  it("sorts a copy and handles touching openings at both wall ends and top", () => {
    const first: Opening = {
      ...door,
      id: "first",
      offset: 0,
      width: 1,
      height: 3,
    };
    const second: Opening = {
      ...door,
      id: "second",
      kind: "window",
      offset: 1,
      width: 2,
      sillHeight: 1,
      height: 2,
    };
    const third: Opening = {
      ...door,
      id: "third",
      offset: 3,
      width: 2,
      height: 3,
    };
    const openings = Object.freeze([third, first, second]);
    const before = JSON.stringify({ wall, openings });
    const solids = buildWallSolids(wall, openings);
    expect(solids).toEqual([
      {
        wallId: wall.id,
        offset: 1,
        length: 2,
        bottom: 0,
        height: 1,
        thickness: 0.2,
      },
    ]);
    expect(JSON.stringify({ wall, openings })).toBe(before);
  });

  it("omits empty boxes when an opening fills the entire wall", () => {
    expect(
      buildWallSolids(wall, [{ ...door, offset: 0, width: 5, height: 3 }]),
    ).toEqual([]);
  });

  it("omits numerical slivers at opening edges and the wall top", () => {
    const solids = buildWallSolids(wall, [
      {
        ...door,
        offset: 0,
        width: 5 - 5e-10,
        height: 3 - 5e-10,
      },
    ]);
    expect(solids).toEqual([]);
  });

  it("clamps tolerance at the outer wall boundary without negative boxes", () => {
    const solids = buildWallSolids(wall, [
      { ...door, offset: 1, width: 4 + 5e-10, height: 3 + 5e-10 },
    ]);
    expect(solids).toEqual([
      {
        wallId: wall.id,
        offset: 0,
        length: 1,
        bottom: 0,
        height: 3,
        thickness: 0.2,
      },
    ]);
  });

  it("ignores openings belonging to a different wall", () => {
    expect(
      buildWallSolids(wall, [{ ...door, wallId: "other", width: Infinity }]),
    ).toEqual(buildWallSolids(wall, []));
  });

  it("retains start-relative offsets for reversed walls", () => {
    const reversed: Wall = { ...wall, start: wall.end, end: wall.start };
    expect(buildWallSolids(reversed, [door])).toEqual(
      buildWallSolids(wall, [door]),
    );
  });

  it.each([
    { offset: NaN },
    { width: Infinity },
    { height: NaN },
    { sillHeight: Infinity },
    { offset: -0.1 },
    { width: 0 },
    { height: -1 },
    { sillHeight: -1 },
    { offset: 4.5 },
    { sillHeight: 1 },
  ])("rejects invalid or out-of-wall opening geometry %#", (change) => {
    expect(() => buildWallSolids(wall, [{ ...door, ...change }])).toThrow();
  });

  it("rejects horizontal overlap even when vertical ranges are separate", () => {
    expect(() =>
      buildWallSolids(wall, [
        { ...door, height: 1 },
        {
          ...door,
          id: "upper",
          offset: 1.2,
          sillHeight: 2,
          height: 1,
        },
      ]),
    ).toThrow(/перекрываться/);
  });

  it.each([
    { ...wall, start: { x: NaN, y: 0 } },
    { ...wall, end: wall.start },
    { ...wall, thickness: 0 },
    { ...wall, thickness: Infinity },
    { ...wall, height: -1 },
    { ...wall, height: NaN },
  ])("rejects invalid wall geometry %#", (invalid) => {
    expect(() => buildWallSolids(invalid, [])).toThrow();
  });
});

describe("spatialBounds", () => {
  it("ignores inactive manual floors in wall mode and includes detected floor thickness", () => {
    const plan = {
      ...createEmptyPlan("plan"),
      roomMode: "walls" as const,
      rooms: [room],
      walls: [
        {
          id: "top",
          start: { x: 0, y: 0 },
          end: { x: 5, y: 0 },
          thickness: 0.2,
          height: 2.7,
        },
        {
          id: "right",
          start: { x: 5, y: 0 },
          end: { x: 5, y: 4 },
          thickness: 0.2,
          height: 2.7,
        },
        {
          id: "bottom",
          start: { x: 5, y: 4 },
          end: { x: 0, y: 4 },
          thickness: 0.2,
          height: 2.7,
        },
        {
          id: "left",
          start: { x: 0, y: 4 },
          end: { x: 0, y: 0 },
          thickness: 0.2,
          height: 2.7,
        },
      ],
    };
    expect(spatialBounds(plan)).toEqual({
      minX: -0.1,
      maxX: 5.1,
      minZ: -0.1,
      maxZ: 4.1,
      minY: -FLOOR_THICKNESS,
      maxY: 2.7,
    });
    expect(spatialBounds({ ...plan, walls: plan.walls.slice(0, 3) }).minY).toBe(
      0,
    );
    expect(spatialBounds({ ...plan, walls: [] })).toEqual(
      spatialBounds(createEmptyPlan("empty")),
    );
  });
  it("maps plan y to scene Z and includes floor thickness below zero", () => {
    const plan = { ...createEmptyPlan("plan"), rooms: [room] };
    expect(spatialBounds(plan)).toEqual({
      minX: -2,
      maxX: 2,
      minZ: 7,
      maxZ: 9,
      minY: -FLOOR_THICKNESS,
      maxY: 0,
    });
  });

  it("uses actual diagonal wall corners rather than padding every axis equally", () => {
    const plan = { ...createEmptyPlan("plan"), walls: [wall] };
    const bounds = spatialBounds(plan);
    expect(bounds.minX).toBeCloseTo(-0.08);
    expect(bounds.maxX).toBeCloseTo(3.08);
    expect(bounds.minZ).toBeCloseTo(-0.06);
    expect(bounds.maxZ).toBeCloseTo(4.06);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxY).toBe(3);
    expect(
      spatialBounds({
        ...plan,
        walls: [{ ...wall, start: wall.end, end: wall.start }],
      }),
    ).toEqual(bounds);
  });

  it("combines negative-coordinate walls, floors, and variable heights", () => {
    const plan = {
      ...createEmptyPlan("plan"),
      rooms: [room],
      walls: [
        {
          ...wall,
          start: { x: -9, y: -8 },
          end: { x: -5, y: -8 },
          height: 4,
        },
        {
          ...wall,
          id: "vertical",
          start: { x: -5, y: -8 },
          end: { x: -5, y: -3 },
          height: 2,
        },
      ],
    };
    expect(spatialBounds(plan)).toEqual({
      minX: -9,
      maxX: 2,
      minZ: -8.1,
      maxZ: 9,
      minY: -FLOOR_THICKNESS,
      maxY: 4,
    });
  });

  it("ignores raster extent and retains bounds for an internally contained swing", () => {
    const plan = {
      ...createEmptyPlan("plan"),
      walls: [wall],
      openings: [door],
      underlay: {
        name: "Plan.png",
        dataUrl: "data:image/png;base64,AAAA",
        pixelWidth: 1000,
        pixelHeight: 1000,
        x: -500,
        y: -500,
        metersPerPixel: 1,
        opacity: 0.5,
        visible: true,
        calibrated: true,
      },
    };
    const before = JSON.stringify(plan);
    expect(spatialBounds(plan)).toEqual(
      spatialBounds({ ...createEmptyPlan("plan"), walls: [wall] }),
    );
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("fits an exterior door leaf and its thickness on either side of a wall", () => {
    const horizontal: Wall = {
      ...wall,
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
    };
    const opening: Opening = { ...door, width: 1 };
    const plan = { ...createEmptyPlan("plan"), walls: [horizontal], openings: [opening] };
    const before = JSON.stringify(plan);
    expect(spatialBounds(plan)).toEqual({
      minX: 0,
      maxX: 4,
      minZ: -1.0225,
      maxZ: 0.1,
      minY: 0,
      maxY: 3,
    });
    expect(spatialBounds({
      ...plan,
      openings: [{ ...opening, door: { hinge: "end", side: "right" } }],
    })).toEqual({
      minX: 0,
      maxX: 4,
      minZ: -0.1,
      maxZ: 1.0225,
      minY: 0,
      maxY: 3,
    });
    expect(spatialBounds({
      ...plan,
      openings: [{ ...opening, kind: "window" }],
    })).toEqual(spatialBounds({ ...plan, openings: [] }));
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("includes the analytical diagonal sweep beyond all sampled leaf endpoints", () => {
    const angle = 17 * Math.PI / 180;
    const diagonal: Wall = {
      ...wall,
      start: { x: 0, y: 0 },
      end: { x: 2 * Math.cos(angle), y: 2 * Math.sin(angle) },
      thickness: 0.02,
    };
    const plan = {
      ...createEmptyPlan("plan"),
      walls: [diagonal],
      openings: [{ ...door, width: 1, offset: 1 }],
    };
    const bounds = spatialBounds(plan);
    expect(bounds.maxX).toBeCloseTo(Math.cos(angle) + 1 + 0.0032, 12);
    expect(bounds.minZ).toBeCloseTo(Math.sin(angle) - Math.cos(angle) - 0.0032, 12);
  });

  it("returns stable useful defaults for a plan without geometry", () => {
    expect(spatialBounds(createEmptyPlan("plan"))).toEqual({
      minX: -4,
      maxX: 4,
      minZ: -4,
      maxZ: 4,
      minY: 0,
      maxY: 2.7,
    });
  });

  it("rejects invalid bounds instead of propagating nonfinite camera positions", () => {
    expect(() =>
      spatialBounds({
        ...createEmptyPlan("plan"),
        rooms: [{ ...room, width: NaN }],
      }),
    ).toThrow();
    expect(() =>
      spatialBounds({
        ...createEmptyPlan("plan"),
        walls: [{ ...wall, thickness: Infinity }],
      }),
    ).toThrow();
  });
});
