import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { connectWallJunction } from "./connect-wall-junction";
import { deleteObject, moveWallNode, updateWall } from "./construction";
import { createSpatialExamplePlan } from "./examples";
import { createEmptyPlan } from "./operations";
import type { FloorPlan, Wall } from "./types";
import { analyzeWallConnections } from "./wall-diagnostics";
import { analyzeWallIntersections } from "./wall-intersections";
import { buildWallTopology, type WallTopology } from "./wall-topology";

function wall(id: string, start: Point, end: Point): Wall {
  return { id, start, end, thickness: 0.2, height: 2.7 };
}

function square(): Wall[] {
  return [
    wall("top", { x: 0, y: 0 }, { x: 5, y: 0 }),
    wall("right", { x: 5, y: 0 }, { x: 5, y: 4 }),
    wall("bottom", { x: 5, y: 4 }, { x: 0, y: 4 }),
    wall("left", { x: 0, y: 4 }, { x: 0, y: 0 }),
  ];
}

const keyOf = (wallId: string, endpoint: "start" | "end") => `node:${JSON.stringify([wallId, endpoint])}`;
const nodeKeys = (topology: WallTopology) => topology.nodes.map((node) => node.key);

/** Small deterministic PRNG so random plans are reproducible. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walls on a coarse grid, so coincident ends, T-contacts and crossings are common. */
function randomWalls(seed: number, count: number): Wall[] {
  const next = random(seed);
  const coordinate = () => Math.floor(next() * 7) * 0.5;
  const walls: Wall[] = [];
  while (walls.length < count) {
    const start = { x: coordinate(), y: coordinate() };
    const end = next() < 0.5 ? { x: coordinate(), y: start.y } : { x: start.x, y: coordinate() };
    if (start.x !== end.x || start.y !== end.y) walls.push(wall(`w${String(walls.length).padStart(2, "0")}`, start, end));
  }
  return walls;
}

