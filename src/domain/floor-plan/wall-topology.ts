import { assertPoint, wallLength, type Point } from "@/domain/geometry";
import type { Wall } from "./types";
import { axisCrossing } from "./wall-intersections";
import { sameWallNode, type WallEndpoint } from "./wall-nodes";

export interface WallEnd {
  readonly wallId: string;
  readonly endpoint: WallEndpoint;
}

export interface TopologyNode {
  /** Named after the node's first wall end, so moving the node keeps its key. */
  readonly key: string;
  /** Stored coordinates of that first wall end, in metres. */
  readonly point: Point;
  /** Coincident wall ends ordered by wall ID, start before end. */
  readonly ends: readonly WallEnd[];
}

export interface TopologyEdge {
  readonly wallId: string;
  /** Keys of the nodes at the wall's start and end. */
  readonly start: string;
  readonly end: string;
  readonly length: number;
}

/** A node lying on the interior of a wall axis that does not end there: an unsplit T. */
export interface TopologyContact {
  readonly node: string;
  readonly wallId: string;
  /** Distance of the contact from the host wall's start, in metres. */
  readonly offset: number;
}

/** Two wall axes crossing inside both walls without a shared node. */
export interface TopologyCrossing {
  readonly wallIds: readonly [string, string];
  readonly point: Point;
}

export interface WallTopology {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly contacts: readonly TopologyContact[];
  readonly crossings: readonly TopologyCrossing[];
  /** Wall IDs touching along their axes through nodes, contacts or crossings. */
  readonly components: readonly (readonly string[])[];
}

const NODE_TOLERANCE = 1e-9;
const ENDPOINTS: readonly WallEndpoint[] = ["start", "end"];

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEnds(a: WallEnd, b: WallEnd): number {
  return compareIds(a.wallId, b.wallId) || (a.endpoint === b.endpoint ? 0 : a.endpoint === "start" ? -1 : 1);
}

function nodeKey(end: WallEnd): string {
  return `node:${JSON.stringify([end.wallId, end.endpoint])}`;
}

/** Groups indices whose union calls connect them; the partition is order-independent. */
function disjointSets(size: number) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  return {
    union: (a: number, b: number) => {
      const rootA = find(a), rootB = find(b);
      if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    },
    groups: () => {
      const groups = new Map<number, number[]>();
      for (let index = 0; index < size; index++) {
        const root = find(index);
        const group = groups.get(root);
        if (group) group.push(index);
        else groups.set(root, [index]);
      }
      return [...groups.values()];
    },
  };
}

function validateWalls(walls: readonly Wall[]): void {
  if (walls.length > 1000) throw new Error("Граф стен поддерживает не больше 1000 стен.");
  const ids = new Set<string>();
  for (const wall of walls) {
    if (typeof wall.id !== "string" || wall.id.length < 1 || wall.id.length > 100) {
      throw new Error("Некорректный идентификатор стены.");
    }
    if (ids.has(wall.id)) throw new Error("Идентификаторы стен должны быть уникальными.");
    ids.add(wall.id);
    assertPoint(wall.start);
    assertPoint(wall.end);
    wallLength(wall.start, wall.end);
  }
}

/**
 * Derived, read-only wall graph over the stored v5 model; nothing here is saved.
 * Wall ends within the 1e-9 m node tolerance form one node (transitively, so the
 * grouping never depends on input order). A node is named after its first wall
 * end, which keeps the key through moves and changes it only when that end
 * leaves the node. Unsplit T-contacts and axis crossings are listed separately
 * because they connect walls physically without a shared node. Results are
 * sorted and independent of input order; wall thickness is not considered.
 */
export function buildWallTopology(walls: readonly Wall[]): WallTopology {
  validateWalls(walls);
  const sorted = [...walls].sort((a, b) => compareIds(a.id, b.id));
  const ends = sorted.flatMap((wall) => ENDPOINTS.map((endpoint) => ({
    end: { wallId: wall.id, endpoint },
    point: wall[endpoint],
  })));

  // Only ends closer than the tolerance along x can coincide.
  const byX = ends.map((_, index) => index).sort((a, b) => ends[a].point.x - ends[b].point.x);
  const coincident = disjointSets(ends.length);
  for (let i = 0; i < byX.length; i++) {
    for (let j = i + 1; j < byX.length; j++) {
      const first = ends[byX[i]], second = ends[byX[j]];
      if (second.point.x - first.point.x > NODE_TOLERANCE) break;
      if (sameWallNode(first.point, second.point)) coincident.union(byX[i], byX[j]);
    }
  }
  const nodes: TopologyNode[] = coincident.groups().map((group) => {
    const members = group.map((index) => ends[index]).sort((a, b) => compareEnds(a.end, b.end));
    return {
      key: nodeKey(members[0].end),
      point: { ...members[0].point },
      ends: members.map((member) => ({ ...member.end })),
    };
  }).sort((a, b) => compareIds(a.key, b.key));

  const nodeOfEnd = new Map<string, TopologyNode>();
  for (const node of nodes) {
    for (const end of node.ends) nodeOfEnd.set(nodeKey(end), node);
  }
  const edges: TopologyEdge[] = sorted.map((wall) => ({
    wallId: wall.id,
    start: nodeOfEnd.get(nodeKey({ wallId: wall.id, endpoint: "start" }))!.key,
    end: nodeOfEnd.get(nodeKey({ wallId: wall.id, endpoint: "end" }))!.key,
    length: wallLength(wall.start, wall.end),
  }));

  // Same projection as the connection diagnostics, so T-contacts agree with them.
  const contacts: TopologyContact[] = [];
  for (const node of nodes) {
    const incident = new Set(node.ends.map((end) => end.wallId));
    for (const wall of sorted) {
      if (incident.has(wall.id)) continue;
      const dx = wall.end.x - wall.start.x;
      const dy = wall.end.y - wall.start.y;
      const t = ((node.point.x - wall.start.x) * dx + (node.point.y - wall.start.y) * dy) / (dx * dx + dy * dy);
      if (t <= 0 || t >= 1) continue;
      const distance = Math.hypot(node.point.x - wall.start.x - t * dx, node.point.y - wall.start.y - t * dy);
      if (distance <= NODE_TOLERANCE) {
        contacts.push({ node: node.key, wallId: wall.id, offset: t * Math.hypot(dx, dy) });
      }
    }
  }

  const crossings: TopologyCrossing[] = [];
  for (let first = 0; first < sorted.length; first++) {
    for (let second = first + 1; second < sorted.length; second++) {
      const point = axisCrossing(sorted[first], sorted[second]);
      if (point) crossings.push({ wallIds: [sorted[first].id, sorted[second].id], point });
    }
  }

  const wallIndex = new Map(sorted.map((wall, index) => [wall.id, index]));
  const touching = disjointSets(sorted.length);
  const nodesByKey = new Map(nodes.map((node) => [node.key, node]));
  for (const node of nodes) {
    for (const end of node.ends) touching.union(wallIndex.get(node.ends[0].wallId)!, wallIndex.get(end.wallId)!);
  }
  for (const contact of contacts) {
    touching.union(wallIndex.get(contact.wallId)!, wallIndex.get(nodesByKey.get(contact.node)!.ends[0].wallId)!);
  }
  for (const crossing of crossings) {
    touching.union(wallIndex.get(crossing.wallIds[0])!, wallIndex.get(crossing.wallIds[1])!);
  }
  const components = touching.groups()
    .map((group) => group.map((index) => sorted[index].id))
    .sort((a, b) => compareIds(a[0], b[0]));

  return { nodes, edges, contacts, crossings, components };
}
