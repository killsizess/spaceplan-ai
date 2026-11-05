import { currentLocale, tr } from "./i18n";

/**
 * Units of measure on the screen. The plan itself is always in metres: feet and inches exist
 * only between the model and a person, so a plan reads the same either way and its file does
 * not change. Like the language, the choice is settled before the app loads, and switching
 * reloads the page.
 */
export type Units = "metric" | "imperial";

const STORAGE_KEY = "spaceplan-ai:units:v1";
/** Countries where plans are drawn in feet and inches. */
const IMPERIAL_REGIONS = ["US", "LR", "MM"];

export const FOOT = 0.3048;
export const INCH = 0.0254;
const SQUARE_FOOT = FOOT * FOOT;
/** Lengths are shown and read to an eighth of an inch, about 3 mm. */
const EIGHTHS = 8;

let units: Units = "metric";

export const currentUnits = (): Units => units;
export function setUnits(next: Units) {
  units = next;
}

function stored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(next: Units) {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice is simply not remembered.
  }
}

/** `?units=ft` or `?units=m` first, then the reader's choice, then the browser's country. */
export function detectUnits(): Units {
  const asked = new URLSearchParams(window.location.search).get("units");
  if (asked === "ft" || asked === "m") {
    const next = asked === "ft" ? "imperial" : "metric";
    store(next);
    return next;
  }
  const choice = stored();
  if (choice === "metric" || choice === "imperial") return choice;
  const region = (window.navigator.language || "").split("-")[1]?.toUpperCase();
  return region && IMPERIAL_REGIONS.includes(region) ? "imperial" : "metric";
}

export function chooseUnits(next: Units) {
  store(next);
  const url = new URL(window.location.href);
  url.searchParams.delete("units");
  window.location.replace(url);
}

const decimals = (digits: number) => new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: digits });

function feetAndInches(meters: number): string {
  const eighths = Math.round((Math.abs(meters) / INCH) * EIGHTHS);
  if (eighths === 0) return "0\"";
  const feet = Math.floor(eighths / (12 * EIGHTHS));
  const rest = eighths - feet * 12 * EIGHTHS;
  const whole = Math.floor(rest / EIGHTHS);
  let part = rest - whole * EIGHTHS;
  let denominator = EIGHTHS;
  while (part && part % 2 === 0) {
    part /= 2;
    denominator /= 2;
  }
  const fraction = part ? `${part}/${denominator}` : "";
  const inches = [whole ? String(whole) : "", fraction].filter(Boolean).join(" ");
  const sign = meters < 0 ? "−" : "";
  if (!feet) return `${sign}${inches}"`;
  return `${sign}${decimals(0).format(feet)}'${inches ? ` ${inches}"` : ""}`;
}

/** A length with its unit: «4,8 м», «4.8 m» or «15' 9"». */
export function lengthText(meters: number): string {
  return units === "imperial" ? feetAndInches(meters) : tr`${decimals(2).format(meters)} м`;
}

/** A limit in a message, where an eighth of an inch would be noise: «3,280.8 ft». */
export function roughLengthText(meters: number): string {
  return units === "imperial" ? tr`${decimals(1).format(meters / FOOT)} фт` : lengthText(meters);
}

/** «12,5 м²» or «134.5 sq ft». */
export function areaText(squareMeters: number): string {
  return units === "imperial"
    ? tr`${decimals(1).format(squareMeters / SQUARE_FOOT)} кв. фт`
    : tr`${decimals(2).format(squareMeters)} м²`;
}

/** The short name of the length unit, next to an input. */
export const lengthUnitLabel = (): string => (units === "imperial" ? tr`фт, дюйм` : tr`м`);
export const areaUnitLabel = (): string => (units === "imperial" ? tr`кв. фт` : tr`м²`);
/** What the whole drawing is measured in, for a caption. */
export const unitsName = (): string => (units === "imperial" ? tr`футы и дюймы` : tr`метры`);

/** What an input shows for a length. Metric input keeps a dot, as typed numbers do. */
export function lengthInput(meters: number): string {
  return units === "imperial" ? feetAndInches(meters) : String(Number(meters.toFixed(12)));
}

export function areaInput(squareMeters: number): string {
  return units === "imperial"
    ? String(Number((squareMeters / SQUARE_FOOT).toFixed(1)))
    : String(Number(squareMeters.toFixed(12)));
}

const metric = (text: string) => (text.trim() ? Number(text.replace(",", ".")) : NaN);

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const FRACTION = String.raw`\d+\s*\/\s*\d+`;
const ofFraction = (text: string | undefined) => {
  if (!text) return 0;
  const [top, bottom] = text.split("/").map(Number);
  return bottom ? top / bottom : NaN;
};

/**
 * Feet and inches as people type them: 12' 6", 12'6, 12 ft 6 in, 12 6, 6 1/2", 12.5 (feet).
 * Anything else is not a length: NaN, and the form says so instead of guessing.
 */
