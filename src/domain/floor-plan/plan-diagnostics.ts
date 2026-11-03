import type { DoorWallCollision } from "./door-collisions";
import type { DoorPairCollision } from "./door-pair-collisions";
import type { WallConnectionDiagnostic } from "./wall-diagnostics";
import type { WallIntersectionDiagnostic } from "./wall-intersections";
import type { WallOverlapDiagnostic } from "./wall-overlaps";

export type PlanDiagnosticKind = "connections" | "intersections" | "overlaps" | "door-wall" | "door-pair";

export type PlanDiagnosticItem =
  | { readonly id: string; readonly kind: "connections"; readonly diagnostic: WallConnectionDiagnostic }
  | { readonly id: string; readonly kind: "intersections"; readonly diagnostic: WallIntersectionDiagnostic }
  | { readonly id: string; readonly kind: "overlaps"; readonly diagnostic: WallOverlapDiagnostic }
  | { readonly id: string; readonly kind: "door-wall"; readonly diagnostic: DoorWallCollision }
  | { readonly id: string; readonly kind: "door-pair"; readonly diagnostic: DoorPairCollision };

export interface PlanDiagnosticSources {
  connections: readonly WallConnectionDiagnostic[];
  intersections: { intersections: readonly WallIntersectionDiagnostic[]; truncated: boolean };
  overlaps: { overlaps: readonly WallOverlapDiagnostic[]; truncated: boolean };
  doorWalls: { collisions: readonly DoorWallCollision[]; truncated: boolean };
  doorPairs: { collisions: readonly DoorPairCollision[]; truncated: boolean };
}

export interface PlanDiagnosticReport {
  items: PlanDiagnosticItem[];
  counts: Record<PlanDiagnosticKind, number>;
  truncated: Record<PlanDiagnosticKind, boolean>;
  /** Number of unique returned rows, a lower bound when incomplete is true. */
  total: number;
  incomplete: boolean;
}

const compareIds = (first: string, second: string) => first < second ? -1 : first > second ? 1 : 0;

function uniqueById<T extends { readonly id: string }>(diagnostics: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...diagnostics].sort((first, second) => compareIds(first.id, second.id)).filter((diagnostic) => {
    if (seen.has(diagnostic.id)) return false;
    seen.add(diagnostic.id);
    return true;
  });
}

function connectionKey(diagnostic: WallConnectionDiagnostic): string {
  if (diagnostic.kind === "near-endpoint" && diagnostic.target.endpoint !== undefined) {
    const endpoints = [
      [diagnostic.wallId, diagnostic.endpoint],
      [diagnostic.target.wallId, diagnostic.target.endpoint],
    ].sort((first, second) => compareIds(first[0], second[0]) || compareIds(first[1], second[1]));
    return `endpoints:${JSON.stringify(endpoints)}`;
  }
  // Separate source ends remain separate actions, including multiple T contacts
  // at the same coordinates. A shared point alone never identifies one issue.
  return `source:${diagnostic.id}`;
}

/**
 * Combines already computed diagnostics without re-evaluating or altering any
 * geometry. Reciprocal endpoint-nearness rows describe one possible connection,
 * so retain the lexicographically first source as its navigation target. Other
 * categories retain one row per diagnostic ID. Counts describe only these rows;
 * source cap flags remain explicit and never imply a known total or safety grade.
 */
export function summarizePlanDiagnostics(sources: PlanDiagnosticSources): PlanDiagnosticReport {
  const connections = new Map<string, WallConnectionDiagnostic>();
  for (const diagnostic of uniqueById(sources.connections)) {
    const key = connectionKey(diagnostic);
    if (!connections.has(key)) connections.set(key, diagnostic);
  }
  const groups: Record<PlanDiagnosticKind, PlanDiagnosticItem[]> = {
    connections: [...connections].map(([key, diagnostic]) => ({
      id: `plan-diagnostic:connections:${key}`, kind: "connections", diagnostic,
    })),
    intersections: uniqueById(sources.intersections.intersections).map((diagnostic) => ({
      id: `plan-diagnostic:intersections:${diagnostic.id}`, kind: "intersections", diagnostic,
    })),
    overlaps: uniqueById(sources.overlaps.overlaps).map((diagnostic) => ({
      id: `plan-diagnostic:overlaps:${diagnostic.id}`, kind: "overlaps", diagnostic,
    })),
    "door-wall": uniqueById(sources.doorWalls.collisions).map((diagnostic) => ({
      id: `plan-diagnostic:door-wall:${diagnostic.id}`, kind: "door-wall", diagnostic,
    })),
    "door-pair": uniqueById(sources.doorPairs.collisions).map((diagnostic) => ({
      id: `plan-diagnostic:door-pair:${diagnostic.id}`, kind: "door-pair", diagnostic,
    })),
  };
  const kinds: readonly PlanDiagnosticKind[] = ["connections", "intersections", "overlaps", "door-wall", "door-pair"];
  const items = kinds.flatMap((kind) => groups[kind].sort((first, second) => compareIds(first.id, second.id)));
  const truncated: Record<PlanDiagnosticKind, boolean> = {
    connections: false,
    intersections: sources.intersections.truncated,
    overlaps: sources.overlaps.truncated,
    "door-wall": sources.doorWalls.truncated,
    "door-pair": sources.doorPairs.truncated,
  };
  return {
    items,
    counts: {
      connections: groups.connections.length,
      intersections: groups.intersections.length,
      overlaps: groups.overlaps.length,
      "door-wall": groups["door-wall"].length,
      "door-pair": groups["door-pair"].length,
    },
    truncated,
    total: items.length,
    incomplete: kinds.some((kind) => truncated[kind]),
  };
}
