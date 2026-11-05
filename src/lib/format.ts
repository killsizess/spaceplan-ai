import { currentLanguage, currentLocale } from "@/lib/i18n";
import { areaText } from "@/lib/units";
const lengthFormatter = new Intl.NumberFormat(currentLocale(), {
  maximumFractionDigits: 2,
});

/** An area with its unit, in square metres or square feet. */
export function formatArea(value: number): string {
  return areaText(value);
}

export function formatLength(value: number): string {
  return lengthFormatter.format(value);
}

/** «1 стена», «2 стены», «5 стен». */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  if (currentLanguage() === "en") return `${count} ${Math.abs(count) === 1 ? one : many}`;
  const tens = Math.abs(count) % 100, units = Math.abs(count) % 10;
  const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
  return `${count} ${word}`;
}
