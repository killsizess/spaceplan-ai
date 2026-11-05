import type { FloorPlan, RoomKind, WallKind } from "@/domain/floor-plan/types";
import { wallKindOf } from "@/domain/floor-plan/wall-kind";
import { PROCEDURE_ORDER } from "./moscow";
import { isPerimeterWall, roomsOfPlan, type RuleRoom } from "./rule-rooms";
import type { Procedure, RuleSource } from "./types";

/**
 * X-Ray answers "what could be changed in this apartment, and what would it take",
 * for each wall and each wet room of the plan as it stands. Nothing is said to be
 * allowed: the most it says is which procedure the read documents name for the work.
 */
export interface WorkAnswer {
  procedure: Procedure;
  reason: string;
  sources: readonly RuleSource[];
}

export interface WallPotential {
  wallId: string;
  /** 1-based, what the editor calls "Стена N". */
  number: number;
  kind: WallKind;
  rooms: string[];
  removal: WorkAnswer;
  opening: WorkAnswer;
}

export interface RoomPotential {
  roomId: string;
  name: string;
  kind: RoomKind;
  /** What the answer is about: «Перенос», «Новый или больший». */
  action: string;
  move: WorkAnswer;
}

export interface PlanXray {
  walls: WallPotential[];
  rooms: RoomPotential[];
  /** Walls by what taking them down would take. */
  counts: Readonly<Record<Procedure, number>>;
  unresolved?: string;
}

const clause = (point: string): RuleSource => ({ document: "moscow-508", point: `прил. 1, п. ${point}` });
const LIVING: readonly RoomKind[] = ["living", "bedroom"];

function removalOf(plan: FloorPlan, kind: WallKind, perimeter: boolean, beside: readonly RuleRoom[]): WorkAnswer {
  const facts = plan.buildingFacts ?? {};
  if (facts.emergency) return { procedure: "forbidden", reason: "Дом признан аварийным.", sources: [clause("9.15")] };
  if (beside.some((room) => room.kind === "shaft")) {
    return { procedure: "forbidden", reason: "Стена вентшахты или короба: их нельзя убирать и менять их сечение.", sources: [clause("9.5")] };
  }
  if (beside.length >= 2 && beside.some((room) => room.kind === "balcony")) {
    return { procedure: "forbidden", reason: "Снос объединит балкон или лоджию с помещением.", sources: [clause("9.18")] };
  }
  if (kind === "unknown") return { procedure: "unknown", reason: "Тип стены не указан: это может быть несущая стена.", sources: [] };
  if (kind === "bearing") {
    return {
      procedure: "specialist",
      reason: "Несущая стена: нельзя нарушать прочность и устойчивость конструкций, оценит это только специалист.",
      sources: [clause("9.3"), clause("9.6")],
    };
  }
  if (perimeter) {
    return {
      procedure: "specialist",
      reason: "Стена на границе квартиры: снос меняет границы помещения, нужен проект; соседство и общее имущество оценит специалист.",
      sources: [clause("2.2.5")],
    };
  }
  const has = (kinds: readonly RoomKind[]) => beside.some((room) => kinds.includes(room.kind));
  if (has(["kitchen"]) && has(LIVING)) {
    if (facts.gasified) {
      return { procedure: "forbidden", reason: "Снос объединит газифицированную кухню с жилой комнатой.", sources: [clause("9.16")] };
    }
    if (facts.gasified === undefined) {
      return { procedure: "unknown", reason: "Снос объединит кухню с жилой комнатой; при газе это запрещено, а о газе ответа нет.", sources: [clause("9.16")] };
    }
  }
  if (has(["bathroom"])) {
    return { procedure: "project", reason: "Снос меняет границы санузла.", sources: [clause("2.2.1")] };
  }
  if (facts.heritage) return { procedure: "project", reason: "Объект культурного наследия.", sources: [clause("2.2.13"), clause("12")] };
  if (facts.woodenFloors) return { procedure: "project", reason: "Перегородка в доме с деревянными перекрытиями.", sources: [clause("2.2.10")] };
  const caveats = [
    facts.woodenFloors === undefined ? "если перекрытия деревянные, нужен проект (п. 2.2.10)" : "",
    has(["kitchen"]) ? "если это меняет место кухни, нужен проект (п. 2.2.11)" : "",
  ].filter(Boolean);
  return {
    procedure: "simplified",
    reason: caveats.length ? `Перегородка; ${caveats.join("; ")}.` : "Перегородка.",
    sources: [clause("19.6.1"), clause("19.1")],
  };
}

