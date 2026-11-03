import { describe, expect, it } from "vitest";
import { createSpatialExamplePlan } from "./examples";
import {
  addRequirement,
  evaluateRequirements,
  findRequirementConflicts,
  fixedWallRequirement,
  removeRequirement,
  violatingRoomIds,
} from "./plan-requirements";
import { deleteObject, updateWall } from "./construction";
import { moveWall } from "./move-wall";
import { findRoomAdjacency } from "./room-adjacency";
import type { FloorPlan, PlanRequirement, RoomKind } from "./types";
import { resolveWallRoomLabels, setWallRoomLabel } from "./wall-room-labels";
import { detectWallRooms } from "./wall-rooms";

/** The 3D example with named rooms: living, kitchen, hall, bathroom, bedroom, study (other). */
function apartment(): FloorPlan {
  let plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
  const kinds: [RoomKind, (x: number, y: number) => boolean][] = [
    ["living", (x, y) => x < 5 && y < 4], ["kitchen", (x, y) => x > 5 && x < 8 && y < 4],
    ["hall", (x, y) => x > 8 && y < 5], ["bathroom", (x, y) => x > 8 && y > 5],
    ["bedroom", (x, y) => x < 4 && y > 4], ["other", (x, y) => x > 4 && x < 8 && y > 4],
  ];
  for (const room of detectWallRooms(plan.walls).rooms) {
    const [kind] = kinds.find(([, test]) => test(room.labelPoint.x, room.labelPoint.y))!;
    plan = setWallRoomLabel(plan, room, { name: kind, kind, color: "#dddddd" }, `label-${kind}`);
  }
  return plan;
}

function evaluate(plan: FloorPlan) {
  const rooms = resolveWallRoomLabels(plan).rooms;
  const results = evaluateRequirements(plan, rooms, findRoomAdjacency(rooms, plan.walls, plan.openings));
  const nameOf = (id: string) => rooms.find((room) => room.id === id)!.name;
  return { results, nameOf };
}

