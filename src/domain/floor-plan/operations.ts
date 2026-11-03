import {
  assertRectangle,
  rectangleArea,
  rectanglesOverlap,
} from "@/domain/geometry";
import { roomSchema } from "./schema";
import { detectWallRooms, type WallRoom } from "./wall-rooms";
import type { FloorPlan, Room } from "./types";

export function createEmptyPlan(id: string): FloorPlan {
  return {
    schemaVersion: 6,
    unit: "m",
    id,
    name: "Новый проект",
    roomMode: "manual",
    rooms: [],
    walls: [],
    openings: [],
    wallRoomLabels: [],
    requirements: [],
  };
}

export function createExamplePlan(): FloorPlan {
  return {
    ...createEmptyPlan("example"),
    name: "Квартира на Садовой",
    rooms: [
      {
        id: "living",
        name: "Гостиная",
        kind: "living",
        color: "#e8e5dd",
        x: 0,
        y: 0,
        width: 5,
        height: 4,
      },
      {
        id: "kitchen",
        name: "Кухня",
        kind: "kitchen",
        color: "#ede3d4",
        x: 5,
        y: 0,
        width: 3,
        height: 4,
      },
      {
        id: "bedroom",
        name: "Спальня",
        kind: "bedroom",
        color: "#dfe8df",
        x: 0,
        y: 4,
        width: 4,
        height: 4,
      },
      {
        id: "study",
        name: "Кабинет",
        kind: "other",
        color: "#e5e1ec",
        x: 4,
        y: 4,
        width: 4,
        height: 4,
      },
      {
        id: "hall",
        name: "Прихожая",
        kind: "hall",
        color: "#eeeae3",
        x: 8,
        y: 0,
        width: 2,
        height: 5,
      },
      {
        id: "bathroom",
        name: "Ванная",
        kind: "bathroom",
        color: "#dce8ed",
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
  return plan.rooms.reduce(
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
      : "Проверьте размеры и координаты.";
  }
  const parsed = roomSchema.safeParse(room);
  if (!parsed.success)
    return "Введите название до 60 символов и корректные свойства комнаты.";
  const overlap = plan.rooms.find(
    (other) => other.id !== room.id && rectanglesOverlap(room, other),
  );
  return overlap
    ? `Комната пересекается с «${overlap.name}». Измените размеры или положение.`
    : null;
}

export function addRoom(plan: FloorPlan, room: Room): FloorPlan {
  if (plan.rooms.length >= 100)
    throw new Error("В одном плане может быть не больше 100 комнат.");
  if (
    [...plan.rooms, ...plan.walls, ...plan.openings, ...plan.wallRoomLabels].some(
      (item) => item.id === room.id,
    )
  )
    throw new Error("Идентификатор комнаты уже существует.");
  const error = validateRoomUpdate(plan, room);
  if (error) throw new Error(error);
  return { ...plan, rooms: [...plan.rooms, roomSchema.parse(room)] };
}

export function updateRoom(plan: FloorPlan, room: Room): FloorPlan {
  if (!plan.rooms.some((item) => item.id === room.id))
    throw new Error("Комната не найдена.");
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
    name: `Комната ${plan.rooms.length + 1}`,
    kind: "other",
    color: "#dfe8df",
    x,
    y: 0,
    width: 4,
    height: 3,
  };
}
