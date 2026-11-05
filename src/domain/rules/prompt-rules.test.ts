import { describe, expect, it } from "vitest";
import { interpretPrompt } from "./prompt-rules";

const rules = (text: string) => interpretPrompt(text).rules.map((rule) => {
  const copy: Partial<typeof rule> = { ...rule };
  delete copy.id;
  delete copy.phrase;
  return copy;
});

describe("reading a developer's text", () => {
  it("reads room areas in Russian, in several phrasings", () => {
    expect(rules("Кухня не меньше 9 м²")).toEqual([{ type: "room-min-area", target: "kitchen", value: 9 }]);
    expect(rules("площадь спальни не менее 10,5 кв.м")).toEqual([{ type: "room-min-area", target: "bedroom", value: 10.5 }]);
    expect(rules("минимальная площадь кухни 12 м2")).toEqual([{ type: "room-min-area", target: "kitchen", value: 12 }]);
    expect(rules("санузел не больше 6 м²")).toEqual([{ type: "room-max-area", target: "bathroom", value: 6 }]);
    expect(rules("гостиная от 18 м²")).toEqual([{ type: "room-min-area", target: "living", value: 18 }]);
    expect(rules("кухня до 15 м²")).toEqual([{ type: "room-max-area", target: "kitchen", value: 15 }]);
    expect(rules("жилая комната минимум 8 м²")).toEqual([{ type: "room-min-area", target: "any-living", value: 8 }]);
  });

  it("reads room areas in English", () => {
    expect(rules("Kitchen at least 9 m2")).toEqual([{ type: "room-min-area", target: "kitchen", value: 9 }]);
    expect(rules("minimum bedroom area 10 m2")).toEqual([{ type: "room-min-area", target: "bedroom", value: 10 }]);
    expect(rules("bathroom no more than 6 m2")).toEqual([{ type: "room-max-area", target: "bathroom", value: 6 }]);
    expect(rules("Living room at least 18.5 sqm")).toEqual([{ type: "room-min-area", target: "living", value: 18.5 }]);
  });

  it("does not take a bare number for a limit", () => {
    const { rules: found, notUnderstood } = interpretPrompt("кухня 9 м²");
    expect(found).toEqual([]);
    expect(notUnderstood).toEqual(["кухня 9 м²"]);
  });

  it("reads several rules from one text and keeps each phrase", () => {
    const profile = interpretPrompt("Кухня не меньше 9 м², спальня не меньше 10 м². Потолки не ниже 2,6 м\nНесущие стены не трогать");
    expect(profile.rules.map((rule) => rule.type)).toEqual(["room-min-area", "room-min-area", "min-height", "keep-bearing"]);
    expect(profile.rules.map((rule) => rule.phrase)).toEqual(["Кухня не меньше 9 м²", "спальня не меньше 10 м²", "Потолки не ниже 2,6 м", "Несущие стены не трогать"]);
    expect(profile.rules.map((rule) => rule.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(profile.notUnderstood).toEqual([]);
  });

  it("reads the ceiling height", () => {
    expect(rules("высота потолка не ниже 2,7 м")).toEqual([{ type: "min-height", value: 2.7 }]);
    expect(rules("ceiling height at least 2.5 m")).toEqual([{ type: "min-height", value: 2.5 }]);
    expect(rules("потолки 2,7 м")).toEqual([]);
  });

  it("reads a required window, for a kind of room or for any living room", () => {
    expect(rules("в каждой комнате окно")).toEqual([{ type: "window-required", target: "any-living" }]);
    expect(rules("кухня с окном")).toEqual([{ type: "window-required", target: "kitchen" }]);
    expect(rules("every bedroom must have a window")).toEqual([{ type: "window-required", target: "bedroom" }]);
    expect(rules("санузел без окна")).toEqual([]);
  });

  it("reads bearing walls", () => {
    for (const text of ["несущие стены не трогать", "нельзя менять несущие стены", "do not touch load-bearing walls", "keep structural walls"]) {
      expect(rules(text)).toEqual([{ type: "keep-bearing" }]);
    }
    expect(rules("несущие стены из бетона")).toEqual([]);
  });

  it("reads rooms that must not be merged", () => {
    expect(rules("нельзя объединять кухню с гостиной")).toEqual([{ type: "no-merge", target: "kitchen", other: "living" }]);
    expect(rules("кухню с комнатой не объединять")).toEqual([{ type: "no-merge", target: "kitchen", other: "any-living" }]);
    expect(rules("do not merge the kitchen with the living room")).toEqual([{ type: "no-merge", target: "kitchen", other: "living" }]);
    expect(rules("объединять кухню с гостиной можно")).toEqual([]);
  });

  it("reads rooms that must stay in place", () => {
    expect(rules("санузел не переносить")).toEqual([{ type: "keep-room", target: "bathroom" }]);
    expect(rules("кухни и санузлы на своих местах")).toEqual([{ type: "keep-room", target: "kitchen" }, { type: "keep-room", target: "bathroom" }]);
    expect(rules("мокрые зоны не переносить")).toEqual([{ type: "keep-room", target: "bathroom" }, { type: "keep-room", target: "kitchen" }]);
    expect(rules("do not move the bathroom")).toEqual([{ type: "keep-room", target: "bathroom" }]);
  });

  it("reads that changes need a project", () => {
    expect(rules("любая перепланировка только по проекту")).toEqual([{ type: "project-required" }]);
    expect(rules("any change requires a permit")).toEqual([{ type: "project-required" }]);
  });

  it("reads how many rooms there should be", () => {
    expect(rules("две спальни")).toEqual([{ type: "room-count", target: "bedroom", min: 2, max: 2 }]);
    expect(rules("минимум 2 спальни")).toEqual([{ type: "room-count", target: "bedroom", min: 2 }]);
    expect(rules("не больше 1 санузла")).toEqual([{ type: "room-count", target: "bathroom", max: 1 }]);
    expect(rules("at least 3 bedrooms")).toEqual([{ type: "room-count", target: "bedroom", min: 3 }]);
    expect(rules("two bathrooms")).toEqual([{ type: "room-count", target: "bathroom", min: 2, max: 2 }]);
  });

  it("returns what it did not understand instead of guessing, and an empty text gives nothing", () => {
    const profile = interpretPrompt("Кухня не меньше 9 м². Вид из окна важнее всего. Фасад по согласованию с архитектором");
    expect(profile.rules).toHaveLength(1);
    expect(profile.notUnderstood).toEqual(["Вид из окна важнее всего", "Фасад по согласованию с архитектором"]);
    expect(interpretPrompt("   ")).toEqual({ prompt: "   ", rules: [], notUnderstood: [] });
  });

  it("does not understand another language, and says so", () => {
    const profile = interpretPrompt("La cocina debe tener al menos 9 m2");
    expect(profile.rules).toEqual([]);
    expect(profile.notUnderstood).toEqual(["La cocina debe tener al menos 9 m2"]);
  });
});
