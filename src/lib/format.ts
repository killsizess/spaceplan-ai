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
