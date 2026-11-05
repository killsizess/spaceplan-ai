import { tr } from "@/lib/i18n";
import {
  assertRectangle,
  rectangleArea,
  rectanglesOverlap,
} from "@/domain/geometry";
import { roomSchema } from "./schema";
import { detectWallRooms, type WallRoom } from "./wall-rooms";
import { countsInTotal, type FloorPlan, type Room } from "./types";

export function createEmptyPlan(id: string): FloorPlan {
  return {
    schemaVersion: 11,
    unit: "m",
    id,
    name: tr`Новый проект`,
    roomMode: "manual",
    rooms: [],
    walls: [],
    openings: [],
    wallRoomLabels: [],
    requirements: [],
  };
}

const EXAMPLE_PLAN_NAME = tr`Квартира на Садовой`;

/** The built-in plan a new visitor starts on, before it has become their own. */
export function isExamplePlan(plan: Pick<FloorPlan, "name" | "walls">): boolean {
  return plan.name === EXAMPLE_PLAN_NAME && plan.walls.length === 0;
}

export function createExamplePlan(): FloorPlan {
  return {
    ...createEmptyPlan("example"),
    name: EXAMPLE_PLAN_NAME,
    rooms: [
      {
        id: "living",
        name: tr`Гостиная`,
        kind: "living",
        color: "#f1e3c6",
        x: 0,
        y: 0,
        width: 5,
        height: 4,
      },
      {
        id: "kitchen",
        name: tr`Кухня`,
        kind: "kitchen",
        color: "#f8dcc6",
        x: 5,
        y: 0,
        width: 3,
        height: 4,
      },
      {
        id: "bedroom",
        name: tr`Спальня`,
        kind: "bedroom",
        color: "#d3ebd8",
        x: 0,
        y: 4,
        width: 4,
        height: 4,
      },
      {
        id: "study",
        name: tr`Кабинет`,
        kind: "other",
        color: "#e0d9f2",
        x: 4,
        y: 4,
        width: 4,
        height: 4,
      },
      {
        id: "hall",
        name: tr`Прихожая`,
        kind: "hall",
        color: "#ece7da",
        x: 8,
        y: 0,
        width: 2,
        height: 5,
      },
      {
        id: "bathroom",
        name: tr`Ванная`,
        kind: "bathroom",
        color: "#cfe7f3",
        x: 8,
        y: 5,
        width: 2,
        height: 3,
      },
    ],
  };
}

export function getTotalArea(
  plan: FloorPlan,
  wallRooms?: readonly Pick<WallRoom, "area">[],
): number {
  if (plan.roomMode === "walls") {
    return (wallRooms ?? detectWallRooms(plan.walls).rooms).reduce(
      (sum, room) => sum + room.area,
      0,
    );
  }
  return plan.rooms.filter((room) => countsInTotal(room.kind)).reduce(
    (sum, room) => sum + rectangleArea(room.width, room.height),
    0,
  );
}

export function validateRoomUpdate(plan: FloorPlan, room: Room): string | null {
  try {
    assertRectangle(room);
  } catch (error) {
    return error instanceof Error
      ? error.message
      : tr`Проверьте размеры и координаты.`;
  }
  const parsed = roomSchema.safeParse(room);
  if (!parsed.success)
    return tr`Введите название до 60 символов и корректные свойства комнаты.`;
  const overlap = plan.rooms.find(
    (other) => other.id !== room.id && rectanglesOverlap(room, other),
  );
  return overlap
    ? tr`Комната пересекается с «${overlap.name}». Измените размеры или положение.`
    : null;
}

export function addRoom(plan: FloorPlan, room: Room): FloorPlan {
  if (plan.rooms.length >= 100)
    throw new Error(tr`В одном плане может быть не больше 100 комнат.`);
  if (
    [...plan.rooms, ...plan.walls, ...plan.openings, ...plan.wallRoomLabels].some(
      (item) => item.id === room.id,
    )
  )
    throw new Error(tr`Идентификатор комнаты уже существует.`);
  const error = validateRoomUpdate(plan, room);
  if (error) throw new Error(error);
  return { ...plan, rooms: [...plan.rooms, roomSchema.parse(room)] };
}

export function updateRoom(plan: FloorPlan, room: Room): FloorPlan {
  if (!plan.rooms.some((item) => item.id === room.id))
    throw new Error(tr`Комната не найдена.`);
  const error = validateRoomUpdate(plan, room);
  if (error) throw new Error(error);
  const validated = roomSchema.parse(room);
  return {
    ...plan,
    rooms: plan.rooms.map((item) => (item.id === room.id ? validated : item)),
  };
}

export function deleteRoom(plan: FloorPlan, id: string): FloorPlan {
  return { ...plan, rooms: plan.rooms.filter((room) => room.id !== id) };
}

export function createDefaultRoom(plan: FloorPlan, id: string): Room {
  const x = plan.rooms.length
    ? Math.max(...plan.rooms.map((room) => room.x + room.width)) + 0.5
    : 0;
  return {
    id,
    name: tr`Комната ${plan.rooms.length + 1}`,
    kind: "other",
    color: "#d3ebd8",
    x,
    y: 0,
    width: 4,
    height: 3,
  };
}
