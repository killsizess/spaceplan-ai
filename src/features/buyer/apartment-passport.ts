import { countsInTotal, type FloorPlan } from "@/domain/floor-plan/types";
import { DISCLAIMER } from "@/domain/legal/disclaimer";
import { roomsOfPlan } from "@/domain/rules/rule-rooms";
import { buyerBase } from "@/domain/template/buyer-guard";
import { tr } from "@/lib/i18n";
import { ROOM_KINDS } from "../editor/room-kinds";
import { REPORT_LEVELS } from "../report/plan-report";
import { buildBuyerReview, type BuyerChange, type BuyerConflict, type BuyerQuestion } from "./buyer-review";

/**
 * The apartment passport: what the buyer's apartment is, what they changed in the
 * developer's template, the check of each change with how sure it is, the questions for
 * the developer and a specialist, what nobody has confirmed, and the shared disclaimer.
 * No prices and no estimate: the check is not a costing.
 */
export interface PassportRooms {
  area: number | null;
  rooms: { name: string; kind: string; area: number }[];
}

export interface ApartmentPassport {
  name: string;
  templateName: string;
  generatedAt: string;
  appVersion: string;
  fingerprint: string;
  answer: { label: string; meaning: string; procedure: string | null };
  draftNote: string | null;
  lowestLevel: string | null;
  before: PassportRooms;
  after: PassportRooms;
  changes: BuyerChange[];
  questions: BuyerQuestion[];
  conflicts: BuyerConflict[];
  unconfirmed: string[];
  limits: string[];
  disclaimer: string;
}

function roomsSummary(plan: FloorPlan): PassportRooms {
  const { rooms, unresolved } = roomsOfPlan(plan);
  return {
    area: unresolved ? null : rooms.filter((room) => countsInTotal(room.kind)).reduce((sum, room) => sum + room.area, 0),
    rooms: rooms.map((room) => ({ name: room.name, kind: ROOM_KINDS[room.kind].label, area: room.area })),
  };
}

export function buildPassport(plan: FloorPlan, meta: { generatedAt: string; appVersion: string }): ApartmentPassport | null {
  const review = buildBuyerReview(plan, meta);
  const base = buyerBase(plan);
  if (!review || !base) return null;
  const { proof } = review;
  return {
    name: plan.name,
    templateName: review.templateName,
    generatedAt: meta.generatedAt,
    appVersion: meta.appVersion,
    fingerprint: proof.fingerprint,
    answer: { label: proof.answer.label, meaning: proof.answer.meaning, procedure: proof.answer.procedure },
    draftNote: proof.draftNote,
    lowestLevel: review.lowestLevel ? REPORT_LEVELS[review.lowestLevel].label : null,
    before: roomsSummary(base),
    after: roomsSummary(plan),
    changes: review.changes,
    questions: review.questions,
    conflicts: review.conflicts,
    unconfirmed: review.unconfirmed,
    // The rule base's editions and gaps; the disclaimer is printed on its own, from its file.
    limits: proof.limits.filter((limit) => limit !== DISCLAIMER),
    disclaimer: DISCLAIMER,
  };
}

export const passportTitle = () => tr`Паспорт квартиры`;
