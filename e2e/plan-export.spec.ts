import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createSpatialExamplePlan } from "../src/domain/floor-plan/examples";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { setWallRoomLabel } from "../src/domain/floor-plan/wall-room-labels";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";

function namedApartment(): FloorPlan {
  let plan: FloorPlan = { ...createSpatialExamplePlan(), roomMode: "walls" };
  const rooms = detectWallRooms(plan.walls).rooms;
  const names = ["Гостиная у окна", "Кухня", "Прихожая", "Спальня", "Кабинет", "Ванная"];
  for (const [index, room] of rooms.entries()) {
    plan = setWallRoomLabel(plan, room, {
      name: names[index], kind: "other", color: index === 0 ? "#d84646" : "#dfe8df",
    }, `export-label-${index}`);
  }
  return { ...plan, name: "План квартиры · 73,42 м²" };
}

function manualPlan(size = 4): FloorPlan {
  return {
    ...createEmptyPlan("export-manual"), name: "Ручной план для экспорта",
    rooms: [{
      id: "manual-room", name: "Синяя спальня", kind: "bedroom", color: "#4477dd",
      x: -2, y: -1, width: size, height: size === 4 ? 3 : size,
    }],
  };
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Экспорт плана", exact: true });

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function storage(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort()
    .map((key) => [key, localStorage.getItem(key)])));
}

async function importPlan(page: Page, plan: FloorPlan): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "export-fixture.spaceplan.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  return saved(page);
}

async function openExport(page: Page) {
  await page.getByRole("button", { name: "Экспорт плана", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId("plan-export-preview")).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Скачать PNG", exact: true }))
    .toBeEnabled();
}

async function previewSvg(page: Page): Promise<string> {
  return page.getByTestId("plan-export-preview").evaluate(async (node) => {
    const svg = node.querySelector("svg");
    if (svg) return svg.outerHTML;
    const image = node.querySelector("img");
    if (image) return fetch(image.src).then((response) => response.text());
    throw new Error("Missing actual SVG export preview");
  });
}

async function download(page: Page, format: "PNG" | "PDF", target?: string): Promise<Buffer> {
  const event = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: `Скачать ${format}`, exact: true }).click();
  const result = await event;
  expect(result.suggestedFilename().toLowerCase()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
  expect(await result.failure()).toBeNull();
  if (target) await result.saveAs(target);
  const path = await result.path();
  if (!path) throw new Error("Missing downloaded plan");
  const bytes = await readFile(path);
  if (format === "PNG") assertPngDpi(bytes);
  return bytes;
}

function assertPngDpi(bytes: Buffer) {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "pHYs") {
      expect(length).toBe(9);
      expect(bytes.readUInt32BE(offset + 8)).toBe(11811);
      expect(bytes.readUInt32BE(offset + 12)).toBe(11811);
      expect(bytes[offset + 16]).toBe(1);
      return;
    }
    offset += 12 + length;
  }
  throw new Error("Exported PNG must contain 300 dpi physical resolution metadata");
}

async function rasterStats(page: Page, bytes: Buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing downloaded PNG decoder");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, blue = 0, ink = 0;
    // Sample the entire exported page, including its margins, not the editor canvas.
    for (let y = 0; y < canvas.height; y += 10) {
      for (let x = 0; x < canvas.width; x += 10) {
        const index = (y * canvas.width + x) * 4;
        const [r, g, b] = pixels.slice(index, index + 3);
        if (r > g + 40 && r > b + 40) red++;
        if (b > r + 40 && b > g + 30) blue++;
        if (r < 150 && g < 150 && b < 150) ink++;
      }
    }
    return { width: image.naturalWidth, height: image.naturalHeight, red, blue, ink };
  }, bytes.toString("base64"));
}

function assertPdf(bytes: Buffer, orientation: "landscape" | "portrait") {
  const source = bytes.toString("latin1");
  expect(source).toMatch(/^%PDF-1\.[4-7]/);
  expect(source.match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(source);
  expect(box).not.toBeNull();
  const [width, height] = orientation === "landscape" ? [297, 210] : [210, 297];
  expect(Number(box![1])).toBeCloseTo(width * 72 / 25.4, 2);
  expect(Number(box![2])).toBeCloseTo(height * 72 / 25.4, 2);
  expect(source).toMatch(/\/Subtype\s*\/Image/);
  expect(source).toMatch(/\/Filter\s*\/DCTDecode/);
  expect(source).toMatch(new RegExp(`/Width\\s+${orientation === "landscape" ? 3508 : 2480}\\b`));
  expect(source).toMatch(new RegExp(`/Height\\s+${orientation === "landscape" ? 2480 : 3508}\\b`));
  expect(bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]))).toBeGreaterThan(0);
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(source);
  expect(start).not.toBeNull();
  expect(source.slice(Number(start![1]), Number(start![1]) + 4)).toBe("xref");
}

