import { tr } from "@/lib/i18n";
import type { BuildingFacts, NeighbourFloor } from "@/domain/floor-plan/types";

/** The questions about the building, in the words the screen and the report use. */
export const YES_NO_QUESTIONS: readonly { key: "gasified" | "woodenFloors" | "heritage" | "emergency"; label: string }[] = [
  { key: "gasified", label: tr`В квартире есть газ` },
  { key: "woodenFloors", label: tr`Перекрытия деревянные` },
  { key: "heritage", label: tr`Дом — объект культурного наследия` },
  { key: "emergency", label: tr`Дом признан аварийным` },
];
export const REGION_LABEL = tr`Где находится квартира`;
export const FLOOR_LABEL = tr`Этаж квартиры`;
export const NEIGHBOUR_LABELS = { below: tr`Этажом ниже`, above: tr`Этажом выше` } as const;
export const UNKNOWN_ANSWER = tr`Не знаю`;

export const NEIGHBOUR_ANSWERS: Readonly<Record<NeighbourFloor, string>> = {
  "same-layout": tr`Такая же планировка`,
  "other-layout": tr`Другая планировка`,
  "no-dwelling": tr`Квартир нет`,
};
export const FLOOR_ANSWERS = { first: tr`Первый`, upper: tr`Второй и выше` } as const;
export const REGION_ANSWERS = { moscow: tr`Москва`, other: tr`Другая страна или регион` } as const;

export interface FactLine {
  label: string;
  answer: string;
}

/**
 * The answers as a report prints them. A question not answered reads "Не знаю", because
 * that is what the conclusions were drawn from. With no region there is nothing to print:
 * no rules ran, so no answer mattered.
 */
export function factLines(facts: BuildingFacts | undefined): FactLine[] {
  const region = facts?.region;
  if (!region) return [];
  const lines: FactLine[] = [{ label: REGION_LABEL, answer: REGION_ANSWERS[region] }];
  if (region !== "moscow") return lines;
  for (const { key, label } of YES_NO_QUESTIONS) {
    const value = facts?.[key];
    lines.push({ label, answer: value === undefined ? UNKNOWN_ANSWER : value ? tr`Да` : tr`Нет` });
  }
  lines.push({ label: FLOOR_LABEL, answer: facts?.floorLevel ? FLOOR_ANSWERS[facts.floorLevel] : UNKNOWN_ANSWER });
  for (const side of ["below", "above"] as const) {
    const value = facts?.[side];
    lines.push({ label: NEIGHBOUR_LABELS[side], answer: value ? NEIGHBOUR_ANSWERS[value] : UNKNOWN_ANSWER });
  }
  return lines;
}
