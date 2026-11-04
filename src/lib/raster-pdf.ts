export interface RasterPdfInput {
  jpeg: Uint8Array;
  widthPixels: number;
  heightPixels: number;
  widthMm: number;
  heightMm: number;
}

const MAX_RASTER_PIXELS = 16_000_000;
const MAX_RASTER_EDGE = 5_000;
const MAX_JPEG_BYTES = 30 * 1024 * 1024;
const encoder = new TextEncoder();

/** Physical export pages are always A4; orientation only swaps the sides. */
export function assertA4Page(widthMm: number, heightMm: number): void {
  const close = (value: number, expected: number) =>
    Number.isFinite(value) && Math.abs(value - expected) < 0.000001;
  if (
    !(
      (close(widthMm, 210) && close(heightMm, 297)) ||
      (close(widthMm, 297) && close(heightMm, 210))
    )
  ) {
    throw new Error("Экспорт поддерживает лист A4 размером 210 × 297 мм.");
  }
}

export function assertRasterSize(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width, height) > MAX_RASTER_EDGE ||
    width * height > MAX_RASTER_PIXELS
  ) {
    throw new Error("Размер изображения для экспорта слишком велик или некорректен.");
  }
}

/** The RGB, eight-bit JPEG frame must agree with the image dictionary. */
function assertJpeg(jpeg: Uint8Array, width: number, height: number): void {
  if (
    jpeg.length < 4 ||
    jpeg.length > MAX_JPEG_BYTES ||
    jpeg[0] !== 0xff ||
    jpeg[1] !== 0xd8 ||
    jpeg[jpeg.length - 2] !== 0xff ||
    jpeg[jpeg.length - 1] !== 0xd9
  ) {
    throw new Error("Не удалось подготовить JPEG для PDF.");
  }
  let cursor = 2;
  while (cursor < jpeg.length - 2) {
    if (jpeg[cursor++] !== 0xff) break;
    while (jpeg[cursor] === 0xff) cursor++;
    const marker = jpeg[cursor++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 2 > jpeg.length) break;
    const length = (jpeg[cursor] << 8) | jpeg[cursor + 1];
    if (length < 2 || cursor + length > jpeg.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (
        length >= 17 &&
        jpeg[cursor + 2] === 8 &&
        ((jpeg[cursor + 3] << 8) | jpeg[cursor + 4]) === height &&
        ((jpeg[cursor + 5] << 8) | jpeg[cursor + 6]) === width &&
        jpeg[cursor + 7] === 3
      ) {
        return;
      }
      break;
    }
    cursor += length;
  }
  throw new Error("Размеры или цветовой формат JPEG не подходят для PDF.");
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pdfNumber(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * A PDF 1.4 whose pages are rendered images at their physical A4 size. Text is part of
 * the image, so Cyrillic uses the browser's fonts and needs no embedded font.
 */
export function createRasterPdfDocument(pages: readonly RasterPdfInput[]): Uint8Array<ArrayBuffer> {
  if (!pages.length) throw new Error("В документе нет страниц.");
  const objects: Uint8Array[] = [
    encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encoder.encode(`<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ")}] /Count ${pages.length} >>`),
  ];
  pages.forEach(({ jpeg, widthPixels, heightPixels, widthMm, heightMm }, index) => {
    assertA4Page(widthMm, heightMm);
    assertRasterSize(widthPixels, heightPixels);
    assertJpeg(jpeg, widthPixels, heightPixels);
    const widthPoints = pdfNumber((widthMm * 72) / 25.4);
    const heightPoints = pdfNumber((heightMm * 72) / 25.4);
    const content = encoder.encode(
      `q\n${widthPoints} 0 0 ${heightPoints} 0 0 cm\n/Im0 Do\nQ\n`,
    );
    const first = 3 + index * 3;
    objects.push(
      encoder.encode(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPoints} ${heightPoints}] /Resources << /XObject << /Im0 ${first + 1} 0 R >> >> /Contents ${first + 2} 0 R >>`,
      ),
      concatenate([
        encoder.encode(
          `<< /Type /XObject /Subtype /Image /Width ${widthPixels} /Height ${heightPixels} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        ),
        jpeg,
        encoder.encode("\nendstream"),
      ]),
      concatenate([
        encoder.encode(`<< /Length ${content.length} >>\nstream\n`),
        content,
        encoder.encode("endstream"),
      ]),
    );
  });
  const parts = [
    encoder.encode("%PDF-1.4\n"),
    new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ];
  const offsets = [0];
  let byteLength = parts.reduce((size, part) => size + part.length, 0);
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    const entry = concatenate([
      encoder.encode(`${index + 1} 0 obj\n`),
      object,
      encoder.encode("\nendobj\n"),
    ]);
    parts.push(entry);
    byteLength += entry.length;
  });
  const crossReference = [
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n`,
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${byteLength}\n%%EOF\n`,
  ].join("");
  parts.push(encoder.encode(crossReference));
  return concatenate(parts);
}

/** A single-page PDF containing the rendered plan at its physical A4 size. */
export function createRasterPdf(input: RasterPdfInput): Uint8Array<ArrayBuffer> {
  return createRasterPdfDocument([input]);
}