test("walls export downloads a real A4 PNG with room labels and dimensions without editing the project", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page, namedApartment());
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  const before = await storage(page);
  const camera = await page.getByTestId("plan-canvas").evaluate((node) => [
    node.getAttribute("data-camera-x"), node.getAttribute("data-camera-y"), node.getAttribute("data-scale"),
  ]);
  await openExport(page);
  const preview = page.getByTestId("plan-export-preview");
  await expect(preview).toHaveAttribute("data-width-mm", "297");
  await expect(preview).toHaveAttribute("data-height-mm", "210");
  const svg = await previewSvg(page);
  expect(svg).toContain("Гостиная у окна");
  expect(svg).toContain("73,42");
  expect(svg).toMatch(/1:\s*\d+/);
  expect(svg).toContain("м²");
  expect(svg).toMatch(/внутри|Внутри/);
  await page.screenshot({ path: "../SpacePlan-AI-export.png", fullPage: true, animations: "disabled" });
  const bytes = await download(page, "PNG", "../SpacePlan-AI-plan.png");
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const stats = await rasterStats(page, bytes);
  expect(stats).toMatchObject({ width: 3508, height: 2480 });
  expect(stats.red).toBeGreaterThan(100);
  expect(stats.ink).toBeGreaterThan(100);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Высота стены", { exact: true })).toBeVisible();
  expect(await page.getByTestId("plan-canvas").evaluate((node) => [
    node.getAttribute("data-camera-x"), node.getAttribute("data-camera-y"), node.getAttribute("data-scale"),
  ])).toEqual(camera);
  expect(errors).toEqual([]);
});

test("portrait PDF is a one-page A4 document containing the full 300 dpi raster", async ({ page }) => {
  await importPlan(page, namedApartment());
  const before = await storage(page);
  await openExport(page);
  await dialog(page).getByLabel("Формат экспорта", { exact: true }).selectOption("pdf");
  await dialog(page).getByLabel("Ориентация листа", { exact: true }).selectOption("portrait");
  await dialog(page).getByLabel("Масштаб печати", { exact: true }).selectOption("100");
  await expect(page.getByTestId("plan-export-preview")).toHaveAttribute("data-scale", "100");
  await expect(page.getByTestId("plan-export-preview")).toHaveAttribute("data-width-mm", "210");
  await expect(page.getByTestId("plan-export-preview")).toHaveAttribute("data-height-mm", "297");
  assertPdf(await download(page, "PDF", "../../work/SpacePlan-AI-plan-portrait.pdf"), "portrait");
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await storage(page)).toBe(before);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
});

test("manual room dimensions and colors come from the active plan and can be hidden for export", async ({ page }) => {
  const original = await importPlan(page, manualPlan());
  const before = await storage(page);
  await openExport(page);
  const withDimensions = await previewSvg(page);
  expect(withDimensions).toContain("Синяя спальня");
  expect(withDimensions).toContain("12");
  expect(withDimensions).toContain("#4477dd");
  expect(withDimensions).toMatch(/внутри|Внутри/);
  await dialog(page).getByLabel("Показывать размеры", { exact: true }).uncheck();
  const withoutDimensions = await previewSvg(page);
  expect(withoutDimensions).not.toMatch(/внутри|Внутри/);
  expect(withoutDimensions).toContain("Синяя спальня");
  expect(withoutDimensions).not.toBe(withDimensions);
  const stats = await rasterStats(page, await download(page, "PNG"));
  expect(stats.blue).toBeGreaterThan(100);
  expect(stats).toMatchObject({ width: 3508, height: 2480 });
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
});

test("an oversized fixed scale blocks output and auto scale recovers without clipping or edits", async ({ page }) => {
  const original = await importPlan(page, manualPlan(100));
  const before = await storage(page);
  const downloads: string[] = [];
  page.on("download", (result) => downloads.push(result.suggestedFilename()));
  await openExport(page);
  await dialog(page).getByLabel("Масштаб печати", { exact: true }).selectOption("20");
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Скачать PNG", exact: true })).toBeDisabled();
  expect(downloads).toEqual([]);
  await dialog(page).getByLabel("Масштаб печати", { exact: true }).selectOption("auto");
  await expect(dialog(page).getByRole("button", { name: "Скачать PNG", exact: true })).toBeEnabled();
  const scale = Number(await page.getByTestId("plan-export-preview").getAttribute("data-scale"));
  expect(scale).toBeGreaterThanOrEqual(500);
  const stats = await rasterStats(page, await download(page, "PNG"));
  expect(stats.blue).toBeGreaterThan(100);
  expect(downloads).toHaveLength(1);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
});

