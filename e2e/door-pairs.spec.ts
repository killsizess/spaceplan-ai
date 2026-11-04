import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

interface PairMarker {
  id: string;
  doorIds: [string, string];
  point: { x: number; y: number };
}

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.08, height = 2.7): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, height,
});

/** Both final leaves are vertical and separate; only their intermediate sweeps interfere. */
function pairPlan(): FloorPlan {
  return {
    ...createEmptyPlan("door-pair-fixture"), name: "Проверка взаимного открывания дверей",
    walls: [wall("host-first", -1, 0, 2, 0, 0.12), wall("host-second", -0.9, -0.9, 2.1, -0.9, 0.12)],
    // The window tests numbering; IDs deliberately sort opposite to display order.
    openings: [
      { id: "window", wallId: "host-first", kind: "window", offset: 2.2, width: 0.4, height: 1.2, sillHeight: 0.8 },
      { id: "z-first", wallId: "host-first", kind: "door", offset: 1, width: 1, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } },
      { id: "a-second", wallId: "host-second", kind: "door", offset: 1, width: 0.4, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } },
    ],
  };
}

const region = (page: Page) => page.getByRole("region", { name: "Открывание дверей", exact: true });
const pairGroup = (page: Page) => page.getByTestId("door-pair-diagnostics");
const locate = (page: Page, first = 1, second = 2) => region(page).getByRole("button", {
  name: `Показать пересечение дверей ${first} и ${second}`, exact: true,
});
const count = (page: Page) => page.getByTestId("door-pair-collision-count");
const undo = (page: Page) => page.getByRole("button", { name: "Отменить", exact: true });
const redo = (page: Page) => page.getByRole("button", { name: "Повторить", exact: true });

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

async function importPlan(page: Page, fixture = pairPlan()): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "door-pairs.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(region(page)).toBeVisible();
  await expect(undo(page)).toBeDisabled();
  return saved(page);
}

async function settleFrames(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function markers(page: Page): Promise<PairMarker[]> {
  return JSON.parse((await page.getByTestId("plan-canvas").getAttribute("data-door-pair-collisions")) ?? "null");
}

async function wallMarkers(page: Page): Promise<{ point: { x: number; y: number } }[]> {
  return JSON.parse((await page.getByTestId("plan-canvas").getAttribute("data-door-collisions")) ?? "null");
}

async function camera(page: Page) {
  return page.getByTestId("plan-canvas").evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")), y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
    width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
  }));
}

async function worldPoint(page: Page, point: { x: number; y: number }) {
  const canvas = page.getByTestId("plan-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const view = await camera(page);
  return { x: box.x + view.x + point.x * view.scale, y: box.y + view.y + point.y * view.scale };
}

/** Read composited browser pixels so a DOM-only marker flag cannot satisfy visibility. */
async function pixelPatch(page: Page, point: { x: number; y: number }): Promise<number[]> {
  await settleFrames(page);
  const screen = await worldPoint(page, point);
  const bytes = await page.screenshot({
    clip: { x: Math.floor(screen.x) - 13, y: Math.floor(screen.y) - 13, width: 27, height: 27 },
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
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
  }, bytes.toString("base64"));
}

async function selectFirstDoor(page: Page) {
  // Opening 1.1 is the window, so the first actual door is 1.2.
  await page.getByRole("button", { name: "Выбрать дверь 1.2", exact: true }).click();
  await expect(page.getByLabel("Петли двери", { exact: true })).toBeVisible();
}

test("overlapping sweeps warn although the final leaves are separate, and hinge or side fixes remain undoable", async ({ page }) => {
  const original = await importPlan(page);
  await expect(count(page)).toHaveText("1");
  await expect(locate(page)).toBeVisible();
  const [marker] = await markers(page);
  expect(marker.doorIds).toEqual(["a-second", "z-first"]);
  // Open leaves lie on x=0 and x=.1; their nominal zero-thickness segments never meet.
  expect(original.walls[0].start.x + original.openings[1].offset).toBe(0);
  expect(original.walls[1].start.x + original.openings[2].offset).toBeCloseTo(0.1, 8);
  expect(marker.point.x).toBeGreaterThan(0.1);
  expect(marker.point.y).toBeLessThan(-0.9);
  expect(Math.hypot(marker.point.x, marker.point.y)).toBeLessThan(1);
  const raw = await rawRecord(page);
  await selectFirstDoor(page);
  await page.getByLabel("Петли двери", { exact: true }).selectOption("end");
  await expect(count(page)).toHaveText("1");
  expect(await rawRecord(page)).toBe(raw);
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  const hingeFixed = await saved(page);
  await expect(count(page)).toHaveText("0");
  expect(hingeFixed.walls).toEqual(original.walls);
  expect(hingeFixed.openings[1]).toEqual({ ...original.openings[1], door: { hinge: "end", side: "left" } });
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(count(page)).toHaveText("1");
  await redo(page).click();
  expect(await saved(page)).toEqual(hingeFixed);
  await expect(count(page)).toHaveText("0");
  await undo(page).click();
  await selectFirstDoor(page);
  await page.getByLabel("Сторона открывания", { exact: true }).selectOption("right");
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  await expect(count(page)).toHaveText("0");
  await saved(page);
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(count(page)).toHaveText("1");
});

test("adjacent doors on one wall only touch at their closed boundary and do not generate a pair", async ({ page }) => {
  const fixture: FloorPlan = {
    ...createEmptyPlan("adjacent-doors"), name: "Соседние двери на одной стене",
    walls: [wall("shared-wall", -1, 0, 4, 0)],
    openings: [
      { id: "first", wallId: "shared-wall", kind: "door", offset: 1, width: 1, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } },
      { id: "second", wallId: "shared-wall", kind: "door", offset: 2, width: 1, height: 2.1, sillHeight: 0, door: { hinge: "end", side: "left" } },
    ],
  };
  const original = await importPlan(page, fixture);
  await expect(count(page)).toHaveText("0");
  expect(await markers(page)).toEqual([]);
  expect(await saved(page)).toEqual(original);
  await page.getByRole("button", { name: "Выбрать дверь 1.2", exact: true }).click();
  await page.getByLabel("Сторона открывания", { exact: true }).selectOption("right");
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  await saved(page);
  await expect(count(page)).toHaveText("0");
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
});