function openingOf(plan: FloorPlan, kind: WallKind, perimeter: boolean, beside: readonly RuleRoom[]): WorkAnswer {
  const facts = plan.buildingFacts ?? {};
  if (facts.emergency) return { procedure: "forbidden", reason: "Дом признан аварийным.", sources: [clause("9.15")] };
  if (beside.some((room) => room.kind === "shaft")) {
    return { procedure: "forbidden", reason: "Стена вентшахты или короба.", sources: [clause("9.5")] };
  }
  if (beside.length >= 2 && beside.some((room) => room.kind === "balcony")) {
    return { procedure: "project", reason: "Проём к балкону или лоджии, если работа не затрагивает облик дома.", sources: [clause("2.2.14"), clause("3.9")] };
  }
  if (kind === "unknown") return { procedure: "unknown", reason: "Тип стены не указан.", sources: [] };
  if (perimeter) {
    return {
      procedure: "project",
      reason: "Проём на границе квартиры: в наружной стене это работа по проекту, она может затрагивать общее имущество.",
      sources: [clause("3.1")],
    };
  }
  if (kind === "bearing") {
    return {
      procedure: "project",
      reason: "Проём в несущей стене; в пилонах, диафрагмах и колоннах он не допускается вовсе (п. 9.10).",
      sources: [clause("2.2.4"), clause("9.10")],
    };
  }
  if (facts.heritage) return { procedure: "project", reason: "Объект культурного наследия.", sources: [clause("2.2.13"), clause("12")] };
  return { procedure: "simplified", reason: "Проём в перегородке.", sources: [clause("19.6.2"), clause("19.1")] };
}

function moveOf(plan: FloorPlan, room: RuleRoom): WorkAnswer | null {
  if (room.kind === "shaft") {
    return { procedure: "forbidden", reason: "Вентшахту и короб нельзя убирать, нельзя менять их сечение.", sources: [clause("9.5")] };
  }
  if (room.kind === "balcony") {
    const level = plan.buildingFacts?.floorLevel;
    if (level === "upper") return { procedure: "forbidden", reason: "Второй и выше этаж.", sources: [clause("9.13")] };
    if (level === "first") return { procedure: "project", reason: "Первый этаж: без фундаментов, помещений под ним и отопления.", sources: [clause("3.5"), clause("9.26")] };
    return { procedure: "unknown", reason: "Зависит от этажа: на втором и выше запрещено, на первом по проекту.", sources: [clause("9.13"), clause("3.5")] };
  }
  const stacking = "Над жилыми комнатами размещать нельзя.";
  const stackSources: RuleSource[] = [{ document: "rf-pp-47", point: "п. 24" }];
  if (room.kind === "bathroom") {
    return {
      procedure: "project",
      reason: `Устройство, перенос и изменение границ санузла. ${stacking}`,
      sources: [clause("2.2.1"), ...stackSources, { document: "sp-54", point: "п. 7.20" }],
    };
  }
  if (room.kind === "kitchen") {
    return {
      procedure: "project",
      reason: `Устройство и перенос кухни. ${stacking}`,
      sources: [clause("2.2.11"), ...stackSources, { document: "sp-54", point: "п. 7.21" }],
    };
  }
  return null;
}

export function buildXray(plan: FloorPlan): PlanXray {
  const { rooms, unresolved } = roomsOfPlan(plan);
  const walls = plan.walls.map((wall, index): WallPotential => {
    const kind = wallKindOf(wall);
    const beside = rooms.filter((room) => room.boundaryWallIds.includes(wall.id));
    const perimeter = isPerimeterWall(wall, rooms);
    return {
      wallId: wall.id,
      number: index + 1,
      kind,
      rooms: beside.map((room) => room.name),
      removal: removalOf(plan, kind, perimeter, beside),
      opening: openingOf(plan, kind, perimeter, beside),
    };
  });
  const counts = Object.fromEntries(
    PROCEDURE_ORDER.map((procedure) => [procedure, walls.filter((wall) => wall.removal.procedure === procedure).length]),
  ) as Record<Procedure, number>;
  const movable = rooms.flatMap((room): RoomPotential[] => {
    const move = moveOf(plan, room);
    const action = room.kind === "balcony" ? "Новый или больший" : room.kind === "shaft" ? "Изменение" : "Перенос";
    return move ? [{ roomId: room.id, name: room.name, kind: room.kind, action, move }] : [];
  });
  return { walls, rooms: movable, counts, unresolved };
}
