import { describe, expect, it } from "vitest";
import { factLines } from "./facts";

describe("answers as a report prints them", () => {
  it("prints nothing without a region: no rules ran", () => {
    expect(factLines(undefined)).toEqual([]);
    expect(factLines({ gasified: true })).toEqual([]);
  });

  it("prints only the region when there is no rule base for it", () => {
    expect(factLines({ region: "other" })).toEqual([{ label: "Где находится квартира", answer: "Другая страна или регион" }]);
  });

  it("prints every question for Moscow, and an unanswered one as not known", () => {
    const lines = factLines({ region: "moscow", gasified: true, woodenFloors: false, below: "same-layout", floorLevel: "upper" });
    expect(lines).toEqual([
      { label: "Где находится квартира", answer: "Москва" },
      { label: "В квартире есть газ", answer: "Да" },
      { label: "Перекрытия деревянные", answer: "Нет" },
      { label: "Дом — объект культурного наследия", answer: "Не знаю" },
      { label: "Дом признан аварийным", answer: "Не знаю" },
      { label: "Этаж квартиры", answer: "Второй и выше" },
      { label: "Этажом ниже", answer: "Такая же планировка" },
      { label: "Этажом выше", answer: "Не знаю" },
    ]);
  });
});
