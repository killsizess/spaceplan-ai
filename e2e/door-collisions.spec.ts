import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

interface CollisionMarker {
  id: string;
  doorId: string;
  wallId: string;
  point: { x: number; y: number };
}

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.08, height = 2.7): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, height,
});

/** The obstacle intersects an intermediate swing angle, while the 90° leaf at x=0 is clear. */
function collisionPlan(): FloorPlan {
  return {
    ...createEmptyPlan("door-collision-fixture"), name: "Проверка открывания двери",
    walls: [wall("host", -1, 0, 3, 0, 0.2), wall("obstacle", 0.1, -0.8, 0.25, -0.8)],
    openings: [{
      id: "door", wallId: "host", kind: "door", offset: 1, width: 1,
      height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" },
    }],
  };
}

const region = (page: Page) => page.getByRole("region", { name: "Открывание дверей", exact: true });
const locate = (page: Page, door = 1, obstacle = 2) => region(page).getByRole("button", {
  name: `Показать столкновение двери ${door} со стеной ${obstacle}`, exact: true,
});
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

async function importPlan(page: Page, fixture = collisionPlan()): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "door-collisions.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
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

async function markers(page: Page): Promise<CollisionMarker[]> {
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

/** Compare actual composited marker pixels instead of a DOM flag or a Konva shape count. */
async function pixelPatch(page: Page, point: { x: number; y: number }): Promise<number[]> {
  await settleFrames(page);
  const screen = await worldPoint(page, point);
  const bytes = await page.screenshot({
    clip: { x: Math.floor(screen.x) - 11, y: Math.floor(screen.y) - 11, width: 23, height: 23 },
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

async function selectDoor(page: Page) {
  await page.getByRole("button", { name: "Выбрать дверь 1.1", exact: true }).click();
  await expect(page.getByLabel("Петли двери", { exact: true })).toBeVisible();
}

async function applySwing(page: Page, hinge: "start" | "end", side: "left" | "right") {
  await selectDoor(page);
  await page.getByLabel("Петли двери", { exact: true }).selectOption(hinge);
  await page.getByLabel("Сторона открывания", { exact: true }).selectOption(side);
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  return saved(page);
}

test("the whole swing detects an obstacle clear of the 90 degree leaf and hinge or side edits fix it with history", async ({ page }) => {
  const original = await importPlan(page);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  await expect(locate(page)).toBeVisible();
  expect(original.walls[1].start.x).toBeGreaterThan(0); // The open leaf lies at x=0.
  const [marker] = await markers(page);
  expect(marker).toMatchObject({ doorId: "door", wallId: "obstacle" });
  expect(marker.point.x).toBeGreaterThan(0);
  expect(marker.point.y).toBeLessThan(0);
  const before = await rawRecord(page);
  await selectDoor(page);
  await page.getByLabel("Петли двери", { exact: true }).selectOption("end");
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  expect(await rawRecord(page)).toBe(before);
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  const hingeFixed = await saved(page);
  await expect(page.getByTestId("door-collision-count")).toHaveText("0");
  expect(hingeFixed.walls).toEqual(original.walls);
  expect(hingeFixed.openings[0]).toEqual({ ...original.openings[0], door: { hinge: "end", side: "left" } });
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  await redo(page).click();
  expect(await saved(page)).toEqual(hingeFixed);
  await expect(page.getByTestId("door-collision-count")).toHaveText("0");
  await undo(page).click();
  const sideFixed = await applySwing(page, "start", "right");
  expect(sideFixed.walls).toEqual(original.walls);
  await expect(page.getByTestId("door-collision-count")).toHaveText("0");
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
});

test("positive wall thickness intersects the sector although its axis misses, while pure tangency stays clear", async ({ page }) => {
  const thick = collisionPlan();
  thick.name = "Толщина стены внутри сектора";
  thick.walls[1] = wall("obstacle", 1.04, -0.35, 1.04, -0.05, 0.2);
  expect(thick.walls[1].start.x).toBeGreaterThan(thick.openings[0].width);
  await importPlan(page, thick);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  await expect(locate(page)).toBeVisible();
  const [marker] = await markers(page);
  expect(marker.wallId).toBe("obstacle");
  expect(marker.point.x).toBeGreaterThanOrEqual(0.94 - 1e-8);
  expect(marker.point.x).toBeLessThan(1);
  const tangent = { ...collisionPlan(), name: "Только касание сектора" };
  tangent.walls[1] = wall("obstacle", 1.1, -0.3, 1.1, 0, 0.2);
  const original = await importPlan(page, tangent);
  await expect(page.getByTestId("door-collision-count")).toHaveText("0");
  await expect(locate(page)).toHaveCount(0);
  expect(await saved(page)).toEqual(original);
});

test("real wall passages, window sills and obstacle heights determine whether the target door is blocked", async ({ page }) => {
  test.setTimeout(45000);
  const passage = collisionPlan();
  passage.name = "Проход в препятствующей стене";
  passage.walls[1] = wall("obstacle", 0.5, -2, 0.5, 1, 0.12);
  passage.openings.push({
    id: "passage", wallId: "obstacle", kind: "door", offset: 1, width: 1.1,
    height: 2.4, sillHeight: 0, door: { hinge: "start", side: "left" },
  });
  await importPlan(page, passage);
  // The second door has its own swing; this assertion isolates the first door's passage.
  await expect(locate(page)).toHaveCount(0);
  expect((await markers(page)).filter((marker) => marker.doorId === "door")).toEqual([]);
  const sill = {
    ...passage, name: "Окно с подоконником блокирует дверь",
    openings: [passage.openings[0], {
      id: "passage", wallId: "obstacle", kind: "window" as const, offset: 1, width: 1.1,
      height: 1.4, sillHeight: 0.7,
    }],
  };
  await importPlan(page, sill);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  await expect(locate(page)).toBeVisible();
  const low = collisionPlan();
  low.name = "Низкая стенка ниже полотна";
  low.openings[0] = { ...low.openings[0], sillHeight: 0.8, height: 1.6 };
  low.walls[1] = { ...low.walls[1], height: 0.4 };
  const original = await importPlan(page, low);
  await expect(page.getByTestId("door-collision-count")).toHaveText("0");
  await expect(locate(page)).toHaveCount(0);
  expect(await saved(page)).toEqual(original);
});

test("locating from 3D returns to 2D, keeps manual zoom, selects the door and never changes storage or history", async ({ page }) => {
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
  const initialCamera = await viewer.getAttribute("data-camera-position");
  await viewer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(viewer).not.toHaveAttribute("data-camera-position", initialCamera!);
  const rotatedCamera = await viewer.getAttribute("data-camera-position");
  await locate(page).scrollIntoViewIfNeeded();
  await expect(viewer).toHaveAttribute("data-camera-position", rotatedCamera!);
  expect(await rawRecord(page)).toBe(raw);
  await locate(page).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByLabel("Петли двери", { exact: true })).toHaveValue("start");
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
  await page.screenshot({ path: "../SpacePlan-AI-door-collisions.png", fullPage: true, animations: "disabled" });
});

test("passive collision markers change real canvas pixels when hidden, while the count and plan stay unchanged", async ({ page }) => {
  const original = await importPlan(page);
  const [marker] = await markers(page);
  const point = await worldPoint(page, marker.point);
  await page.mouse.click(point.x, point.y);
  const raw = await rawRecord(page);
  const visiblePixels = await pixelPatch(page, marker.point);
  const beforeCamera = await camera(page);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Столкновения дверей", exact: true });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect.poll(() => markers(page)).toEqual([]);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  const hiddenPixels = await pixelPatch(page, marker.point);
  expect(hiddenPixels).not.toEqual(visiblePixels);
  expect(await camera(page)).toEqual(beforeCamera);
  await checkbox.check();
  await expect.poll(() => markers(page)).toEqual([marker]);
  expect(await pixelPatch(page, marker.point)).toEqual(visiblePixels);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
});

test("reload and schema 6 JSON recompute diagnostics without serializing them or modifying the source", async ({ page }) => {
  const original = await importPlan(page);
  const raw = await rawRecord(page);
  const initialMarkers = await markers(page);
  await page.reload();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  expect(await markers(page)).toEqual(initialMarkers);
  expect(await rawRecord(page)).toBe(raw);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await event;
  expect(await download.failure()).toBeNull();
  const bytes = await readFile((await download.path())!);
  const exported = JSON.parse(bytes.toString("utf8")) as FloorPlan;
  expect(exported).toEqual(original);
  expect(exported.schemaVersion).toBe(9);
  expect(Object.keys(exported).filter((key) => /collision|diagnostic/i.test(key))).toEqual([]);
  expect(await rawRecord(page)).toBe(raw);
  await page.getByLabel("Файл проекта JSON").setInputFiles({ name: "door-collision-copy.json", mimeType: "application/json", buffer: bytes });
  await expect.poll(async () => (await saved(page)).id).not.toBe(original.id);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  expect((await saved(page)).openings).toEqual(original.openings);
  expect((await saved(page)).walls).toEqual(original.walls);
  expect(await page.evaluate((key) => localStorage.getItem(key), "spaceplan-ai:project:" + original.id)).toBe(raw);
  await expect(undo(page)).toBeDisabled();
});

test("390px layout keeps diagnostics, locate and orientation correction reachable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
  await locate(page).scrollIntoViewIfNeeded();
  const bounds = (await locate(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "../../work/SpacePlan-AI-door-collisions-mobile.png", fullPage: true, animations: "disabled" });
  const raw = await rawRecord(page);
  await locate(page).click();
  await expect(page.getByLabel("Сторона открывания", { exact: true })).toHaveValue("left");
  expect(await rawRecord(page)).toBe(raw);
  await page.getByLabel("Сторона открывания", { exact: true }).selectOption("right");
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  expect((await saved(page)).walls).toEqual(original.walls);
  await expect(page.getByTestId("door-collision-count")).toHaveText("0");
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(page.getByTestId("door-collision-count")).toHaveText("1");
});

test("large diagnostics are capped at 100 and reveal six more rows without saving or hiding the limit", async ({ page }) => {
  test.setTimeout(45000);
  const fixture = collisionPlan();
  fixture.name = "Большой список дверных столкновений";
  fixture.walls = [fixture.walls[0], ...Array.from({ length: 105 }, (_, index) => wall(
    `obstacle-${index}`, 0.1 + index * 0.0001, -0.8, 0.25 + index * 0.0001, -0.8, 0.02,
  ))];
  const original = await importPlan(page, fixture);
  await expect(page.getByTestId("door-collision-count")).toHaveText("100");
  const rows = region(page).getByRole("button", { name: /^Показать столкновение двери/ });
  await expect(rows).toHaveCount(6);
  await expect(region(page)).toContainText(/первые 100|огранич.{0,25}100|100.{0,25}огранич/i);
  expect(await markers(page)).toHaveLength(100);
  const raw = await rawRecord(page);
  await region(page).getByRole("button", { name: /^Показать ещё/ }).click();
  await expect(rows).toHaveCount(12);
  await expect(page.getByTestId("door-collision-count")).toHaveText("100");
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
});