test("vertical gaps and touching heights suppress pairs, while windows never become a door in the count", async ({ page }) => {
  test.setTimeout(45000);
  for (const sillHeight of [2.1, 2.2]) {
    const fixture = pairPlan();
    fixture.name = `Двери на разных высотах ${sillHeight}`;
    fixture.openings[2] = { ...fixture.openings[2], sillHeight, height: 0.3 };
    const original = await importPlan(page, fixture);
    await expect(count(page)).toHaveText("0");
    expect(await markers(page)).toEqual([]);
    expect(await saved(page)).toEqual(original);
  }
  const overlap = pairPlan();
  overlap.name = "Высоты полотен пересекаются";
  overlap.openings[2] = { ...overlap.openings[2], sillHeight: 2, height: 0.4 };
  await importPlan(page, overlap);
  await expect(count(page)).toHaveText("1");
  await expect(locate(page)).toBeVisible();
  const window = pairPlan();
  window.name = "Второй проём является окном";
  window.openings[2] = { id: "a-second", wallId: "host-second", kind: "window", offset: 1, width: 0.4, height: 1.2, sillHeight: 0.8 };
  const original = await importPlan(page, window);
  await expect(count(page)).toHaveText("0");
  expect(await markers(page)).toEqual([]);
  expect(await saved(page)).toEqual(original);
});

test("locate from 3D selects the first displayed door, preserves manual 2D scale and does not change storage or history", async ({ page }) => {
  const original = await importPlan(page);
  const [marker] = await markers(page);
  for (let step = 0; step < 3; step++) {
    const scale = (await camera(page)).scale;
    await page.getByRole("button", { name: "Увеличить масштаб", exact: true }).click();
    await expect.poll(async () => (await camera(page)).scale).toBeGreaterThan(scale);
  }
  const manualScale = (await camera(page)).scale;
  const raw = await rawRecord(page);
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  const initial = await viewer.getAttribute("data-camera-position");
  await viewer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(viewer).not.toHaveAttribute("data-camera-position", initial!);
  const rotated = await viewer.getAttribute("data-camera-position");
  await locate(page).scrollIntoViewIfNeeded();
  await expect(viewer).toHaveAttribute("data-camera-position", rotated!);
  expect(await rawRecord(page)).toBe(raw);
  await locate(page).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByLabel("Стена проёма", { exact: true })).toHaveValue("host-first");
  await expect(page.getByLabel("Ширина проёма", { exact: true })).toHaveValue("1");
  await settleFrames(page);
  const focused = await camera(page);
  expect(focused.scale).toBeCloseTo(manualScale, 8);
  expect(focused.x + marker.point.x * focused.scale).toBeCloseTo(focused.width / 2, 6);
  expect(focused.y + marker.point.y * focused.scale).toBeCloseTo(focused.height / 2, 6);
  await settleFrames(page);
  expect(await camera(page)).toEqual(focused);
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeDisabled();
  await region(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../SpacePlan-AI-door-pairs.png", fullPage: true, animations: "disabled" });
});