export function parseFeetAndInches(raw: string): number {
  let text = raw.trim().toLowerCase()
    .replace(/[′’‘`]/g, "'")
    .replace(/[″“”]|''/g, "\"")
    .replace(/,/g, ".")
    .replace(/feet|foot|ft\.?/g, "'")
    .replace(/inches|inch|in\.?/g, "\"");
  if (!text) return NaN;
  let sign = 1;
  if (/^[-−]/.test(text)) {
    sign = -1;
    text = text.slice(1).trim();
  }
  const inchesOf = (whole: string | undefined, fraction: string | undefined) => Number(whole ?? 0) + ofFraction(fraction);
  const forms: [RegExp, (match: RegExpMatchArray) => number][] = [
    [new RegExp(`^(${NUMBER})\\s*'(?:\\s*(${NUMBER})?\\s*(${FRACTION})?\\s*"?)?$`), (m) => Number(m[1]) * 12 + inchesOf(m[2], m[3])],
    [new RegExp(`^(${NUMBER})?\\s*(${FRACTION})?\\s*"$`), (m) => (m[1] || m[2] ? inchesOf(m[1], m[2]) : NaN)],
    [new RegExp(`^(${NUMBER})\\s+(${NUMBER})(?:\\s+(${FRACTION}))?$`), (m) => Number(m[1]) * 12 + inchesOf(m[2], m[3])],
    [new RegExp(`^(${NUMBER})$`), (m) => Number(m[1]) * 12],
  ];
  for (const [pattern, read] of forms) {
    const match = text.match(pattern);
    if (match) {
      const inches = read(match);
      return Number.isFinite(inches) ? sign * inches * INCH : NaN;
    }
  }
  return NaN;
}

/**
 * What a typed length means, in metres. Given the value the field was filled from, an
 * untouched field gives that value back exactly: 4.8 m shows as 15' 9", which is 4.8006 m,
 * and a form must not move a wall by that just because it was opened and applied.
 */
export function parseLength(text: string, original?: number): number {
  if (original !== undefined && Number.isFinite(original) && text === lengthInput(original)) return original;
  return units === "imperial" ? parseFeetAndInches(text) : metric(text);
}

export function parseArea(text: string, original?: number): number {
  if (original !== undefined && Number.isFinite(original) && text === areaInput(original)) return original;
  if (units === "metric") return metric(text);
  const plain = text.toLowerCase().replace(/sq\.?\s*ft|ft2|ft²|square\s+feet|кв\.?\s*фт/g, "").trim();
  return plain ? Number(plain.replace(",", ".")) * SQUARE_FOOT : NaN;
}

/** Where the pointer snaps: every 10 cm, or every 3 inches. */
export function snapToGrid(meters: number): number {
  if (units === "imperial") return Math.round(meters / (3 * INCH)) * 3 * INCH;
  return Math.round(meters * 10) / 10;
}
export const snapLabel = (): string => (units === "imperial" ? tr`Привязка 3 дюйма` : tr`Привязка 0,1 м`);

/** Background grid: a minor step and how many of them make a major line. */
export const gridSpacing = (): { step: number; major: number } =>
  units === "imperial" ? { step: FOOT, major: 5 } : { step: 0.5, major: 2 };

/** A round length for a scale bar no shorter than `minimum` metres. */
export function scaleBarLength(minimum: number, steps: readonly number[] = [1, 2, 5]): { meters: number; label: string } {
  const unit = units === "imperial" ? FOOT : 1;
  const wanted = minimum / unit;
  for (let power = 10 ** Math.floor(Math.log10(Math.max(wanted, 1e-9))); ; power *= 10) {
    const step = steps.find((candidate) => candidate * power >= wanted - 1e-9);
    if (step !== undefined) {
      const value = step * power;
      return {
        meters: value * unit,
        label: units === "imperial" ? tr`${decimals(1).format(value)} фт` : tr`${decimals(2).format(value)} м`,
      };
    }
  }
}

/** New walls: the usual 20 cm × 2.7 m, or 6 inches × 9 feet. */
export const defaultWallSize = (): { thickness: number; height: number } =>
  units === "imperial" ? { thickness: 6 * INCH, height: 9 * FOOT } : { thickness: 0.2, height: 2.7 };

/** Two sizes of one thing: «4,3 × 2,3 м» as before, or «14' 1" × 7' 6"». */
export function sizeText(first: number, second: number): string {
  return units === "imperial"
    ? `${lengthText(first)} × ${lengthText(second)}`
    : tr`${decimals(2).format(first)} × ${decimals(2).format(second)} м`;
}

/** Feet and inches need the ' and " keys, which a decimal keypad does not have. */
export const lengthInputMode = (): "decimal" | "text" => (units === "imperial" ? "text" : "decimal");

/** A metric text where it already reads well, and another one for feet and inches. */
export const byUnits = (metric: string, imperial: () => string): string => (units === "imperial" ? imperial() : metric);
