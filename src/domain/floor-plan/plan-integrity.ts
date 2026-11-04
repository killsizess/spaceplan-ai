import {
  MAX_COORDINATE,
  MAX_PLAN_DIMENSION,
  MAX_ROOM_SIZE,
  validateRoomDimensions,
  type Point,
} from "@/domain/geometry";
import type { FloorPlan, Opening, PlanRequirement, Room, Wall, WallRoomLabel } from "./types";
import { analyzeWallOverlaps } from "./wall-overlaps";
import { detectWallRooms } from "./wall-rooms";

export type PlanIntegritySeverity = "error" | "warning";

export type PlanIntegrityCode =
  | "id.invalid"
  | "id.duplicate"
  | "number.invalid"
  | "wall.degenerate"
  | "wall.too-long"
  | "wall.overlap"
  | "opening.missing-wall"
  | "opening.outside-wall"
  | "opening.overlap"
  | "room.overlap"
  | "label.detached"
  | "requirement.invalid"
  | "wall-rooms.unresolved";

export interface PlanIntegrityIssue {
  readonly code: PlanIntegrityCode;
  /** Errors break model invariants; warnings describe valid but suspicious data. */
  readonly severity: PlanIntegritySeverity;
  /** User-facing explanation. A rule shared with the Zod schema keeps its text. */
  readonly message: string;
  /** Model objects involved, in model order. */
  readonly objectIds: readonly string[];
  /** Location in the plan JSON, e.g. ["openings", 2, "offset"]. */
  readonly path: readonly (string | number)[];
  /** Plan coordinates in metres when a single point locates the issue. */
  readonly point?: Point;
}

export interface PlanIntegrityReport {
  /** True when no error was found; warnings never invalidate a plan. */
  readonly valid: boolean;
  readonly issues: readonly PlanIntegrityIssue[];
  readonly errors: number;
  readonly warnings: number;
  /** Checks that were skipped or limited, so a clean result is never overstated. */
  readonly notes: readonly string[];
}

const TOLERANCE = 1e-9;
const COORDINATES = "Координаты должны быть числами в пределах ±1000 м.";

type Path = readonly (string | number)[];
type Issue = PlanIntegrityIssue;

function issue(
  code: PlanIntegrityCode,
  message: string,
  objectIds: readonly string[],
  path: Path,
  point?: Point,
): Issue {
  return {
    code,
    severity: code === "wall.overlap" || code === "label.detached" ? "warning" : "error",
    message,
    objectIds,
    path,
    ...(point ? { point } : {}),
  };
}

const finite = (...values: unknown[]) =>
  values.every((value) => typeof value === "number" && Number.isFinite(value));
const validId = (id: unknown) => typeof id === "string" && id.length >= 1 && id.length <= 100;
const validPoint = (point: Point | undefined) =>
  point !== undefined && finite(point.x, point.y) &&
  Math.abs(point.x) <= MAX_COORDINATE && Math.abs(point.y) <= MAX_COORDINATE;
const axisLength = (wall: Wall) => Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

function idIssues(id: unknown, path: Path): Issue[] {
  return validId(id)
    ? []
    : [issue("id.invalid", "Идентификатор объекта должен содержать от 1 до 100 символов.", [], [...path, "id"])];
}

function wallIssues(wall: Wall, index: number): Issue[] {
  const path = ["walls", index];
  const ids = validId(wall.id) ? [wall.id] : [];
  const found = idIssues(wall.id, path);
  for (const end of ["start", "end"] as const) {
    if (!validPoint(wall[end])) found.push(issue("number.invalid", COORDINATES, ids, [...path, end]));
  }
  if (!finite(wall.thickness, wall.height) || !(wall.thickness > 0 && wall.height > 0) ||
    wall.thickness > MAX_ROOM_SIZE || wall.height > MAX_ROOM_SIZE) {
    found.push(issue(
      "number.invalid",
      "Толщина и высота стены должны быть положительными числами не больше 100 м.",
      ids,
      path,
    ));
  }
  if (validPoint(wall.start) && validPoint(wall.end)) {
    const length = axisLength(wall);
    if (length <= TOLERANCE) {
      found.push(issue("wall.degenerate", "Стена должна иметь ненулевую длину.", ids, path, wall.start));
    } else if (length > MAX_PLAN_DIMENSION) {
      found.push(issue("wall.too-long", "Длина стены не должна превышать 2000 м.", ids, path));
    }
  }
  return found;
}