test("one view setting toggles actual pair and wall marker pixels without changing either count or the plan", async ({ page }) => {
  const original = await importPlan(page);
  const [pair] = await markers(page);
  const walls = await wallMarkers(page);
  expect(walls.length).toBeGreaterThan(0);
  const wallCount = await page.getByTestId("door-collision-count").innerText();
  const raw = await rawRecord(page);
  const visiblePair = await pixelPatch(page, pair.point);
  const visibleWall = await pixelPatch(page, walls[0].point);
  const beforeCamera = await camera(page);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Столкновения дверей", exact: true });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect.poll(() => markers(page)).toEqual([]);
  expect(await wallMarkers(page)).toEqual([]);
  await expect(count(page)).toHaveText("1");
  await expect(page.getByTestId("door-collision-count")).toHaveText(wallCount);
  expect(await pixelPatch(page, pair.point)).not.toEqual(visiblePair);
  expect(await pixelPatch(page, walls[0].point)).not.toEqual(visibleWall);
  expect(await camera(page)).toEqual(beforeCamera);
  await checkbox.check();
  await expect.poll(() => markers(page)).toEqual([pair]);
  expect(await pixelPatch(page, pair.point)).toEqual(visiblePair);
  expect(await pixelPatch(page, walls[0].point)).toEqual(visibleWall);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
});

test("reload and JSON keep schema 6 geometry byte-identical and recompute the pair without storing diagnostics", async ({ page }) => {
  const original = await importPlan(page);
  const raw = await rawRecord(page);
  const initial = await markers(page);
  await page.reload();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(count(page)).toHaveText("1");
  expect(await markers(page)).toEqual(initial);
  expect(await rawRecord(page)).toBe(raw);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await event;
  expect(await download.failure()).toBeNull();
  const bytes = await readFile((await download.path())!);
  const exported = JSON.parse(bytes.toString("utf8")) as FloorPlan;
  expect(exported).toEqual(original);
  expect(exported.schemaVersion).toBe(7);
  expect(Object.keys(exported).filter((key) => /collision|diagnostic|pair/i.test(key))).toEqual([]);
  expect(await rawRecord(page)).toBe(raw);
  await page.getByLabel("Файл проекта JSON").setInputFiles({ name: "door-pair-copy.json", mimeType: "application/json", buffer: bytes });
  await expect.poll(async () => (await saved(page)).id).not.toBe(original.id);
  await expect(count(page)).toHaveText("1");
  expect((await saved(page)).openings).toEqual(original.openings);
  expect((await saved(page)).walls).toEqual(original.walls);
  expect(await page.evaluate((key) => localStorage.getItem(key), "spaceplan-ai:project:" + original.id)).toBe(raw);
  await expect(undo(page)).toBeDisabled();
});

test("390px layout exposes the pair, locate and direction correction with no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page);
  await expect(count(page)).toHaveText("1");
  await locate(page).scrollIntoViewIfNeeded();
  const bounds = (await locate(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const raw = await rawRecord(page);
  await locate(page).click();
  await expect(page.getByLabel("Стена проёма", { exact: true })).toHaveValue("host-first");
  expect(await rawRecord(page)).toBe(raw);
  await page.screenshot({ path: "../../work/SpacePlan-AI-door-pairs-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByLabel("Сторона открывания", { exact: true }).selectOption("right");
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  await saved(page);
  await expect(count(page)).toHaveText("0");
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(count(page)).toHaveText("1");
});

test("potential pairs have their own 100 result cap and independent six-row pagination", async ({ page }) => {
  test.setTimeout(45000);
  const fixture: FloorPlan = {
    ...createEmptyPlan("many-door-pairs"), name: "Большой список пересечений дверей",
    walls: Array.from({ length: 16 }, (_, index) => wall(`wall-${index}`, -1 + index * 0.0001, 0, 2 + index * 0.0001, 0, 0.02)),
    openings: Array.from({ length: 16 }, (_, index) => ({
      id: `door-${index}`, wallId: `wall-${index}`, kind: "door" as const, offset: 1, width: 1,
      height: 2.1, sillHeight: 0, door: { hinge: "start" as const, side: "left" as const },
    })),
  };
  const original = await importPlan(page, fixture);
  await expect(count(page)).toHaveText("100");
  const rows = pairGroup(page).getByRole("button", { name: /^Показать пересечение дверей/ });
  await expect(rows).toHaveCount(6);
  await expect(pairGroup(page)).toContainText(/первые 100|огранич.{0,25}100|100.{0,25}огранич/i);
  expect(await markers(page)).toHaveLength(100);
  const raw = await rawRecord(page);
  await pairGroup(page).getByRole("button", { name: /^Показать ещё/ }).click();
  await expect(rows).toHaveCount(12);
  await expect(count(page)).toHaveText("100");
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
});
