import { tr } from "@/lib/i18n";
import type { PlanRequirement, RoomKind } from "@/domain/floor-plan/types";
import type {
  RequirementConflict,
  RequirementResult,
  RequirementStatus,
  WallChange,
} from "@/domain/floor-plan/plan-requirements";
import { formatArea } from "@/lib/format";
import { ROOM_KINDS } from "./room-kinds";

/** The words for requirements, shared by the requirements panel and the report. */
export const STATUS_TEXT: Record<RequirementStatus, string> = {
  met: tr`Выполнено`,
  violated: tr`Нарушено`,
  "no-rooms": tr`Нет помещений`,
  inactive: tr`Не проверяется`,
};

const kindLabel = (kind: RoomKind) => ROOM_KINDS[kind].label;

/** Human description of a requirement, built only from its typed fields. */
export function describeRequirement(
  requirement: PlanRequirement,
  wallName: (id: string) => string,
  labelName: (id: string) => string | undefined = () => undefined,
): string {
  const subject = (kind: RoomKind, labelId?: string) =>
    labelId ? `«${labelName(labelId) ?? tr`Помещение без параметров`}»` : kindLabel(kind);
  switch (requirement.type) {
    case "room-min-area":
      return tr`${subject(requirement.kind, requirement.labelId)}: площадь не меньше ${formatArea(requirement.minArea)}`;
    case "room-max-area":
      return tr`${subject(requirement.kind, requirement.labelId)}: площадь не больше ${formatArea(requirement.maxArea)}`;
    case "room-not-walkthrough":
      return tr`${subject(requirement.kind, requirement.labelId)}: не проходная`;
    case "rooms-connected":
      return tr`${kindLabel(requirement.kind)} рядом с «${kindLabel(requirement.otherKind)}»${requirement.byDoor ? tr`, с дверью` : ""}`;
    case "wall-fixed":
      return tr`${wallName(requirement.wallId)} не меняется`;
    case "bearing-walls-kept":
      return tr`Несущие стены не меняются (${requirement.walls.length})`;
  }
}

function missingRooms(requirement: PlanRequirement): string {
  if (requirement.type === "rooms-connected") {
    return requirement.kind === requirement.otherKind
      ? tr`Нужно хотя бы два помещения «${kindLabel(requirement.kind)}».`
      : tr`Нет помещений «${kindLabel(requirement.kind)}» или «${kindLabel(requirement.otherKind)}». Назначение задаётся в параметрах помещения.`;
  }
  if (requirement.type === "wall-fixed" || requirement.type === "bearing-walls-kept") return "";
  return requirement.labelId
    ? tr`Помещение с этими параметрами сейчас не найдено: после перепланировки привяжите параметры заново или удалите требование.`
    : tr`Нет помещений с назначением «${kindLabel(requirement.kind)}». Назначение задаётся в параметрах помещения.`;
}

const WALL_CHANGE_TEXT: Record<WallChange, string> = {
  deleted: tr`удалена`,
  moved: tr`перенесена или изменена её длина`,
  thickness: tr`изменена толщина`,
  unmarked: tr`больше не отмечена как несущая`,
};

export function requirementDetail(
  requirement: PlanRequirement,
  result: RequirementResult | undefined,
  nameOf: (id: string) => string,
  wallName: (id: string) => string,
): string {
  if (requirement.type === "wall-fixed") {
    const change = result?.findings[0]?.change;
    return change === "deleted" ? tr`Стена удалена.`
      : change === "moved" ? tr`Стена перенесена или изменена её длина.`
        : change === "thickness" ? tr`Изменена толщина стены.`
          : tr`Ось и толщина стены совпадают с сохранёнными.`;
  }
  if (requirement.type === "bearing-walls-kept") {
    const changed = (result?.findings ?? []).filter((finding) => finding.change);
    return changed.length
      ? changed.map((finding) => `${wallName(finding.wallId ?? "")}: ${WALL_CHANGE_TEXT[finding.change!]}`).join("; ")
      : tr`Ось, толщина и отметка всех несущих стен совпадают с сохранёнными.`;
  }
  if (!result || result.status === "inactive") return tr`Требования к помещениям проверяются в режиме «По стенам».`;
  if (result.status === "no-rooms") return missingRooms(requirement);
  if (requirement.type === "room-min-area" || requirement.type === "room-max-area") {
    return result.findings.map((finding) => `${nameOf(finding.roomId)} — ${formatArea(finding.area ?? 0)}`).join("; ");
  }
  if (requirement.type === "room-not-walkthrough") {
    return result.findings.map((finding) => tr`${nameOf(finding.roomId)} — дверей: ${finding.doors ?? 0}`).join("; ");
  }
  return result.findings.length
    ? result.findings.map((finding) => `${nameOf(finding.roomId)} ↔ ${nameOf(finding.otherRoomId ?? "")}`).join("; ")
    : requirement.byDoor ? tr`Ни одна пара не соединена дверью.` : tr`Ни одна пара не граничит через стену.`;
}

export function conflictText(conflict: RequirementConflict): string {
  return conflict.reason === "area-range"
    ? tr`${kindLabel(conflict.kind)}: минимальная площадь больше максимальной — выполнить оба требования нельзя.`
    : tr`${kindLabel(conflict.kind)}: помещение не должно быть проходным, но обязано иметь двери в два разных помещения. Если такое помещение одно, это невозможно.`;
}

