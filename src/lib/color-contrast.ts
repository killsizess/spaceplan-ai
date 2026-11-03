function luminance(color: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/** Keep the palette's ink where readable; otherwise use contrasting black/white. */
export function readableRoomInk(background: string, preferred: string): string {
  const surface = luminance(background);
  const ink = luminance(preferred);
  const ratio = (Math.max(surface, ink) + 0.05) / (Math.min(surface, ink) + 0.05);
  if (ratio >= 4.5) return preferred;
  return surface > 0.179 ? "#000000" : "#ffffff";
}
