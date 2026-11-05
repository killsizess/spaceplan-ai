import { tr } from "@/lib/i18n";
import { assertPoint, MAX_COORDINATE, wallLength, type Point } from "@/domain/geometry";
import type { Wall } from "./types";
import type { WallEndpoint } from "./wall-nodes";
import { buildWallTopology } from "./wall-topology";

export interface WallConnectionTarget {
  readonly wallId: string;
  readonly point: Point;
  readonly endpoint?: WallEndpoint;
}

interface WallConnectionSource {
  readonly id: string;
  readonly wallId: string;
  readonly endpoint: WallEndpoint;
  readonly point: Point;
}

export type WallConnectionDiagnostic = WallConnectionSource & (
  | { readonly kind: "open"; readonly target?: never; readonly distance?: never }
  | {
    readonly kind: "near-endpoint" | "near-wall" | "junction";
    readonly target: WallConnectionTarget;
    readonly distance: number;
  }
);

interface Endpoint {
  wallId: string;
  endpoint: WallEndpoint;
  point: Point;
}

interface Candidate {
  target: WallConnectionTarget;
  distance: number;
}

const TOLERANCE = 1e-9;
const ENDPOINTS: readonly WallEndpoint[] = ["start", "end"];

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function preferCandidate(candidate: Candidate, previous: Candidate | null): boolean {
  if (!previous) return true;
  const delta = candidate.distance - previous.distance;
  const roundingTolerance = Number.EPSILON * 8 * Math.max(1, candidate.distance, previous.distance);
  if (Math.abs(delta) > roundingTolerance) return delta < 0;
  const candidateEndpoint = candidate.target.endpoint !== undefined;
  const previousEndpoint = previous.target.endpoint !== undefined;
  if (candidateEndpoint !== previousEndpoint) return candidateEndpoint;
  const wallOrder = compareIds(candidate.target.wallId, previous.target.wallId);
  if (wallOrder !== 0) return wallOrder < 0;
  return candidate.target.endpoint === "start" && previous.target.endpoint === "end";
}

/**
 * Reports only endpoints whose topology node holds no other wall's end. Distances
 * are between wall axes; wall thickness, openings and physical room closure are
 * not evaluated. A mid-wall junction is reported, not converted into a shared
 * node. No input objects or saved geometry are changed.
 */
export function analyzeWallConnections(
  walls: readonly Wall[],
  nearDistance = 0.3,
): WallConnectionDiagnostic[] {
  if (!Number.isFinite(nearDistance) || nearDistance < 0 || nearDistance > MAX_COORDINATE) {
    throw new Error(tr`Расстояние поиска должно быть числом от 0 до 1000 м.`);
  }
  if (walls.length > 1000) throw new Error(tr`Диагностика поддерживает не больше 1000 стен.`);

  const ids = new Set<string>();
  for (const wall of walls) {
    if (typeof wall.id !== "string" || wall.id.length < 1 || wall.id.length > 100) {
      throw new Error(tr`Некорректный идентификатор стены.`);
    }
    if (ids.has(wall.id)) throw new Error(tr`Идентификаторы стен должны быть уникальными.`);
    ids.add(wall.id);
    assertPoint(wall.start);
    assertPoint(wall.end);
    wallLength(wall.start, wall.end);
  }

  const sortedWalls = [...walls].sort((a, b) => compareIds(a.id, b.id));
  const endpoints: Endpoint[] = sortedWalls.flatMap((wall) =>
    ENDPOINTS.map((endpoint) => ({ wallId: wall.id, endpoint, point: wall[endpoint] })),
  );
  const topology = buildWallTopology(walls);
  const nodes = new Map(topology.nodes.map((node) => [node.key, node]));
  const joined = new Set<string>();
  for (const edge of topology.edges) {
    for (const endpoint of ENDPOINTS) {
      if (nodes.get(edge[endpoint])!.ends.some((end) => end.wallId !== edge.wallId)) {
        joined.add(JSON.stringify([edge.wallId, endpoint]));
      }
    }
  }
  const diagnostics: WallConnectionDiagnostic[] = [];

  for (const source of endpoints) {
    if (joined.has(JSON.stringify([source.wallId, source.endpoint]))) continue;
    // No other wall end lies within the node tolerance of a free end.
    let nearest: Candidate | null = null;
    for (const target of endpoints) {
      if (target.wallId === source.wallId) continue;
      const distance = Math.hypot(target.point.x - source.point.x, target.point.y - source.point.y);
      if (distance > nearDistance) continue;
      const candidate: Candidate = {
        target: { wallId: target.wallId, endpoint: target.endpoint, point: { ...target.point } },
        distance,
      };
      if (preferCandidate(candidate, nearest)) nearest = candidate;
    }

    for (const wall of sortedWalls) {
      if (wall.id === source.wallId) continue;
      const dx = wall.end.x - wall.start.x;
      const dy = wall.end.y - wall.start.y;
      const t = ((source.point.x - wall.start.x) * dx + (source.point.y - wall.start.y) * dy)
        / (dx * dx + dy * dy);
      // Outside projections are covered by endpoint candidates instead.
      if (t <= 0 || t >= 1) continue;
      const point = { x: wall.start.x + t * dx, y: wall.start.y + t * dy };
      const distance = Math.hypot(point.x - source.point.x, point.y - source.point.y);
      if (distance > nearDistance) continue;
      const candidate: Candidate = { target: { wallId: wall.id, point }, distance };
      if (preferCandidate(candidate, nearest)) nearest = candidate;
    }

    const common: WallConnectionSource = {
      id: `wall-diagnostic:${source.wallId}:${source.endpoint}`,
      wallId: source.wallId,
      endpoint: source.endpoint,
      point: { ...source.point },
    };
    if (!nearest) {
      diagnostics.push({ ...common, kind: "open" });
    } else {
      diagnostics.push({
        ...common,
        kind: nearest.target.endpoint !== undefined
          ? "near-endpoint"
          : nearest.distance <= TOLERANCE ? "junction" : "near-wall",
        target: nearest.target,
        distance: nearest.distance,
      });
    }
  }
  return diagnostics;
}
