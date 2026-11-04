import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { DoorSwing, FloorPlan, Wall } from "../src/domain/floor-plan/types";

const ACTIVE = "spaceplan-ai:active-project:v1";
const PREFIX = "spaceplan-ai:project:";
const apply = (page: Page) => page.getByRole("button", { name: "Применить свойства", exact: true });
const exportDialog = (page: Page) => page.getByRole("dialog", { name: "Экспорт плана", exact: true });

function fixture(door?: DoorSwing, wall?: Wall): FloorPlan {
  return {
    ...createEmptyPlan("door-swing-fixture"), name: "Дверь с направлением открывания", roomMode: "walls",
    walls: [wall ?? {
      id: "door-wall", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2, height: 2.7,
    }],
    openings: [{
      id: "swing-door", wallId: "door-wall", kind: "door", offset: 1, width: 1, height: 2.1,
      sillHeight: 0, ...(door ? { door } : {}),
    }],
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function rawRecord(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(() => localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!);
}

async function importPlan(page: Page, plan = fixture()): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "door-swing.spaceplan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  return saved(page);
}

async function selectDoor(page: Page) {
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать дверь 1.1", exact: true }).click();
  await expect(page.getByLabel("Петли двери", { exact: true })).toBeVisible();
}

async function draftSwing(page: Page, door: DoorSwing) {
  await page.getByLabel("Петли двери", { exact: true }).selectOption(door.hinge);
  await page.getByLabel("Сторона открывания", { exact: true }).selectOption(door.side);
  await expect(page.getByTestId("door-swing-preview")).toHaveAttribute("data-hinge", door.hinge);
  await expect(page.getByTestId("door-swing-preview")).toHaveAttribute("data-side", door.side);
}

async function worldPoint(page: Page, x: number, y: number) {
  const canvas = page.getByTestId("plan-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const transform = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")), y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  return { x: box.x + transform.x + x * transform.scale, y: box.y + transform.y + y * transform.scale };
}

/** Screenshots include the composited WebGL frame, unlike its cleared drawing buffer. */
async function screenshotInk(page: Page, point: { x: number; y: number }, size = 5): Promise<number> {
  const png = await page.screenshot({
    clip: { x: Math.floor(point.x) - Math.floor(size / 2), y: Math.floor(point.y) - Math.floor(size / 2), width: size, height: size },
    animations: "disabled",
  });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      if (bytes[index] < 175 && bytes[index + 1] < 175 && bytes[index + 2] < 175) count++;
    }
    return count;
  }, png.toString("base64"));
}

async function openExport(page: Page) {
  await page.getByRole("button", { name: "Экспорт плана", exact: true }).click();
  await expect(page.getByTestId("plan-export-preview")).toBeVisible();
  await expect(exportDialog(page).getByRole("button", { name: "Скачать PNG", exact: true })).toBeEnabled();
}

async function download(page: Page, format: "PNG" | "JSON", path?: string): Promise<Buffer> {
  const event = page.waitForEvent("download");
  await (format === "JSON"
    ? page.getByRole("button", { name: "Экспорт JSON", exact: true })
    : exportDialog(page).getByRole("button", { name: "Скачать PNG", exact: true })).click();
  const result = await event;
  expect(await result.failure()).toBeNull();
  if (path) await result.saveAs(path);
  const downloaded = await result.path();
  if (!downloaded) throw new Error("Missing actual downloaded file");
  return readFile(downloaded);
}

/** Project independent expected door-local points through the actual sheet transform. */
async function exportPoints(page: Page, points: Array<{ x: number; y: number }>) {
  return page.getByTestId("plan-export-preview").evaluate(async (node, points) => {
    const image = node.querySelector<HTMLImageElement>("img");
    let source = node.querySelector("svg")?.outerHTML;
    if (!source && image) source = await fetch(image.src).then((response) => response.text());
    if (!source) throw new Error("Missing actual exported SVG preview");
    const svg = new DOMParser().parseFromString(source, "image/svg+xml");
    const group = svg.querySelector<SVGGElement>('[data-opening="door"]');
    if (!group) throw new Error("Missing real exported door group");
    const matrix = group.transform.baseVal.consolidate()?.matrix;
    if (!matrix) throw new Error("Missing exported door transform");
    const scale = Number(svg.querySelector('[data-plan="true"]')?.getAttribute("data-mm-per-meter"));
    return points.map(({ x, y }) => {
      const point = new DOMPoint(x * scale, y * scale).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
  }, points);
}

async function pngInk(page: Page, bytes: Buffer, points: Array<{ x: number; y: number }>) {
  return page.evaluate(async ({ base64, points }) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return points.map((point) => {
      const x = Math.round(point.x / 297 * canvas.width), y = Math.round(point.y / 210 * canvas.height);
      const pixels = context.getImageData(x - 3, y - 3, 7, 7).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 0 && pixels[index] < 185 && pixels[index + 1] < 185 && pixels[index + 2] < 185) count++;
      }
      return count;
    });
  }, { base64: bytes.toString("base64"), points });
}

