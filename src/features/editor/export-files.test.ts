import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlanExportBlob,
  makePlanExportFilename,
  rasterizePlanExport,
  setPngPrintResolution,
} from "./export-files";
import type { PlanExportLayout } from "./export-layout";

const layout: PlanExportLayout = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm"><rect width="100%" height="100%" fill="white"/></svg>',
  widthMm: 297, heightMm: 210, scaleDenominator: 50,
  roomCount: 1, totalArea: 20, warnings: [],
};
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAARSURBVAiZY3wvp/ufgYGBAQAOZQI7R4Ln5QAAAABJRU5ErkJggg==", "base64"));

function browserHarness(autoLoad = true) {
  const images: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "";
    constructor() { images.push(this); }
    set src(_value: string) {
      if (autoLoad) queueMicrotask(() => this.onload?.());
    }
    removeAttribute = vi.fn();
  }
  const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width: 0, height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback, type?: string) => callback(new Blob([png], { type: type ?? "image/png" }))),
  };
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-plan");
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { canvas, context, images, createUrl, revokeUrl };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("client plan file export", () => {
  it("renders true A4 pixels at 300 dpi on white and releases the SVG URL", async () => {
    const browser = browserHarness();
    const signal = new AbortController().signal;
    const canvas = await rasterizePlanExport(layout, signal);
    expect(canvas).toBe(browser.canvas);
    expect(canvas.width).toBe(3508);
    expect(canvas.height).toBe(2480);
    expect(browser.context.fillStyle).toBe("#ffffff");
    expect(browser.context.fillRect).toHaveBeenCalledWith(0, 0, 3508, 2480);
    expect(browser.context.drawImage).toHaveBeenCalledWith(browser.images[0], 0, 0, 3508, 2480);
    expect(browser.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:local-plan");
    expect(browser.images[0].removeAttribute).toHaveBeenCalledWith("src");
    expect(browser.images[0].onload).toBeNull();
  });

  it("supports portrait and a smaller preview resolution without changing paper", async () => {
    browserHarness();
    const canvas = await rasterizePlanExport({ ...layout, widthMm: 210, heightMm: 297 }, new AbortController().signal, 96);
    expect([canvas.width, canvas.height]).toEqual([794, 1123]);
  });

  it("rejects invalid sizes before decoding or creating a canvas", async () => {
    const browser = browserHarness();
    for (const changed of [{ widthMm: 0 }, { heightMm: 298 }, { svg: "not SVG" }, { svg: "<svg" + "x".repeat(5 * 1024 * 1024) }]) {
      await expect(rasterizePlanExport({ ...layout, ...changed }, new AbortController().signal)).rejects.toThrow();
    }
    for (const dpi of [NaN, Infinity, 0, -1, 601, 600]) {
      await expect(rasterizePlanExport(layout, new AbortController().signal, dpi)).rejects.toThrow();
    }
    expect(browser.createUrl).not.toHaveBeenCalled();
    expect(browser.images).toHaveLength(0);
  });

  it("honors early cancellation without creating browser resources", async () => {
    const browser = browserHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(createPlanExportBlob(layout, "png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("cancels decoding, ignores late image events, and revokes the local URL", async () => {
    const browser = browserHarness(false);
    const controller = new AbortController();
    const operation = rasterizePlanExport(layout, controller.signal);
    const lateLoad = browser.images[0].onload;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    lateLoad?.();
    expect(browser.context.drawImage).not.toHaveBeenCalled();
    expect(browser.revokeUrl).toHaveBeenCalledOnce();
    expect(browser.images[0].onload).toBeNull();
    expect(browser.images[0].onerror).toBeNull();
  });

  it("fails safely when SVG decoding or canvas allocation fails", async () => {
    const browser = browserHarness(false);
    const operation = rasterizePlanExport(layout, new AbortController().signal);
    browser.images[0].onerror?.();
    await expect(operation).rejects.toThrow("отрисовать");
    expect(browser.revokeUrl).toHaveBeenCalledOnce();
    browser.canvas.getContext.mockReturnValueOnce(null as unknown as typeof browser.context);
    const second = rasterizePlanExport(layout, new AbortController().signal);
    browser.images[1].onload?.();
    await expect(second).rejects.toThrow("не поддерживает");
    expect([browser.canvas.width, browser.canvas.height]).toEqual([0, 0]);
  });

  it("times out stalled image decoding and removes listeners", async () => {
    vi.useFakeTimers();
    const browser = browserHarness(false);
    const operation = rasterizePlanExport(layout, new AbortController().signal);
    const expected = expect(operation).rejects.toThrow("слишком долго");
    await vi.advanceTimersByTimeAsync(30_000);
    await expected;
    expect(browser.revokeUrl).toHaveBeenCalledOnce();
    expect(browser.images[0].onload).toBeNull();
  });

  it("creates a real PNG with 300 dpi metadata and frees the canvas", async () => {
    const browser = browserHarness();
    const blob = await createPlanExportBlob(layout, "png", new AbortController().signal);
    expect(blob.type).toBe("image/png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(37, 41))).toBe("pHYs");
    expect(view.getUint32(41)).toBe(11811);
    expect(view.getUint32(45)).toBe(11811);
    expect(bytes[49]).toBe(1);
    expect(browser.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png", undefined);
    expect([browser.canvas.width, browser.canvas.height]).toEqual([0, 0]);
  });

  it("cancels a pending canvas encoder and ignores its late callback", async () => {
    const browser = browserHarness();
    let complete: BlobCallback | undefined;
    browser.canvas.toBlob.mockImplementation((callback) => { complete = callback; });
    const controller = new AbortController();
    const operation = createPlanExportBlob(layout, "png", controller.signal);
    await vi.waitFor(() => expect(complete).toBeDefined());
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    complete?.(new Blob([png], { type: "image/png" }));
    expect([browser.canvas.width, browser.canvas.height]).toEqual([0, 0]);
  });

  it("cleans the canvas after an empty encoding result or drawing exception", async () => {
    const browser = browserHarness();
    browser.canvas.toBlob.mockImplementation((callback) => callback(null));
    await expect(createPlanExportBlob(layout, "png", new AbortController().signal)).rejects.toThrow("создать файл");
    expect([browser.canvas.width, browser.canvas.height]).toEqual([0, 0]);
    browser.context.drawImage.mockImplementationOnce(() => { throw new Error("canvas failed"); });
    await expect(createPlanExportBlob(layout, "png", new AbortController().signal)).rejects.toThrow("canvas failed");
    expect([browser.canvas.width, browser.canvas.height]).toEqual([0, 0]);
  });
});

describe("PNG print resolution", () => {
  it("replaces old pHYs without duplicate chunks or changed image bytes", () => {
    const first = setPngPrintResolution(png, 96);
    const second = setPngPrintResolution(first, 300);
    expect(second.length).toBe(first.length);
    const text = new TextDecoder("latin1").decode(second);
    expect(text.match(/pHYs/g)).toHaveLength(1);
    const imageStart = text.indexOf("IDAT");
    const originalStart = new TextDecoder("latin1").decode(png).indexOf("IDAT");
    expect(second.subarray(imageStart)).toEqual(png.subarray(originalStart));
  });

  it("rejects truncated, disguised, or unbounded input", () => {
    for (const data of [new Uint8Array(), new TextEncoder().encode("PNG"), png.subarray(0, -1), png.subarray(0, 25)]) {
      expect(() => setPngPrintResolution(data, 300)).toThrow();
    }
    for (const dpi of [0, -1, NaN, Infinity, 601]) expect(() => setPngPrintResolution(png, dpi)).toThrow();
  });
});

describe("download filenames", () => {
  it("keeps Russian names while removing paths, controls, hidden direction, and duplicate extensions", () => {
    expect(makePlanExportFilename('  Квартира / Центр: 42?  ', "pdf")).toBe("Квартира Центр 42.pdf");
    expect(makePlanExportFilename("План.pdf", "png")).toBe("План.png");
    expect(makePlanExportFilename("a\u0000b\u202ec", "pdf")).toBe("a bc.pdf");
    expect(makePlanExportFilename(". .", "png")).toBe("SpacePlan-AI.png");
    expect(makePlanExportFilename("CON", "pdf")).toBe("SpacePlan-CON.pdf");
    expect(makePlanExportFilename("x".repeat(200), "png")).toHaveLength(104);
  });
});
