import { useMemo } from "react";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { analyzeDoorWallCollisions } from "@/domain/floor-plan/door-collisions";
import { analyzeDoorPairCollisions } from "@/domain/floor-plan/door-pair-collisions";
import { summarizePlanDiagnostics } from "@/domain/floor-plan/plan-diagnostics";
import { analyzeWallConnections } from "@/domain/floor-plan/wall-diagnostics";
import { analyzeWallIntersections } from "@/domain/floor-plan/wall-intersections";
import { analyzeWallOverlaps } from "@/domain/floor-plan/wall-overlaps";

/** All structural checks of a plan, recomputed only when walls or openings change. */
export function usePlanDiagnostics(plan: FloorPlan) {
  const { walls, openings } = plan;
  const connections = useMemo(() => analyzeWallConnections(walls), [walls]);
  const intersections = useMemo(() => analyzeWallIntersections(walls), [walls]);
  const overlaps = useMemo(() => analyzeWallOverlaps(walls), [walls]);
  const doorWalls = useMemo(
    () => analyzeDoorWallCollisions(walls, openings),
    [walls, openings],
  );
  const doorPairs = useMemo(
    () => analyzeDoorPairCollisions(walls, openings),
    [walls, openings],
  );
  const report = useMemo(
    () => summarizePlanDiagnostics({ connections, intersections, overlaps, doorWalls, doorPairs }),
    [connections, intersections, overlaps, doorWalls, doorPairs],
  );
  return { connections, intersections, overlaps, doorWalls, doorPairs, report };
}