async function projectedPoint(page: Page, x: number, y: number, z: number) {
  const viewer = page.getByTestId("plan-three");
  await viewer.scrollIntoViewIfNeeded();
  const box = (await viewer.boundingBox())!;
  const position = (await viewer.getAttribute("data-camera-position"))!.split(",").map(Number);
  const target = (await viewer.getAttribute("data-camera-target"))!.split(",").map(Number);
  const camera = new PerspectiveCamera(42, box.width / box.height, 0.01, 1000);
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateMatrixWorld();
  const point = new Vector3(x, y, z).project(camera);
  return { x: box.x + (point.x + 1) * box.width / 2, y: box.y + (1 - point.y) * box.height / 2 };
}

test("all four applied orientations move the actual 2D leaf and PNG quarter arc without changing dimensions", async ({ page }) => {
  test.setTimeout(60000);
  const original = await importPlan(page, fixture({ hinge: "end", side: "right" }));
  await selectDoor(page);
  for (const door of [
    { hinge: "start", side: "left" }, { hinge: "end", side: "left" },
    { hinge: "start", side: "right" }, { hinge: "end", side: "right" },
  ] satisfies DoorSwing[]) {
    const beforeDraft = await rawRecord(page);
    await draftSwing(page, door);
    expect(await rawRecord(page)).toBe(beforeDraft);
    await apply(page).click();
    const plan = await saved(page);
    expect(plan.openings[0]).toEqual({ ...original.openings[0], door });
    expect(plan.walls).toEqual(original.walls);
    const hinge = door.hinge === "start" ? 0 : 1, direction = door.hinge === "start" ? 1 : -1;
    const side = door.side === "left" ? -1 : 1;
    expect(await screenshotInk(page, await worldPoint(page, 1 + hinge, side * 0.65))).toBeGreaterThan(0);
    expect(await screenshotInk(page, await worldPoint(page, 1 + hinge, -side * 0.65))).toBe(0);
    const record = await rawRecord(page);
    await openExport(page);
    const arcPoints = [Math.PI / 6, Math.PI / 4, Math.PI / 3].map((angle) => ({
      x: hinge + direction * Math.cos(angle), y: side * Math.sin(angle),
    }));
    const points = await exportPoints(page, [
      { x: hinge, y: side * 0.65 },
      { x: hinge, y: -side * 0.65 },
      ...arcPoints,
      ...arcPoints.map((point) => ({ x: point.x, y: -point.y })),
    ]);
    const pixels = await pngInk(page, await download(page, "PNG", "../../work/SpacePlan-AI-door-export.png"), points);
    expect(pixels[0], JSON.stringify({ door, pixels })).toBeGreaterThan(0);
    expect(pixels[1], JSON.stringify({ door, pixels })).toBe(0);
    // Several independent points make the assertion insensitive to a dash gap.
    expect(pixels.slice(2, 5).reduce((sum, count) => sum + count, 0), JSON.stringify({ door, pixels })).toBeGreaterThan(0);
    expect(pixels.slice(5), JSON.stringify({ door, pixels })).toEqual([0, 0, 0]);
    await exportDialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
    expect(await rawRecord(page)).toBe(record);
  }
  await page.screenshot({ path: "../SpacePlan-AI-door-swing.png", fullPage: true, animations: "disabled" });
});

