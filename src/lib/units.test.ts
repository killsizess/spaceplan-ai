import { afterEach, describe, expect, it } from "vitest";
import { setDictionary } from "./i18n";
import { formatArea } from "./format";
import {
  areaInput, areaText, defaultWallSize, FOOT, INCH, lengthInput, lengthText, parseArea, parseFeetAndInches,
  parseLength, roughLengthText, scaleBarLength, setUnits, snapToGrid,
} from "./units";

afterEach(() => {
  setUnits("metric");
  setDictionary("ru", null);
});

describe("metric, as before", () => {
  it("shows and reads lengths the way the app always has", () => {
    expect(lengthText(4.8)).toBe("4,8 м");
    expect(lengthInput(0.30000000000000004)).toBe("0.3");
    expect(parseLength("4,8")).toBe(4.8);
    expect(parseLength("")).toBeNaN();
    expect(areaText(12.5)).toBe("12,5 м²");
    expect(formatArea(12.5)).toBe("12,5 м²");
    expect(snapToGrid(1.234)).toBe(1.2);
    expect(defaultWallSize()).toEqual({ thickness: 0.2, height: 2.7 });
  });

  it("gives an untouched field back exactly, float noise and all", () => {
    expect(parseLength(lengthInput(0.30000000000000004), 0.30000000000000004)).toBe(0.30000000000000004);
  });
});

describe("feet and inches", () => {
  const imperial = () => setUnits("imperial");

  it("shows lengths to an eighth of an inch, in reduced fractions", () => {
    imperial();
    expect(lengthText(4.8)).toBe("15' 9\"");
    expect(lengthText(0.2)).toBe("7 7/8\"");
    expect(lengthText(FOOT * 12)).toBe("12'");
    expect(lengthText(FOOT * 12 + INCH * 6.5)).toBe("12' 6 1/2\"");
    expect(lengthText(INCH * 0.25)).toBe("1/4\"");
    expect(lengthText(0)).toBe("0\"");
    expect(lengthText(-FOOT)).toBe("−1'");
  });

  it("carries a rounded inch into the feet", () => {
    imperial();
    expect(lengthText(FOOT - INCH / 100)).toBe("1'");
  });

  it("reads lengths the ways people type them", () => {
    const cases: [string, number][] = [
      ["12' 6\"", 150], ["12'6\"", 150], ["12'6", 150], ["12 ft 6 in", 150], ["12ft 6in", 150], ["12 6", 150],
      ["12.5", 150], ["12'", 144], ["12 feet", 144], ["6\"", 6], ["6 in", 6], ["6 1/2\"", 6.5], ["1/2\"", 0.5],
      ["12' 6 1/2\"", 150.5], ["12′ 6″", 150], ["12,5", 150], ["-2'", -24], ["0' 15\"", 15],
    ];
    for (const [typed, inches] of cases) expect(parseFeetAndInches(typed), typed).toBeCloseTo(inches * INCH, 10);
  });

  it("does not guess at what is not a length", () => {
    for (const typed of ["", "abc", "12 m", "12' 6' 3", "1/0\"", "12 6 7"]) expect(parseFeetAndInches(typed), typed).toBeNaN();
  });

  it("reads back exactly what it shows", () => {
    imperial();
    for (const meters of [0.1, 0.2, 2.7, 4.8, 12.345, 0.0254, 100]) {
      const shown = lengthInput(meters);
      expect(Math.abs(parseFeetAndInches(shown) - meters)).toBeLessThanOrEqual(INCH / 16 + 1e-12);
    }
  });

  it("never moves a value that was only opened in a form", () => {
    imperial();
    expect(lengthInput(4.8)).toBe("15' 9\"");
    expect(parseFeetAndInches("15' 9\"")).not.toBe(4.8);
    expect(parseLength("15' 9\"", 4.8)).toBe(4.8);
    expect(parseLength("15' 10\"", 4.8)).toBeCloseTo(190 * INCH, 10);
  });

  it("shows and reads areas in square feet", () => {
    imperial();
    expect(areaText(32.64)).toBe("351,3 кв. фт");
    expect(formatArea(32.64)).toBe("351,3 кв. фт");
    expect(areaInput(9.290304)).toBe("100");
    expect(parseArea("100")).toBeCloseTo(9.290304, 10);
    expect(parseArea("100 sq ft")).toBeCloseTo(9.290304, 10);
    expect(parseArea(areaInput(10), 10)).toBe(10);
  });

  it("speaks English when the interface does", () => {
    imperial();
    setDictionary("en", { "{0} кв. фт": "{0} sq ft", "{0} фт": "{0} ft" });
    expect(areaText(9.290304)).toBe("100 sq ft");
    expect(roughLengthText(1000)).toBe("3,280.8 ft");
  });

  it("snaps to three inches and starts walls at six inches by nine feet", () => {
    imperial();
    expect(snapToGrid(1)).toBeCloseTo(39 * INCH, 10);
    expect(defaultWallSize()).toEqual({ thickness: 6 * INCH, height: 9 * FOOT });
  });

  it("makes scale bars of round feet", () => {
    imperial();
    const bar = scaleBarLength(2.5);
    expect(bar.meters).toBeCloseTo(10 * FOOT, 10);
    expect(bar.label).toBe("10 фт");
    setUnits("metric");
    expect(scaleBarLength(2.5)).toEqual({ meters: 5, label: "5 м" });
  });
});