function openingIssues(opening: Opening, index: number): Issue[] {
  const path = ["openings", index];
  const found = idIssues(opening.id, path);
  if (!validId(opening.wallId)) {
    found.push(issue("id.invalid", "Идентификатор стены проёма должен содержать от 1 до 100 символов.", [], [...path, "wallId"]));
  }
  // Negative offsets and sills are reported against the wall as leaving it.
  if (
    !finite(opening.offset, opening.width, opening.height, opening.sillHeight) ||
    opening.offset > MAX_PLAN_DIMENSION ||
    !(opening.width > 0) || opening.width > MAX_PLAN_DIMENSION ||
    !(opening.height > 0) || opening.height > MAX_ROOM_SIZE ||
    opening.sillHeight > MAX_ROOM_SIZE
  ) {
    found.push(issue("number.invalid", "Некорректные размеры проёма.", validId(opening.id) ? [opening.id] : [], path));
  }
  return found;
}

function roomIssues(room: Room, index: number): Issue[] {
  const path = ["rooms", index];
  const ids = validId(room.id) ? [room.id] : [];
  const found = idIssues(room.id, path);
  const sizeError = validateRoomDimensions(room.width, room.height);
  if (sizeError) found.push(issue("number.invalid", sizeError, ids, path));
  if (!validPoint(room) || (!sizeError && !validPoint({ x: room.x + room.width, y: room.y + room.height }))) {
    found.push(issue("number.invalid", COORDINATES, ids, path));
  }
  return found;
}

function labelIssues(label: WallRoomLabel, index: number): Issue[] {
  const path = ["wallRoomLabels", index];
  const ids = validId(label.id) ? [label.id] : [];
  const found = idIssues(label.id, path);
  if (!validPoint(label.anchor)) {
    found.push(issue("number.invalid", COORDINATES, ids, [...path, "anchor"]));
  }
  const boundary = label.boundaryWallIds;
  if (!Array.isArray(boundary) || boundary.length < 1 || boundary.length > 1000 || !boundary.every(validId)) {
    found.push(issue(
      "id.invalid", "Подпись помещения должна ссылаться на стены корректными идентификаторами.", ids,
      [...path, "boundaryWallIds"],
    ));
  } else if (new Set(boundary).size !== boundary.length) {
    found.push(issue("id.duplicate", "Границы помещения не должны повторяться.", ids, [...path, "boundaryWallIds"]));
  }
  return found;
}

const ROOM_KINDS = new Set(["living", "bedroom", "kitchen", "bathroom", "hall", "other"]);
const REQUIREMENT_FIELDS: Record<string, readonly string[]> = {
  "room-min-area": ["id", "type", "kind", "minArea", "labelId"],
  "room-max-area": ["id", "type", "kind", "maxArea", "labelId"],
  "room-not-walkthrough": ["id", "type", "kind", "labelId"],
  "rooms-connected": ["id", "type", "kind", "otherKind", "byDoor"],
  "wall-fixed": ["id", "type", "wallId", "start", "end", "thickness"],
};

/** Field rules of a user requirement (v6); the schema states the same rules. */
function requirementIssues(requirement: PlanRequirement, index: number): Issue[] {
  const path = ["requirements", index];
  const ids = validId(requirement.id) ? [requirement.id] : [];
  const found = idIssues(requirement.id, path);
  const fields = REQUIREMENT_FIELDS[requirement.type as string];
  const invalid = (message: string, field?: string) =>
    found.push(issue("requirement.invalid", message, ids, field ? [...path, field] : path));
  if (!fields) {
    invalid("Неизвестный тип требования.", "type");
    return found;
  }
  if (Object.keys(requirement).some((key) => !fields.includes(key))) invalid("У требования есть лишние поля.");
  if ("kind" in requirement && !ROOM_KINDS.has(requirement.kind)) invalid("Неизвестное назначение помещения.", "kind");
  if ("otherKind" in requirement && !ROOM_KINDS.has(requirement.otherKind)) invalid("Неизвестное назначение помещения.", "otherKind");
  if ("byDoor" in requirement && typeof requirement.byDoor !== "boolean") invalid("Признак двери должен быть логическим.", "byDoor");
  if ("labelId" in requirement && requirement.labelId !== undefined && !validId(requirement.labelId)) {
    invalid("Требование должно ссылаться на параметры помещения корректным идентификатором.", "labelId");
  }
  for (const field of ["minArea", "maxArea"] as const) {
    if (field in requirement) {
      const value = (requirement as Record<string, unknown>)[field];
      if (!finite(value) || (value as number) <= 0 || (value as number) > 10000) {
        found.push(issue("number.invalid", "Площадь в требовании должна быть больше 0 и не больше 10 000 м².", ids, [...path, field]));
      }
    }
  }
  if (requirement.type === "wall-fixed") {
    if (!validId(requirement.wallId)) invalid("Требование должно ссылаться на стену корректным идентификатором.", "wallId");
    for (const end of ["start", "end"] as const) {
      if (!validPoint(requirement[end])) found.push(issue("number.invalid", COORDINATES, ids, [...path, end]));
    }
    if (!finite(requirement.thickness) || requirement.thickness <= 0 || requirement.thickness > MAX_ROOM_SIZE) {
      found.push(issue("number.invalid", "Толщина в требовании должна быть больше 0 и не больше 100 м.", ids, [...path, "thickness"]));
    }
  }
  return found;
}