test("real 3D leaf raycasts, changes sides, keeps its camera and survives undo, redo and reload", async ({ page }) => {
  const original = await importPlan(page, fixture({ hinge: "start", side: "left" }));
  await selectDoor(page);
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-door-leaf-count", "1");
  const initialCamera = await viewer.getAttribute("data-camera-position");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await expect(viewer).not.toHaveAttribute("data-camera-position", initialCamera!);
  const camera = await viewer.getAttribute("data-camera-position");
  const target = await viewer.getAttribute("data-camera-target");
  const left = await projectedPoint(page, 1, 2.055, -0.6);
  expect(await screenshotInk(page, left)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  await page.mouse.click(left.x, left.y);
  await expect(page.getByLabel("Петли двери", { exact: true })).toBeVisible();
  await draftSwing(page, { hinge: "end", side: "right" });
  await apply(page).click();
  expect((await saved(page)).openings[0].door).toEqual({ hinge: "end", side: "right" });
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  await expect(viewer).toHaveAttribute("data-camera-target", target!);
  expect(await screenshotInk(page, await projectedPoint(page, 2, 2.055, 0.6))).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await saved(page)).toEqual(original);
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  const changed = await saved(page);
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  await page.getByRole("button", { name: "Вписать 3D-план", exact: true }).click();
  await page.screenshot({ path: "../SpacePlan-AI-door-3D.png", fullPage: true, animations: "disabled" });
  await page.reload();
  expect(await saved(page)).toEqual(changed);
  await selectDoor(page);
  await expect(page.getByLabel("Петли двери", { exact: true })).toHaveValue("end");
  await expect(page.getByLabel("Сторона открывания", { exact: true })).toHaveValue("right");
});

test("invalid opening dimensions reject the orientation and geometry together without a history entry", async ({ page }) => {
  const original = await importPlan(page);
  await selectDoor(page);
  const before = await rawRecord(page);
  await draftSwing(page, { hinge: "end", side: "right" });
  await page.getByLabel("Ширина проёма", { exact: true }).fill("6");
  expect(await rawRecord(page)).toBe(before);
  await apply(page).click();
  await expect(page.locator(".construction-error")).toHaveText("Проём выходит за границы стены.");
  expect(await rawRecord(page)).toBe(before);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await page.getByLabel("Ширина проёма", { exact: true }).fill("1.2");
  await apply(page).click();
  expect((await saved(page)).openings[0]).toMatchObject({ width: 1.2, door: { hinge: "end", side: "right" } });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await saved(page)).toEqual(original);
});

test("schema 4 remains byte-identical through viewing and JSON export before a successful schema 6 edit", async ({ page }) => {
  const current = fixture();
  // A real v4 record has no requirements; they arrived in v6.
  const legacy = { ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "requirements")), schemaVersion: 4 };
  const raw = JSON.stringify({ storageVersion: 1, revision: "door-v4-revision", updatedAt: "2026-10-24T10:00:00.000Z", plan: legacy });
  await page.addInitScript(({ id, raw, active, prefix }) => {
    if (localStorage.getItem("door-v4-installed")) return;
    localStorage.setItem("door-v4-installed", "yes");
    localStorage.setItem(prefix + id, raw); localStorage.setItem(active, id);
  }, { id: current.id, raw, active: ACTIVE, prefix: PREFIX });
  await page.goto("/");
  await selectDoor(page);
  await expect(page.getByLabel("Петли двери", { exact: true })).toHaveValue("start");
  await expect(page.getByLabel("Сторона открывания", { exact: true })).toHaveValue("left");
  expect(await rawRecord(page)).toBe(raw);
  const exported = JSON.parse((await download(page, "JSON")).toString("utf8")) as FloorPlan;
  expect(exported.schemaVersion).toBe(7);
  expect(exported.openings[0].door).toBeUndefined();
  expect(await rawRecord(page)).toBe(raw);
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-door-leaf-count", "1");
  expect(await rawRecord(page)).toBe(raw);
  await page.reload();
  expect(await rawRecord(page)).toBe(raw);
  await selectDoor(page);
  await draftSwing(page, { hinge: "end", side: "right" });
  await apply(page).click();
  const upgraded = await saved(page);
  expect(upgraded.schemaVersion).toBe(7);
  expect(upgraded.openings[0].door).toEqual({ hinge: "end", side: "right" });
  expect(upgraded.walls).toEqual(current.walls);
  expect(await rawRecord(page)).not.toBe(raw);
});

test("schema 6 JSON retains the chosen swing and imports a separate project without changing the source", async ({ page }) => {
  const original = await importPlan(page, fixture({ hinge: "end", side: "left" }));
  const sourceRaw = await rawRecord(page);
  const bytes = await download(page, "JSON");
  const exported = JSON.parse(bytes.toString("utf8")) as FloorPlan;
  expect(exported.schemaVersion).toBe(7);
  expect(exported.openings[0].door).toEqual({ hinge: "end", side: "left" });
  await page.getByLabel("Файл проекта JSON").setInputFiles({ name: "door-copy.json", mimeType: "application/json", buffer: bytes });
  await expect.poll(async () => (await saved(page)).id).not.toBe(original.id);
  const copy = await saved(page);
  expect(copy.openings).toEqual(original.openings);
  expect(copy.walls).toEqual(original.walls);
  expect(await page.evaluate((key) => localStorage.getItem(key), PREFIX + original.id)).toBe(sourceRaw);
  await selectDoor(page);
  await expect(page.getByTestId("door-swing-preview")).toHaveAttribute("data-hinge", "end");
  await expect(page.getByTestId("door-swing-preview")).toHaveAttribute("data-side", "left");
});

