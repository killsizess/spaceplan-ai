const areaFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});
const lengthFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});

export function formatArea(value: number): string {
  return `${areaFormatter.format(value)} м²`;
}

export function formatLength(value: number): string {
  return lengthFormatter.format(value);
}

/** «1 стена», «2 стены», «5 стен». */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const tens = Math.abs(count) % 100, units = Math.abs(count) % 10;
  const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
  return `${count} ${word}`;
}