describe("derived wall topology", () => {
  it("turns a closed square into four two-end nodes named after their first wall end", () => {
    const topology = buildWallTopology(square());
    expect(topology.nodes).toEqual([
      { key: keyOf("bottom", "end"), point: { x: 0, y: 4 }, ends: [{ wallId: "bottom", endpoint: "end" }, { wallId: "left", endpoint: "start" }] },
      { key: keyOf("bottom", "start"), point: { x: 5, y: 4 }, ends: [{ wallId: "bottom", endpoint: "start" }, { wallId: "right", endpoint: "end" }] },
      { key: keyOf("left", "end"), point: { x: 0, y: 0 }, ends: [{ wallId: "left", endpoint: "end" }, { wallId: "top", endpoint: "start" }] },
      { key: keyOf("right", "start"), point: { x: 5, y: 0 }, ends: [{ wallId: "right", endpoint: "start" }, { wallId: "top", endpoint: "end" }] },
    ]);
    expect(topology.edges).toEqual([
      { wallId: "bottom", start: keyOf("bottom", "start"), end: keyOf("bottom", "end"), length: 5 },
      { wallId: "left", start: keyOf("bottom", "end"), end: keyOf("left", "end"), length: 4 },
      { wallId: "right", start: keyOf("right", "start"), end: keyOf("bottom", "start"), length: 4 },
      { wallId: "top", start: keyOf("left", "end"), end: keyOf("right", "start"), length: 5 },
    ]);
    expect(topology.contacts).toEqual([]);
    expect(topology.crossings).toEqual([]);
    expect(topology.components).toEqual([["bottom", "left", "right", "top"]]);
    expect(buildWallTopology([])).toEqual({ nodes: [], edges: [], contacts: [], crossings: [], components: [] });
  });

  it("separates shared nodes, unsplit T-contacts, crossings and isolated walls", () => {
    const topology = buildWallTopology([
      wall("trunk", { x: 0, y: 0 }, { x: 4, y: 0 }),
      wall("branch", { x: 2, y: 0 }, { x: 2, y: 2 }),
      wall("cross-a", { x: 10, y: 0 }, { x: 12, y: 0 }),
      wall("cross-b", { x: 11, y: -1 }, { x: 11, y: 1 }),
      wall("corner-a", { x: 20, y: 0 }, { x: 21, y: 0 }),
      wall("corner-b", { x: 21, y: 0 }, { x: 21, y: 1 }),
      wall("corner-c", { x: 22, y: 0 }, { x: 21, y: 0 }),
      wall("alone", { x: 30, y: 0 }, { x: 31, y: 0 }),
    ]);
    expect(topology.contacts).toEqual([{ node: keyOf("branch", "start"), wallId: "trunk", offset: 2 }]);
    expect(topology.crossings).toEqual([{ wallIds: ["cross-a", "cross-b"], point: { x: 11, y: 0 } }]);
    expect(topology.nodes.find((node) => node.key === keyOf("corner-a", "end"))?.ends).toEqual([
      { wallId: "corner-a", endpoint: "end" },
      { wallId: "corner-b", endpoint: "start" },
      { wallId: "corner-c", endpoint: "end" },
    ]);
    // 16 wall ends; the three-wall corner merges three of them into one node.
    expect(topology.nodes).toHaveLength(14);
    expect(topology.components).toEqual([
      ["alone"], ["branch", "trunk"], ["corner-a", "corner-b", "corner-c"], ["cross-a", "cross-b"],
    ]);
  });

  it("describes the shipped 3D example as one structure of four corners and ten unsplit T-contacts", () => {
    const topology = buildWallTopology(createSpatialExamplePlan().walls);
    expect(topology.nodes).toHaveLength(14);
    expect(topology.nodes.filter((node) => node.ends.length === 2)).toHaveLength(4);
    expect(topology.contacts).toHaveLength(10);
    expect(topology.contacts.find((contact) => contact.wallId === "partition-h4" && contact.node === keyOf("partition-v5", "end")))
      .toEqual({ node: keyOf("partition-v5", "end"), wallId: "partition-h4", offset: 5 });
    expect(topology.crossings).toEqual([]);
    expect(topology.components).toHaveLength(1);
  });

  it("uses the shared-node tolerance and groups sub-nanometre chains transitively", () => {
    const source = wall("a", { x: 0, y: -1 }, { x: 0, y: 0 });
    const joined = buildWallTopology([source, wall("b", { x: 1e-9, y: 0 }, { x: 1, y: 0 })]);
    expect(joined.nodes).toHaveLength(3);
    for (const start of [{ x: 1.01e-9, y: 0 }, { x: 0.8e-9, y: 0.8e-9 }]) {
      expect(buildWallTopology([source, wall("b", start, { x: 1, y: 0 })]).nodes).toHaveLength(4);
    }
    const chain = buildWallTopology([
      wall("a", { x: 0, y: 0 }, { x: 0, y: 1 }),
      wall("b", { x: 0.8e-9, y: 0 }, { x: 1, y: 0 }),
      wall("c", { x: 1.6e-9, y: 0 }, { x: 0, y: -1 }),
    ]);
    expect(chain.nodes.find((node) => node.ends.length === 3)?.key).toBe(keyOf("a", "start"));
  });

  it("is independent of input order and never aliases or mutates the input", () => {
    const walls = randomWalls(7, 30);
    const before = structuredClone(walls);
    walls.forEach((item) => Object.freeze(item));
    const topology = buildWallTopology(Object.freeze([...walls]));
    expect(buildWallTopology([...walls].reverse())).toEqual(topology);
    expect(buildWallTopology([...walls.slice(11), ...walls.slice(0, 11)])).toEqual(topology);
    expect(walls).toEqual(before);
    const first = topology.nodes[0];
    const owner = walls.find((item) => item.id === first.ends[0].wallId)!;
    expect(first.point).not.toBe(owner[first.ends[0].endpoint]);
  });

  it("keeps node keys through node moves and wall translations", () => {
    const plan: FloorPlan = { ...createEmptyPlan("keys"), walls: square() };
    const original = buildWallTopology(plan.walls);
    const moved = buildWallTopology(moveWallNode(plan, "top", "end", { x: 6, y: -1 }).walls);
    expect(nodeKeys(moved)).toEqual(nodeKeys(original));
    expect(moved.nodes.map((node) => node.ends)).toEqual(original.nodes.map((node) => node.ends));
    expect(moved.nodes.find((node) => node.key === keyOf("right", "start"))?.point).toEqual({ x: 6, y: -1 });
    const top = plan.walls[0];
    const shifted = updateWall(plan, { ...top, start: { x: 0, y: -1 }, end: { x: 5, y: -1 } });
    expect(buildWallTopology(shifted.walls).edges).toEqual(original.edges.map((edge) =>
      edge.wallId === "left" || edge.wallId === "right" ? { ...edge, length: 5 } : edge,
    ));
  });

  it("turns an explicit T-junction into a shared node and renames only the nodes that changed", () => {
    const plan: FloorPlan = {
      ...createEmptyPlan("junction"),
      walls: [...square(), wall("partition", { x: 2, y: 0.2 }, { x: 2, y: 4 })],
    };
    const before = buildWallTopology(plan.walls);
    expect(before.contacts).toEqual([{ node: keyOf("partition", "end"), wallId: "bottom", offset: 3 }]);
    const diagnostic = analyzeWallConnections(plan.walls).find((item) => item.wallId === "partition" && item.endpoint === "start")!;
    const joined = buildWallTopology(connectWallJunction(plan, diagnostic, "top-2").walls);
    const node = joined.nodes.find((item) => item.ends.some((end) => end.wallId === "top-2"))!;
    expect(node.key).toBe(keyOf("partition", "start"));
    expect(node.ends).toEqual([
      { wallId: "partition", endpoint: "start" },
      { wallId: "top", endpoint: "end" },
      { wallId: "top-2", endpoint: "start" },
    ]);
    // The other corner of the split wall used to be named after "right:start" and still is.
    expect(joined.nodes.find((item) => item.key === keyOf("right", "start"))?.ends).toEqual([
      { wallId: "right", endpoint: "start" },
      { wallId: "top-2", endpoint: "end" },
    ]);
    expect(joined.contacts).toEqual(before.contacts);
    expect(joined.components).toHaveLength(1);
    const removed = buildWallTopology(deleteObject(plan, "partition").walls);
    expect(nodeKeys(removed)).toEqual(nodeKeys(buildWallTopology(square())));
  });

  it("agrees with the connection and crossing diagnostics on random grid plans", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const walls = randomWalls(seed, 6 + (seed % 15));
      const topology = buildWallTopology(walls);
      const nodes = new Map(topology.nodes.map((node) => [node.key, node]));
      const diagnostics = analyzeWallConnections(walls);
      for (const edge of topology.edges) {
        for (const endpoint of ["start", "end"] as const) {
          const node = nodes.get(edge[endpoint])!;
          const free = !node.ends.some((end) => end.wallId !== edge.wallId);
          const diagnostic = diagnostics.find((item) => item.wallId === edge.wallId && item.endpoint === endpoint);
          expect(Boolean(diagnostic), `seed ${seed} ${edge.wallId}:${endpoint}`).toBe(free);
          const contacts = topology.contacts.filter((contact) => contact.node === node.key);
          if (diagnostic) expect(diagnostic.kind === "junction").toBe(contacts.length > 0);
          if (diagnostic?.kind === "junction") {
            expect(contacts.map((contact) => contact.wallId)).toContain(diagnostic.target.wallId);
          }
        }
      }
      const crossings = analyzeWallIntersections(walls);
      expect(crossings.truncated).toBe(false);
      expect(topology.crossings).toEqual(crossings.intersections.map(({ wallIds, point }) => ({ wallIds, point })));
    }
  });

  it("keeps structural invariants on random plans", () => {
    for (let seed = 100; seed < 130; seed++) {
      const walls = randomWalls(seed, 4 + (seed % 20));
      const topology = buildWallTopology(walls);
      const ends = topology.nodes.flatMap((node) => node.ends.map((end) => `${end.wallId}:${end.endpoint}`));
      expect(new Set(ends).size).toBe(walls.length * 2);
      expect(ends).toHaveLength(walls.length * 2);
      const keys = new Set(nodeKeys(topology));
      expect(nodeKeys(topology)).toEqual([...keys].sort());
      for (const node of topology.nodes) {
        expect(node.key).toBe(keyOf(node.ends[0].wallId, node.ends[0].endpoint));
        const owner = walls.find((item) => item.id === node.ends[0].wallId)!;
        expect(node.point).toEqual(owner[node.ends[0].endpoint]);
      }
      for (const edge of topology.edges) {
        expect(keys.has(edge.start) && keys.has(edge.end)).toBe(true);
      }
      for (const contact of topology.contacts) {
        const node = topology.nodes.find((item) => item.key === contact.node)!;
        const host = topology.edges.find((edge) => edge.wallId === contact.wallId)!;
        expect(node.ends.some((end) => end.wallId === contact.wallId)).toBe(false);
        expect(contact.offset).toBeGreaterThan(0);
        expect(contact.offset).toBeLessThan(host.length);
      }
      expect(topology.components.flat().sort()).toEqual(walls.map((item) => item.id).sort());
    }
  });

  it("rejects invalid walls like the other wall analyses", () => {
    const valid = wall("a", { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(() => buildWallTopology([valid, valid])).toThrow(/уникальными/);
    for (const id of ["", "x".repeat(101)]) {
      expect(() => buildWallTopology([{ ...valid, id }])).toThrow(/идентификатор/);
    }
    expect(() => buildWallTopology([{ ...valid, end: { x: NaN, y: 0 } }])).toThrow(/Координаты/);
    expect(() => buildWallTopology([{ ...valid, end: valid.start }])).toThrow(/ненулевую/);
    const tooMany = Array.from({ length: 1001 }, (_, index) => ({ ...valid, id: `wall-${index}` }));
    expect(() => buildWallTopology(tooMany)).toThrow(/1000 стен/);
  });
});