test("an empty plan explains why a drawing cannot be exported and leaves JSON export available", async ({ page }) => {
  const plan = { ...createEmptyPlan("export-empty"), name: "Пустой план для экспорта" };
  const original = await importPlan(page, plan);
  const before = await storage(page);
  await page.getByRole("button", { name: "Экспорт плана", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Скачать PNG", exact: true })).toBeDisabled();
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  await expect(page.getByRole("button", { name: "Экспорт JSON", exact: true })).toBeEnabled();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
});

test("closing an in-flight raster export cancels the download and a later export still works", async ({ page }) => {
  await importPlan(page, manualPlan());
  const before = await storage(page);
  await openExport(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    const pending: Array<() => void> = [];
    Object.defineProperty(window, "__spaceplanReleaseExport", {
      configurable: true, value: () => {
        HTMLCanvasElement.prototype.toBlob = original;
        for (const release of pending) release();
      },
    });
    Object.defineProperty(window, "__spaceplanPendingExport", {
      configurable: true, get: () => pending.length,
    });
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      pending.push(() => original.call(this, callback, type, quality));
    };
  });
  const downloads: string[] = [];
  page.on("download", (result) => downloads.push(result.suggestedFilename()));
  await dialog(page).getByRole("button", { name: "Скачать PNG", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__spaceplanPendingExport") as number))
    .toBeGreaterThan(0);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "__spaceplanReleaseExport");
    if (typeof release !== "function") throw new Error("Missing pending raster");
    release();
  });
  await openExport(page);
  const stats = await rasterStats(page, await download(page, "PNG"));
  expect(stats.blue).toBeGreaterThan(100);
  expect(downloads).toHaveLength(1);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await storage(page)).toBe(before);
});

test("mobile modal blocks background focus and export from 3D preserves camera, selection and history", async ({ page }) => {
  const original = await importPlan(page, namedApartment());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await viewer.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  const camera = await viewer.getAttribute("data-camera-position");
  const before = await storage(page);
  await openExport(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const bounds = await dialog(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "../../work/SpacePlan-AI-export-mobile.png", fullPage: true, animations: "disabled" });
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    const focus = await dialog(page).evaluate((node) => ({
      inside: node.contains(document.activeElement),
      activeTag: document.activeElement?.tagName,
      modal: node.matches(":modal"),
      documentFocused: document.hasFocus(),
    }));
    expect(focus.modal).toBe(true);
    // Native Chromium dialogs permit Tab to browser chrome. That yields BODY
    // with an unfocused document; an editor control must never receive focus.
    if (focus.documentFocused) expect(focus.inside, JSON.stringify(focus)).toBe(true);
    else expect(focus.activeTag).toBe("BODY");
  }
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("w");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByLabel("Формат экспорта", { exact: true }).selectOption("pdf");
  assertPdf(await download(page, "PDF", "../SpacePlan-AI-plan.pdf"), "landscape");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Экспорт плана", exact: true })).toBeFocused();
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  await expect(page.getByLabel("Высота стены", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeDisabled();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
});

test("a failed image encoder reports the error without downloading and permits a clean retry", async ({ page }) => {
  const original = await importPlan(page, manualPlan());
  const before = await storage(page);
  const downloads: string[] = [];
  page.on("download", (result) => downloads.push(result.suggestedFilename()));
  await openExport(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(window, "__spaceplanRestoreEncoder", {
      configurable: true, value: () => { HTMLCanvasElement.prototype.toBlob = original; },
    });
    HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
  });
  await dialog(page).getByRole("button", { name: "Скачать PNG", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Скачать PNG", exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
  await page.evaluate(() => {
    const restore: unknown = Reflect.get(window, "__spaceplanRestoreEncoder");
    if (typeof restore !== "function") throw new Error("Missing original encoder");
    restore();
  });
  const stats = await rasterStats(page, await download(page, "PNG"));
  expect(stats.blue).toBeGreaterThan(100);
  expect(downloads).toHaveLength(1);
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
});

test("an image upload invalidates a pending export and undo never resurrects its stale dialog", async ({ page }) => {
  const original = await importPlan(page, manualPlan());
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing fixture encoder");
    context.fillStyle = "#f2ede3";
    context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.evaluate(() => {
    const arrayBuffer = File.prototype.arrayBuffer;
    let pending = false;
    let release: (() => void) | undefined;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "delayed-upload.png") return arrayBuffer.call(this);
      pending = true;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        release = () => { void arrayBuffer.call(this).then(resolve, reject); };
      });
    };
    Object.defineProperty(window, "__spaceplanUploadPending", { configurable: true, get: () => pending });
    Object.defineProperty(window, "__spaceplanReleaseUpload", {
      configurable: true, value: () => {
        File.prototype.arrayBuffer = arrayBuffer;
        if (!release) throw new Error("Missing image read operation");
        release();
      },
    });
  });
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.getByLabel("Изображение плана JPG или PNG").setInputFiles({
    name: "delayed-upload.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  });
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__spaceplanUploadPending") as boolean)).toBe(true);
  await openExport(page);
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    let release: (() => void) | undefined;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      release = () => toBlob.call(this, callback, type, quality);
    };
    Object.defineProperty(window, "__spaceplanUploadRasterPending", { configurable: true, get: () => Boolean(release) });
    Object.defineProperty(window, "__spaceplanReleaseUploadRaster", {
      configurable: true, value: () => {
        HTMLCanvasElement.prototype.toBlob = toBlob;
        if (!release) throw new Error("Missing pending raster operation");
        release();
      },
    });
  });
  const downloads: string[] = [];
  page.on("download", (result) => downloads.push(result.suggestedFilename()));
  await dialog(page).getByRole("button", { name: "Скачать PNG", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__spaceplanUploadRasterPending") as boolean)).toBe(true);
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "__spaceplanReleaseUpload");
    if (typeof release !== "function") throw new Error("Missing deferred image read");
    release();
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-underlay-loaded", "true");
  expect((await saved(page)).underlay?.name).toBe("delayed-upload.png");
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "__spaceplanReleaseUploadRaster");
    if (typeof release !== "function") throw new Error("Missing deferred raster encode");
    release();
  });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(() => saved(page)).toEqual(original);
  await expect(dialog(page)).toHaveCount(0);
  expect(downloads).toEqual([]);
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeEnabled();
  await openExport(page);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await saved(page)).toEqual(original);
});