test("converting a door to a window removes door metadata and a later door uses the default swing", async ({ page }) => {
  const original = await importPlan(page, fixture({ hinge: "end", side: "right" }));
  await selectDoor(page);
  await page.getByLabel("Тип проёма", { exact: true }).selectOption("window");
  await expect(page.getByLabel("Петли двери", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("door-swing-preview")).toHaveCount(0);
  expect(await saved(page)).toEqual(original);
  await apply(page).click();
  const windowPlan = await saved(page);
  expect(windowPlan.openings[0].kind).toBe("window");
  expect(windowPlan.openings[0].door).toBeUndefined();
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-door-leaf-count", "0");
  await page.getByLabel("Тип проёма", { exact: true }).selectOption("door");
  await expect(page.getByLabel("Петли двери", { exact: true })).toHaveValue("start");
  await expect(page.getByLabel("Сторона открывания", { exact: true })).toHaveValue("left");
  await apply(page).click();
  const doorPlan = await saved(page);
  expect(doorPlan.openings[0].kind).toBe("door");
  expect(doorPlan.openings[0].door ?? { hinge: "start", side: "left" }).toEqual({ hinge: "start", side: "left" });
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-door-leaf-count", "1");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await saved(page)).toEqual(windowPlan);
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-door-leaf-count", "0");
});

test("reversed and diagonal wall axes export their actual leaf beyond the wall bounds without clipping", async ({ page }) => {
  test.setTimeout(60000);
  for (const wall of [
    { id: "door-wall", start: { x: 5, y: 0 }, end: { x: 0, y: 0 }, thickness: 0.2, height: 2.7 },
    { id: "door-wall", start: { x: 0, y: 0 }, end: { x: 4, y: 3 }, thickness: 0.2, height: 2.7 },
  ] satisfies Wall[]) {
    const plan = fixture({ hinge: "start", side: "left" }, wall);
    plan.openings[0] = { ...plan.openings[0], offset: 0, width: 4 };
    await importPlan(page, plan);
    await selectDoor(page);
    const dx = (wall.end.x - wall.start.x) / 5, dy = (wall.end.y - wall.start.y) / 5;
    expect(await screenshotInk(page, await worldPoint(page, wall.start.x + dy * 2.5, wall.start.y - dx * 2.5))).toBeGreaterThan(0);
    await openExport(page);
    const points = await exportPoints(page, [{ x: 0, y: -2.5 }, { x: 0, y: 0.5 }, { x: 0, y: -3.99 }]);
    for (const point of [points[0], points[2]]) {
      expect(point.x).toBeGreaterThan(12); expect(point.x).toBeLessThan(285);
      expect(point.y).toBeGreaterThan(33); expect(point.y).toBeLessThan(174);
    }
    const counts = await pngInk(page, await download(page, "PNG"), points);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(0);
    expect(counts[2]).toBeGreaterThan(0);
    await exportDialog(page).getByRole("button", { name: "Закрыть экспорт плана", exact: true }).click();
  }
});

test("390px controls fit the page and apply, undo and reload the chosen swing", async ({ page }) => {
  const original = await importPlan(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await selectDoor(page);
  await draftSwing(page, { hinge: "end", side: "right" });
  expect(await saved(page)).toEqual(original);
  await apply(page).click();
  const changed = await saved(page);
  expect(changed.openings[0].door).toEqual({ hinge: "end", side: "right" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const label of ["Петли двери", "Сторона открывания"]) {
    const box = (await page.getByLabel(label, { exact: true }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId("door-swing-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../work/SpacePlan-AI-door-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await saved(page)).toEqual(original);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await saved(page);
  await page.reload();
  expect(await saved(page)).toEqual(changed);
  await selectDoor(page);
  await expect(page.getByLabel("Петли двери", { exact: true })).toHaveValue("end");
  await expect(page.getByLabel("Сторона открывания", { exact: true })).toHaveValue("right");
});
