import { describe, expect, it } from "vitest";
import { createRasterPdf } from "./raster-pdf";

// An actual two-pixel RGB JPEG, including binary bytes above 0x7f.
const jpeg = new Uint8Array(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCSADRRN//Z",
  "base64",
));

const input = { jpeg, widthPixels: 2, heightPixels: 1, widthMm: 297, heightMm: 210 };

describe("single-page raster PDF", () => {
  it("roundtrips through PDF.js with one true A4 page and an actual image", async () => {
    const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (const [widthMm, heightMm] of [[297, 210], [210, 297]]) {
      const data = createRasterPdf({ ...input, widthMm, heightMm });
      const loading = getDocument({ data, useSystemFonts: false });
      try {
        const document = await loading.promise;
        expect(document.numPages).toBe(1);
        const page = await document.getPage(1);
        expect(page.view[2]).toBeCloseTo((widthMm * 72) / 25.4, 5);
        expect(page.view[3]).toBeCloseTo((heightMm * 72) / 25.4, 5);
        const operators = await page.getOperatorList();
        const index = operators.fnArray.findIndex((operation) => operation === OPS.paintImageXObject);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(operators.argsArray[index].slice(1)).toEqual([2, 1]);
        expect((await page.getTextContent()).items).toEqual([]);
      } finally {
        await loading.destroy();
      }
    }
  });

  it("points every xref entry at its real byte offset and preserves the JPEG", () => {
    const data = createRasterPdf(input);
    const text = new TextDecoder("latin1").decode(data);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    const crossReferenceOffset = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(crossReferenceOffset, crossReferenceOffset + 4)).toBe("xref");
    const entries = text.slice(crossReferenceOffset).match(/\d{10} 00000 n /g) ?? [];
    expect(entries).toHaveLength(5);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + 7)).toBe(`${index + 1} 0 obj`);
    });
    const imageStart = text.indexOf("stream\n", text.indexOf("/Subtype /Image")) + 7;
    expect(data.slice(imageStart, imageStart + jpeg.length)).toEqual(jpeg);
    expect(text).toContain(`/Length ${jpeg.length} >>`);
    expect(createRasterPdf(input)).toEqual(data);
  });

  it("rejects non-A4 paper, unreasonable raster sizes, and mismatched JPEG frames", () => {
    for (const change of [
      { widthMm: NaN }, { heightMm: Infinity }, { widthMm: 296 },
      { widthPixels: 0 }, { widthPixels: 2.5 }, { heightPixels: -1 },
      { widthPixels: 5_001 }, { widthPixels: 5_000, heightPixels: 5_000 },
      { widthPixels: 3 }, { heightPixels: 2 },
      { jpeg: new Uint8Array() }, { jpeg: jpeg.slice(0, -1) },
      { jpeg: new TextEncoder().encode("not a JPEG") },
    ]) {
      expect(() => createRasterPdf({ ...input, ...change })).toThrow();
    }
  });

  it("does not accept a corrupt or non-RGB frame behind a JPEG header", () => {
    const frame = jpeg.findIndex((value, index) => value === 0xff && jpeg[index + 1] === 0xc0);
    expect(frame).toBeGreaterThan(0);
    for (const [offset, value] of [[3, 1], [4, 12], [9, 1]]) {
      const corrupt = jpeg.slice();
      corrupt[frame + offset] = value;
      expect(() => createRasterPdf({ ...input, jpeg: corrupt })).toThrow();
    }
  });
});