test("an exported door gap cuts only its own wall and never erases a crossing wall", async ({ page }) => {
  const fixture: FloorPlan = {
    ...createEmptyPlan("export-crossing-opening"),
    name: "Пересечение стены с дверным проёмом", roomMode: "walls",
    walls: [
      { id: "horizontal", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7 },
      { id: "vertical", start: { x: 2.5, y: -2 }, end: { x: 2.5, y: 2 }, thickness: 0.2, height: 2.7 },
    ],
    openings: [{
      id: "door-in-horizontal", wallId: "horizontal", kind: "door", offset: 2,
      width: 1, height: 2.1, sillHeight: 0,
    }],
  };
  const original = await importPlan(page, fixture);
  const before = await storage(page);
  await openExport(page);
  const scale = Number(await page.getByTestId("plan-export-preview").getAttribute("data-scale"));
  const millimetresPerMetre = 1000 / scale;
  const points = [
    { x: 148.5, y: 103.5 },
    { x: 148.5 + (2.2 - 2.5) * millimetresPerMetre, y: 103.5 + 0.05 * millimetresPerMetre },
    { x: 148.5 + (1 - 2.5) * millimetresPerMetre, y: 103.5 + 0.05 * millimetresPerMetre },
    { x: 148.5 + (4 - 2.5) * millimetresPerMetre, y: 103.5 + 0.05 * millimetresPerMetre },
    { x: 148.5, y: 103.5 + millimetresPerMetre },
  ];
  const png = await download(page, "PNG");
  const pixels = await page.evaluate(async ({ base64, points }) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing exported wall raster");
    context.drawImage(image, 0, 0);
    return points.map((point) => Array.from(context.getImageData(
      Math.round(point.x / 297 * canvas.width),
      Math.round(point.y / 210 * canvas.height), 1, 1,
    ).data));
  }, { base64: png.toString("base64"), points });
  // The crossing and each intact wall arm retain the dark wall ink.
  for (const index of [0, 2, 3, 4]) {
    expect(pixels[index].slice(0, 3).every((channel) => channel < 60), JSON.stringify(pixels)).toBe(true);
    expect(pixels[index][3]).toBe(255);
  }
  // Sample off the dashed door axis, in the opening but outside the other wall.
  expect(pixels[1].slice(0, 3).every((channel) => channel > 250), JSON.stringify(pixels)).toBe(true);
  await dialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  expect(await storage(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
});