describe("plan requirements", () => {
  const requirements: PlanRequirement[] = [
    { id: "kitchen-12", type: "room-min-area", kind: "kitchen", minArea: 12 },
    { id: "kitchen-10", type: "room-min-area", kind: "kitchen", minArea: 10 },
    { id: "bedroom-quiet", type: "room-not-walkthrough", kind: "bedroom" },
    { id: "bathroom-quiet", type: "room-not-walkthrough", kind: "bathroom" },
    { id: "kitchen-hall", type: "rooms-connected", kind: "kitchen", otherKind: "hall", byDoor: true },
    { id: "living-bathroom", type: "rooms-connected", kind: "living", otherKind: "bathroom", byDoor: true },
    { id: "hall-bathroom-wall", type: "rooms-connected", kind: "hall", otherKind: "bathroom", byDoor: false },
    { id: "hall-bathroom-door", type: "rooms-connected", kind: "hall", otherKind: "bathroom", byDoor: true },
    { id: "bedrooms", type: "rooms-connected", kind: "bedroom", otherKind: "bedroom", byDoor: true },
  ];

  it("checks areas, walk-through rooms and connections against the computed rooms", () => {
    let plan = apartment();
    for (const requirement of requirements) plan = addRequirement(plan, requirement);
    const { results, nameOf } = evaluate(plan);
    const byId = new Map(results.map((result) => [result.id, result]));
    // The kitchen measures 2.88 × 3.84 = 11.0592 m² inside its walls.
    expect(byId.get("kitchen-12")).toMatchObject({ status: "violated", findings: [{ area: expect.closeTo(2.88 * 3.84, 9), violates: true }] });
    expect(byId.get("kitchen-10")!.status).toBe("met");
    // The bedroom opens to the living room and the study: a walk-through room.
    expect(byId.get("bedroom-quiet")).toMatchObject({ status: "violated", findings: [{ doors: 2, violates: true }] });
    expect(byId.get("bathroom-quiet")).toMatchObject({ status: "met", findings: [{ doors: 1, violates: false }] });
    const connected = byId.get("kitchen-hall")!;
    expect(connected.status).toBe("met");
    expect(connected.findings.map((finding) => [nameOf(finding.roomId), nameOf(finding.otherRoomId!)])).toEqual([["kitchen", "hall"]]);
    expect(byId.get("living-bathroom")!.status).toBe("violated");
    expect(byId.get("hall-bathroom-wall")!.status).toBe("met");
    expect(byId.get("hall-bathroom-door")!.status).toBe("violated");
    // One bedroom cannot be connected to another bedroom.
    expect(byId.get("bedrooms")!.status).toBe("no-rooms");
    expect(results.map((result) => result.id)).toEqual(requirements.map((requirement) => requirement.id));
  });

  it("reports missing room kinds, inactive manual mode and follows geometry changes", () => {
    let plan = addRequirement(apartment(), { id: "living-30", type: "room-min-area", kind: "living", minArea: 30 });
    plan = addRequirement(plan, { id: "no-children", type: "room-min-area", kind: "other", minArea: 5 });
    expect(evaluate(plan).results.map((result) => result.status)).toEqual(["violated", "met"]);
    const unlabelled = { ...plan, wallRoomLabels: [] };
    // Without saved parameters every room counts as "other".
    expect(evaluate(unlabelled).results.map((result) => result.status)).toEqual(["no-rooms", "met"]);
    const manual = { ...plan, roomMode: "manual" as const };
    expect(evaluateRequirements(manual, [], null)).toEqual([
      { id: "living-30", status: "inactive", findings: [] },
      { id: "no-children", status: "inactive", findings: [] },
    ]);
  });

  it("adds and removes requirements atomically with format checks", () => {
    const plan = apartment();
    const added = addRequirement(plan, { id: "r1", type: "room-not-walkthrough", kind: "bedroom" });
    expect(added.requirements).toHaveLength(1);
    expect(plan.requirements).toEqual([]);
    expect(removeRequirement(added, "r1").requirements).toEqual([]);
    expect(() => removeRequirement(added, "missing")).toThrow(/не найдено/);
    expect(() => addRequirement(added, { id: "r1", type: "room-not-walkthrough", kind: "hall" })).toThrow(/уникальными/);
    expect(() => addRequirement(plan, { id: "outer-top", type: "room-not-walkthrough", kind: "hall" })).toThrow(/уникальными/);
    expect(() => addRequirement(plan, { id: "r2", type: "room-min-area", kind: "hall", minArea: 0 })).toThrow(/больше 0/);
    expect(() => addRequirement(plan, { id: "r3", type: "room-min-area", kind: "hall", minArea: Number.NaN })).toThrow();
    let full = plan;
    for (let index = 0; index < 50; index++) full = addRequirement(full, { id: `many-${index}`, type: "room-not-walkthrough", kind: "hall" });
    expect(() => addRequirement(full, { id: "one-more", type: "room-not-walkthrough", kind: "hall" })).toThrow(/50/);
  });
});

describe("maximum area, fixed walls and conflicts", () => {
  it("checks a maximum area per room kind", () => {
    let plan = addRequirement(apartment(), { id: "living-15", type: "room-max-area", kind: "living", maxArea: 15 });
    plan = addRequirement(plan, { id: "living-20", type: "room-max-area", kind: "living", maxArea: 20 });
    const { results } = evaluate(plan);
    // The living room is 4.84 × 3.84 = 18.5856 m².
    expect(results[0]).toMatchObject({ status: "violated", findings: [{ area: expect.closeTo(4.84 * 3.84, 9), violates: true }] });
    expect(results[1].status).toBe("met");
  });

  it("keeps a pinned wall met only while its axis and thickness stay, in any room mode", () => {
    const base = apartment();
    const wall = base.walls.find((item) => item.id === "partition-v8")!;
    const plan = addRequirement(base, fixedWallRequirement(wall, "pin"));
    const statusOf = (candidate: FloorPlan) => evaluate(candidate).results[0];
    expect(statusOf(plan)).toMatchObject({ status: "met", findings: [{ violates: false }] });
    // Reversing the direction keeps the same physical wall.
    expect(statusOf(updateWall(plan, { ...wall, start: wall.end, end: wall.start }, false)).status).toBe("met");
    expect(statusOf(moveWall(plan, "partition-v8", { x: 0.3, y: 0 })).findings[0].change).toBe("moved");
    expect(statusOf(updateWall(plan, { ...wall, thickness: 0.2 })).findings[0].change).toBe("thickness");
    expect(statusOf(deleteObject(plan, "partition-v8")).findings[0].change).toBe("deleted");
    // Without wall rooms the wall is still checked; room requirements are inactive.
    const manual = addRequirement({ ...plan, roomMode: "manual" }, { id: "area", type: "room-min-area", kind: "kitchen", minArea: 5 });
    expect(evaluateRequirements(manual, [], null).map((result) => result.status)).toEqual(["met", "inactive"]);
    expect(() => addRequirement(base, { ...fixedWallRequirement(wall, "bad"), thickness: 0 })).toThrow();
  });

  it("finds requirements that contradict each other", () => {
    const min = { id: "min", type: "room-min-area", kind: "kitchen", minArea: 12 } as const;
    const max = { id: "max", type: "room-max-area", kind: "kitchen", maxArea: 10 } as const;
    expect(findRequirementConflicts([max, min])).toEqual([{ ids: ["max", "min"], certain: true, reason: "area-range", kind: "kitchen" }]);
    expect(findRequirementConflicts([min, { ...max, maxArea: 12 }])).toEqual([]);
    expect(findRequirementConflicts([min, { ...max, kind: "hall" }])).toEqual([]);
    const quiet = { id: "quiet", type: "room-not-walkthrough", kind: "bedroom" } as const;
    const toLiving = { id: "living", type: "rooms-connected", kind: "bedroom", otherKind: "living", byDoor: true } as const;
    const toBath = { id: "bath", type: "rooms-connected", kind: "bathroom", otherKind: "bedroom", byDoor: true } as const;
    expect(findRequirementConflicts([quiet, toLiving, toBath])).toEqual([
      { ids: ["quiet", "living", "bath"], certain: false, reason: "walkthrough-doors", kind: "bedroom" },
    ]);
    // A wall contact without a door, or two links to the same kind, need only one door.
    expect(findRequirementConflicts([quiet, toLiving, { ...toBath, byDoor: false }])).toEqual([]);
    expect(findRequirementConflicts([quiet, toLiving, { ...toLiving, id: "living-2" }])).toEqual([]);
    expect(findRequirementConflicts([])).toEqual([]);
  });
});

