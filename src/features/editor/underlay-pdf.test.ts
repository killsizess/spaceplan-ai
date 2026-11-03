import { describe, expect, it } from "vitest";
import {
  inspectPdfHeader,
  MAX_PDF_FILE_BYTES,
  openLocalPdf,
  pdfPageSize,
} from "./underlay-pdf";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("PDF import boundaries", () => {
  it("accepts PDF 1.x and 2.0 headers with a short prefix", () => {
    for (const header of ["%PDF-1.0\n", "%PDF-1.7\r\n", "prefix\n%PDF-2.0\n"]) {
      expect(() => inspectPdfHeader(bytes(header), 500)).not.toThrow();
    }
  });

  it("rejects empty/oversized files and disguised content before loading PDF.js", () => {
    for (const size of [0, -1, MAX_PDF_FILE_BYTES + 1, NaN, Infinity]) {
      expect(() => inspectPdfHeader(bytes("%PDF-1.7\n"), size)).toThrow(
        "25 МБ",
      );
    }
    for (const header of [
      "<html>PDF</html>",
      "%PDF-1.7evil",
      "%PDF-3.0\n",
      "x".repeat(1024) + "%PDF-1.7\n",
    ]) {
      expect(() => inspectPdfHeader(bytes(header), 3000)).toThrow(
        "не соответствует PDF",
      );
    }
  });

  it("bounds both canvas sides while preserving page proportions", () => {
    expect(pdfPageSize(360, 600)).toMatchObject({ width: 1229, height: 2048 });
    expect(pdfPageSize(600, 360)).toMatchObject({ width: 2048, height: 1229 });
    for (const [width, height] of [
      [1, 1],
      [1e9, 1],
      [1, 1e9],
      [4093, 2048],
      [317, 599],
    ]) {
      const size = pdfPageSize(width, height);
      expect(Number.isFinite(size.scale)).toBe(true);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048);
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(1);
    }
  });

  it("rejects invalid or unrepresentable page dimensions", () => {
    for (const [width, height] of [
      [0, 2],
      [-1, 3],
      [Infinity, 10],
      [NaN, 10],
      [Number.MIN_VALUE, Number.MIN_VALUE],
    ]) {
      expect(() => pdfPageSize(width, height)).toThrow("размеры");
    }
  });

  it("honors an already cancelled import without loading browser modules", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openLocalPdf(new File(["%PDF-1.7\n"], "plan.pdf"), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a pending read and safely ignores its late completion", async () => {
    let finish: ((value: ArrayBuffer) => void) | undefined;
    let started: (() => void) | undefined;
    const pendingRead = new Promise<void>((resolve) => {
      started = resolve;
    });
    class DelayedFile extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        started?.();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    }
    const controller = new AbortController();
    const operation = openLocalPdf(
      new DelayedFile(["%PDF-1.7\n"], "plan.pdf"),
      controller.signal,
    );
    await pendingRead;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    finish?.(new ArrayBuffer(0));
    await Promise.resolve();
  });
});