interface ObjectState {
  issues: Issue[];
  validWalls: ReadonlySet<Wall>;
  validRooms: ReadonlySet<Room>;
}

function objectState(plan: FloorPlan): ObjectState {
  const issues: Issue[] = [];
  const validWalls = new Set<Wall>();
  const validRooms = new Set<Room>();
  plan.rooms.forEach((room, index) => {
    const found = roomIssues(room, index);
    issues.push(...found);
    if (!found.length) validRooms.add(room);
  });
  plan.walls.forEach((wall, index) => {
    const found = wallIssues(wall, index);
    issues.push(...found);
    if (!found.length) validWalls.add(wall);
  });
  plan.openings.forEach((opening, index) => issues.push(...openingIssues(opening, index)));
  plan.wallRoomLabels.forEach((label, index) => issues.push(...labelIssues(label, index)));
  if (Array.isArray(plan.requirements)) {
    plan.requirements.forEach((requirement, index) => issues.push(...requirementIssues(requirement, index)));
  } else {
    issues.push(issue("requirement.invalid", "Список требований должен быть массивом.", [], ["requirements"]));
  }
  return { issues, validWalls, validRooms };
}

/** Shared edges are permitted; interiors must not overlap. */
function roomsOverlap(a: Room, b: Room): boolean {
  return (
    a.x < b.x + b.width - TOLERANCE && a.x + a.width > b.x + TOLERANCE &&
    a.y < b.y + b.height - TOLERANCE && a.y + a.height > b.y + TOLERANCE
  );
}

function relationIssues(plan: FloorPlan, state: ObjectState, notes: string[]): Issue[] {
  const found: Issue[] = [];
  if (plan.roomMode === "walls") {
    if (plan.walls.every((wall) => state.validWalls.has(wall))) {
      try {
        detectWallRooms(plan.walls);
      } catch (error) {
        found.push(issue(
          "wall-rooms.unresolved",
          error instanceof Error ? error.message : "Не удалось определить помещения по стенам.",
          [],
          ["walls"],
        ));
      }
    } else {
      notes.push("Помещения по стенам не проверены: сначала исправьте некорректные стены.");
    }
  }

  const groups: readonly [string, readonly { id: string }[]][] = [
    ["rooms", plan.rooms], ["walls", plan.walls], ["openings", plan.openings], ["wallRoomLabels", plan.wallRoomLabels],
    ["requirements", Array.isArray(plan.requirements) ? plan.requirements : []],
  ];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const [key, objects] of groups) {
    objects.forEach((object, index) => {
      if (seen.has(object.id) && !reported.has(object.id)) {
        reported.add(object.id);
        found.push(issue("id.duplicate", "Идентификаторы объектов должны быть уникальными.", [object.id], [key, index, "id"]));
      }
      seen.add(object.id);
    });
  }

  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      const first = plan.rooms[i], second = plan.rooms[j];
      if (state.validRooms.has(first) && state.validRooms.has(second) && roomsOverlap(first, second)) {
        found.push(issue("room.overlap", "Комнаты не должны пересекаться.", [first.id, second.id], ["rooms", j]));
      }
    }
  }

  const walls = new Map<string, Wall>();
  for (const wall of plan.walls) if (!walls.has(wall.id)) walls.set(wall.id, wall);
  plan.openings.forEach((opening, index) => {
    const wall = walls.get(opening.wallId);
    if (!wall) {
      found.push(issue(
        "opening.missing-wall", "У проёма должна быть существующая стена.", [opening.id], ["openings", index, "wallId"],
      ));
      return;
    }
    if (!state.validWalls.has(wall) || !finite(opening.offset, opening.width, opening.height, opening.sillHeight)) return;
    if (
      opening.offset < -TOLERANCE || opening.offset + opening.width > axisLength(wall) + TOLERANCE ||
      opening.sillHeight < -TOLERANCE || opening.sillHeight + opening.height > wall.height + TOLERANCE
    ) {
      found.push(issue("opening.outside-wall", "Проём выходит за границы стены.", [opening.id, wall.id], ["openings", index]));
    }
  });

  for (let i = 0; i < plan.openings.length; i++) {
    for (let j = i + 1; j < plan.openings.length; j++) {
      const first = plan.openings[i], second = plan.openings[j];
      if (
        first.wallId === second.wallId &&
        first.offset < second.offset + second.width - TOLERANCE &&
        first.offset + first.width > second.offset + TOLERANCE
      ) {
        found.push(issue(
          "opening.overlap", "Проёмы на одной стене не должны перекрываться.", [first.id, second.id], ["openings", j],
        ));
      }
    }
  }
  return found;
}