describe("requirements for one room and highlighting", () => {
  it("checks only the room bound to the saved parameters and reports a missing binding", () => {
    let plan = addRequirement(apartment(), { id: "quiet-bedroom", type: "room-not-walkthrough", kind: "bedroom", labelId: "label-bedroom" });
    plan = addRequirement(plan, { id: "kitchen-11", type: "room-min-area", kind: "kitchen", minArea: 11, labelId: "label-kitchen" });
    plan = addRequirement(plan, { id: "study-15", type: "room-max-area", kind: "other", maxArea: 15, labelId: "label-other" });
    const { results, nameOf } = evaluate(plan);
    expect(results.map((result) => result.status)).toEqual(["violated", "met", "met"]);
    expect(results[0].findings.map((finding) => nameOf(finding.roomId))).toEqual(["bedroom"]);
    // The study is 3.88 × 3.84 = 14.8992 m², under the 15 m² limit.
    expect(results[2].findings[0].area).toBeCloseTo(3.88 * 3.84, 9);
    expect(violatingRoomIds(results).map(nameOf)).toEqual(["bedroom"]);
    // Removing the saved parameters leaves the requirement without a room.
    const unbound = { ...plan, wallRoomLabels: plan.wallRoomLabels.filter((label) => label.id !== "label-bedroom") };
    expect(evaluate(unbound).results[0].status).toBe("no-rooms");
    expect(() => addRequirement(plan, { id: "bad", type: "room-not-walkthrough", kind: "hall", labelId: "" })).toThrow();
  });

  it("collects violating rooms once and treats limits on different rooms as compatible", () => {
    let plan = addRequirement(apartment(), { id: "all-min", type: "room-min-area", kind: "living", minArea: 30 });
    plan = addRequirement(plan, { id: "all-max", type: "room-max-area", kind: "living", maxArea: 10 });
    const { results, nameOf } = evaluate(plan);
    expect(violatingRoomIds(results).map(nameOf)).toEqual(["living"]);
    const kindMin = { id: "kind-min", type: "room-min-area", kind: "kitchen", minArea: 12 } as const;
    const roomMax = { id: "room-max", type: "room-max-area", kind: "kitchen", maxArea: 10, labelId: "label-kitchen" } as const;
    expect(findRequirementConflicts([kindMin, roomMax])).toEqual([]);
    const roomMin = { ...kindMin, id: "room-min", labelId: "label-kitchen" };
    expect(findRequirementConflicts([roomMin, roomMax])).toEqual([
      { ids: ["room-min", "room-max"], certain: true, reason: "area-range", kind: "kitchen" },
    ]);
  });
});