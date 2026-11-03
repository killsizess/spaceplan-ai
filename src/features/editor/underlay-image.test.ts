import { describe, expect, it } from "vitest";
import { inspectUnderlayImage, readUnderlayImage } from "./underlay-image";

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number, marker = 0xc0) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    marker,
    0,
    8,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
  ]);
}

describe("underlay input validation before image decoding", () => {
  it("reads PNG dimensions and both baseline and progressive JPEG frames", () => {
    expect(inspectUnderlayImage(pngHeader(1400, 900), "image/png")).toEqual({
      width: 1400,
      height: 900,
    });
    expect(inspectUnderlayImage(jpegHeader(2400, 1800), "image/jpeg")).toEqual({
      width: 2400,
      height: 1800,
    });
    expect(
      inspectUnderlayImage(jpegHeader(1800, 2400, 0xc2), "image/jpeg"),
    ).toEqual({ width: 1800, height: 2400 });
  });

  it("rejects fake MIME and malformed or truncated headers", () => {
    expect(() =>
      inspectUnderlayImage(pngHeader(100, 100), "image/jpeg"),
    ).toThrow("не соответствует JPG");
    expect(() =>
      inspectUnderlayImage(jpegHeader(100, 100), "image/png"),
    ).toThrow("не соответствует PNG");
    expect(() =>
      inspectUnderlayImage(jpegHeader(100, 100).slice(0, 14), "image/jpeg"),
    ).toThrow("Не удалось прочитать");
    expect(() =>
      inspectUnderlayImage(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
        "image/jpeg",
      ),
    ).toThrow();
    const malformed = pngHeader(100, 100);
    malformed[11] = 255;
    expect(() => inspectUnderlayImage(malformed, "image/png")).toThrow(
      "Повреждён заголовок",
    );
  });

  it("rejects huge and zero-sized images before allocating decoded pixels", () => {
    expect(inspectUnderlayImage(pngHeader(8000, 5000), "image/png")).toEqual({
      width: 8000,
      height: 5000,
    });
    expect(() =>
      inspectUnderlayImage(pngHeader(8001, 5000), "image/png"),
    ).toThrow("40 мегапикселей");
    expect(() =>
      inspectUnderlayImage(pngHeader(0xffffffff, 1), "image/png"),
    ).toThrow("40 мегапикселей");
    expect(() => inspectUnderlayImage(pngHeader(0, 100), "image/png")).toThrow(
      "размеры изображения",
    );
    expect(() =>
      inspectUnderlayImage(jpegHeader(100, 0), "image/jpeg"),
    ).toThrow("размеры изображения");
  });

  it("rejects unsupported, empty and oversized files without browser APIs", async () => {
    await expect(
      readUnderlayImage(
        new File(["<svg />"], "plan.svg", { type: "image/svg+xml" }),
      ),
    ).rejects.toThrow("JPG или PNG");
    await expect(
      readUnderlayImage(new File([], "plan.png", { type: "image/png" })),
    ).rejects.toThrow("непустое");
    await expect(
      readUnderlayImage(
        new File([new Uint8Array(12 * 1024 * 1024 + 1)], "plan.png", {
          type: "image/png",
        }),
      ),
    ).rejects.toThrow("12 МБ");
    await expect(
      readUnderlayImage(
        new File(["not an image"], "plan.png", { type: "image/png" }),
      ),
    ).rejects.toThrow("не соответствует PNG");
  });
});