function warningIssues(plan: FloorPlan, state: ObjectState, notes: string[]): Issue[] {
  const found: Issue[] = [];
  const validWalls = plan.walls.filter((wall) => state.validWalls.has(wall));
  const ids = new Set(validWalls.map((wall) => wall.id));
  if (ids.size === validWalls.length) {
    try {
      const { overlaps, truncated } = analyzeWallOverlaps(validWalls);
      const order = new Map<string, number>();
      plan.walls.forEach((wall, index) => {
        if (state.validWalls.has(wall)) order.set(wall.id, index);
      });
      for (const overlap of overlaps) {
        const [first, second] = [...overlap.wallIds].sort((a, b) => order.get(a)! - order.get(b)!);
        found.push(issue(
          "wall.overlap",
          "Стены лежат на одной оси и частично совпадают. Одна из них может закрывать проёмы другой.",
          [first, second],
          ["walls", order.get(second)!],
          overlap.point,
        ));
      }
      if (truncated) notes.push(`Показаны первые ${overlaps.length} наложений стен.`);
    } catch {
      notes.push("Наложения стен не проверены.");
    }
  } else {
    notes.push("Наложения стен не проверены: идентификаторы стен повторяются.");
  }
  plan.wallRoomLabels.forEach((label, index) => {
    if (Array.isArray(label.boundaryWallIds) && !label.boundaryWallIds.some((id) => ids.has(id))) {
      found.push(issue(
        "label.detached",
        "Подпись помещения не связана ни с одной существующей стеной. Назначьте её вручную или удалите.",
        [label.id],
        ["wallRoomLabels", index],
      ));
    }
  });
  return found;
}

/**
 * Relations between plan objects that the editor relies on: unique IDs,
 * opening hosts and bounds, non-overlapping openings and manual rooms, and
 * computable wall rooms. The Zod schema applies exactly these rules after its
 * field checks, so the editor, imports and saved projects share one definition.
 * Objects whose own fields are invalid are skipped instead of guessed at.
 */
export function checkPlanRelations(
  plan: FloorPlan,
  options: { readonly allowUnresolvedRooms?: boolean } = {},
): PlanIntegrityIssue[] {
  const issues = relationIssues(plan, objectState(plan), []);
  // Opening a saved project must not fail only because its rooms cannot be computed:
  // the editor reports that case to the user instead (see `floorPlanLoadSchema`).
  return options.allowUnresolvedRooms
    ? issues.filter((item) => item.code !== "wall-rooms.unresolved")
    : issues;
}

/**
 * Complete structural check of a typed plan from any source: the editor, an
 * import, a future recognition or generation step. It never throws and never
 * changes the plan. Errors mirror the format rules: numbers, IDs, degenerate
 * walls, references and overlaps. Warnings flag valid but suspicious data:
 * collinear wall overlaps and room labels without any existing boundary wall.
 * Names, colours, raster underlays and building requirements are not assessed.
 */
export function checkPlanIntegrity(plan: FloorPlan): PlanIntegrityReport {
  const notes: string[] = [];
  const state = objectState(plan);
  const issues = [...state.issues, ...relationIssues(plan, state, notes), ...warningIssues(plan, state, notes)];
  const errors = issues.filter((item) => item.severity === "error").length;
  return { valid: errors === 0, issues, errors, warnings: issues.length - errors, notes };
}
