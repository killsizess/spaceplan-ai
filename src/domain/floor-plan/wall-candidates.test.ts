import { describe, expect, it } from "vitest";
import type { Point } from "@/domain/geometry";
import { findWallCandidates, MAX_CANDIDATE_SEGMENTS, type LineSegment, type WallCandidate } from "./wall-candidates";
import { buildWallTopology } from "./wall-topology";
import { detectWallRooms } from "./wall-rooms";
import type { Wall } from "./types";

const seg = (x1: number, y1: number, x2: number, y2: number): LineSegment => ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
/** Outline of a filled rectangle, as a PDF fill path gives it. */
const box = (x1: number, y1: number, x2: number, y2: number): LineSegment[] =>
  [seg(x1, y1, x2, y1), seg(x2, y1, x2, y2), seg(x2, y2, x1, y2), seg(x1, y2, x1, y1)];
const toWalls = (candidates: readonly WallCandidate[]): Wall[] =>
  candidates.map((candidate, index) => ({ id: `c${index}`, ...candidate, height: 2.7 }));
const rotate = (angle: number) => (point: Point): Point => ({
  x: point.x * Math.cos(angle) - point.y * Math.sin(angle) + 40,
  y: point.x * Math.sin(angle) + point.y * Math.cos(angle) + 25,
});

/**
 * The reference apartment (10 × 6 m, 0.2 m walls, partition at x = 6, branch at y = 3)
 * drawn the way plans draw walls: outer and inner face lines, faces broken where
 * other walls meet them.
 */
function apartmentDrawing(): LineSegment[] {
  return [
    // Outer faces of the exterior walls.
    seg(-0.1, -0.1, 10.1, -0.1), seg(10.1, -0.1, 10.1, 6.1), seg(10.1, 6.1, -0.1, 6.1), seg(-0.1, 6.1, -0.1, -0.1),
    // Inner faces, split by the partition and the branch.
    seg(0.1, 0.1, 5.9, 0.1), seg(6.1, 0.1, 9.9, 0.1),
    seg(0.1, 5.9, 5.9, 5.9), seg(6.1, 5.9, 9.9, 5.9),
    seg(0.1, 0.1, 0.1, 5.9),
    seg(9.9, 0.1, 9.9, 2.9), seg(9.9, 3.1, 9.9, 5.9),
    // Partition faces; the right face is split by the branch.
    seg(5.9, 0.1, 5.9, 5.9), seg(6.1, 0.1, 6.1, 2.9), seg(6.1, 3.1, 6.1, 5.9),
    // Branch faces.
    seg(6.1, 2.9, 9.9, 2.9), seg(6.1, 3.1, 9.9, 3.1),
  ];
}

describe("wall candidates from drawing lines", () => {
  it("turns a double-line rectangle into four walls joined at the corners", () => {
    const { candidates, truncated } = findWallCandidates([...box(-0.1, -0.1, 5.1, 4.1), ...box(0.1, 0.1, 4.9, 3.9)]);
    expect(truncated).toBe(false);
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) expect(candidate.thickness).toBe(0.2);
    const corners = new Set(candidates.flatMap((candidate) => [candidate.start, candidate.end]).map((point) => `${point.x},${point.y}`));
    expect([...corners].sort()).toEqual(["0,0", "0,4", "5,0", "5,4"]);
    const rooms = detectWallRooms(toWalls(candidates)).rooms;
    expect(rooms.map((room) => room.area)).toEqual([expect.closeTo(4.8 * 3.8, 9)]);
  });

  it("rebuilds the reference apartment: shared corners, T-junctions and the same three rooms", () => {
    const { candidates } = findWallCandidates(apartmentDrawing());
    const walls = toWalls(candidates);
    const topology = buildWallTopology(walls);
    // Corners and T-joints are real graph connections, not near misses.
    expect(topology.nodes.filter((node) => node.ends.length >= 2).length + topology.contacts.length).toBeGreaterThanOrEqual(6);
    const areas = detectWallRooms(walls).rooms.map((room) => room.area).sort((a, b) => a - b);
    expect(areas).toEqual([expect.closeTo(10.64, 9), expect.closeTo(10.64, 9), expect.closeTo(5.8 * 5.8, 9)]);
  });

  it("does not depend on the drawing's rotation and position", () => {
    const turn = rotate((17 * Math.PI) / 180);
    const turned = apartmentDrawing().map(({ start, end }) => ({ start: turn(start), end: turn(end) }));
    const { candidates } = findWallCandidates(turned);
    const areas = detectWallRooms(toWalls(candidates)).rooms.map((room) => room.area).sort((a, b) => a - b);
    expect(areas).toEqual([expect.closeTo(10.64, 6), expect.closeTo(10.64, 6), expect.closeTo(5.8 * 5.8, 6)]);
  });

  it("merges dashed or split face lines and reads mixed thickness", () => {
    // A 0.3 m wall whose outer face is drawn in three pieces, and a 0.1 m partition.
    const lines = [
      seg(0, 0, 2, 0), seg(2.01, 0, 4, 0), seg(4, 0, 6, 0),
      seg(0, 0.3, 6, 0.3),
      seg(3, 0.3, 3, 4), seg(3.1, 0.3, 3.1, 4),
    ];
    const { candidates } = findWallCandidates(lines);
    expect(candidates.map((candidate) => candidate.thickness).sort()).toEqual([0.1, 0.3]);
    const exterior = candidates.find((candidate) => candidate.thickness === 0.3)!;
    expect(Math.abs(exterior.end.x - exterior.start.x)).toBeCloseTo(6, 9);
    // The partition reaches the exterior wall's centre line: a T-contact.
    const partition = candidates.find((candidate) => candidate.thickness === 0.1)!;
    expect(Math.min(partition.start.y, partition.end.y)).toBeCloseTo(0.15, 9);
  });

  it("ignores single lines, distant parallels, short pairs and hatching", () => {
    const hatching = Array.from({ length: 8 }, (_, index) => seg(index * 0.08, 10, index * 0.08 + 1, 11));
    const { candidates } = findWallCandidates([
      seg(0, 0, 8, 0), // a lone line
      seg(0, 2, 8, 2), seg(0, 3, 8, 3), // 1 m apart: not a wall
      seg(0, 5, 0.2, 5), seg(0, 5.1, 0.2, 5.1), // 0.2 m long pair
      seg(0, 7, 4, 7), seg(0, 7.02, 4, 7.02), // 2 cm apart: a line weight, not a wall
      ...hatching,
    ]);
    expect(candidates).toEqual([]);
  });

  it("skips candidates already covered by plan walls and survives malformed input", () => {
    const drawing = [...box(-0.1, -0.1, 5.1, 4.1), ...box(0.1, 0.1, 4.9, 3.9)];
    const existing: Wall[] = [{ id: "top", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 }];
    expect(findWallCandidates(drawing, existing).candidates).toHaveLength(3);
    const broken = [seg(Number.NaN, 0, 1, 1), seg(0, 0, 0, 0), ...drawing];
    expect(findWallCandidates(broken).candidates).toHaveLength(4);
    const many = Array.from({ length: MAX_CANDIDATE_SEGMENTS + 1 }, () => seg(0, 0, 0.01, 0));
    expect(findWallCandidates(many).truncated).toBe(true);
  });
});
