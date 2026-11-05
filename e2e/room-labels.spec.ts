import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import { spatialBounds } from "../src/domain/floor-plan/spatial";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";
import { fitPlan, settleFrames, settleCamera } from "./frames";

const RED = "#d84646";
const BLUE = "#4477dd";
const wall = (
  id: string, x1: number, y1: number, x2: number, y2: number,
): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  thickness: 0.2, height: 2.7,
});

function enclosedPlan(): FloorPlan {
  return {
    ...createEmptyPlan("room-labels"),
    name: "Названия помещений",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 5, 0),
      wall("right", 5, 0, 5, 4),
      wall("bottom", 5, 4, 0, 4),
      wall("left", 0, 4, 0, 0),
    ],
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status"))
    .toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function savedRecord(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(() => localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!);
}

async function importPlan(page: Page, fixture = enclosedPlan()): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "room-labels.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  return saved(page);
}

async function worldPoint(page: Page, x: number, y: number) {
  await settleCamera(page);
  const canvas = page.getByTestId("plan-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const transform = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")),
    y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  return {
    x: box.x + transform.x + x * transform.scale,
    y: box.y + transform.y + y * transform.scale,
  };
}

async function selectFloor(page: Page, x = 2, y = 2) {
  const point = await worldPoint(page, x, y);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByLabel("Название помещения", { exact: true }))
    .toBeVisible();
}

async function labelRoom(page: Page, name: string, color = RED, kind = "living") {
  await page.getByLabel("Название помещения", { exact: true }).fill(name);
  await page.getByLabel("Назначение помещения", { exact: true }).selectOption(kind);
  await page.getByLabel("Цвет помещения", { exact: true }).fill(color);
  await page.getByRole("button", { name: "Сохранить параметры помещения", exact: true })
    .click();
  await expect(page.getByLabel("Название помещения", { exact: true })).toHaveValue(name);
  return saved(page);
}

/** Decode a screenshot rather than reading a cleared WebGL drawing buffer. */
async function pixel(page: Page, point: { x: number; y: number }): Promise<number[]> {
  const png = await page.screenshot({
    clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 },
    animations: "disabled",
  });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = "data:image/png;base64," + data;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, png.toString("base64"));
}

async function projectedFloorPoint(page: Page, plan: FloorPlan, x: number, y: number) {
  const viewer = page.getByTestId("plan-three");
  const box = (await viewer.boundingBox())!;
  const position = (await viewer.getAttribute("data-camera-position"))!
    .split(",").map(Number);
  const bounds = spatialBounds(plan);
  const camera = new PerspectiveCamera(42, box.width / box.height, 0.01, 1000);
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  camera.updateMatrixWorld();
  const point = new Vector3(x, 0, y).project(camera);
  return {
    x: box.x + ((point.x + 1) * box.width) / 2,
    y: box.y + ((1 - point.y) * box.height) / 2,
  };
}

test("room labels apply atomically, change real 2D/3D floor colors and preserve camera through undo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page);
  await selectFloor(page);
  const beforeRecord = await savedRecord(page);
  await page.getByLabel("Название помещения", { exact: true }).fill("Гостиная у окна");
  await page.getByLabel("Назначение помещения", { exact: true }).selectOption("living");
  await page.getByLabel("Цвет помещения", { exact: true }).fill(RED);
  expect(await savedRecord(page)).toBe(beforeRecord);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await expect(page.getByTestId("wall-room-area")).toHaveText("18,24 м²");

  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await settleFrames(page);
  await expect(viewer).toHaveAttribute("data-camera-position", /,/);
  const camera = await viewer.getAttribute("data-camera-position");
  const named = await labelRoom(page, "Гостиная у окна");
  expect(named.walls).toEqual(original.walls);
  expect(named.openings).toEqual(original.openings);
  expect(named.wallRoomLabels).toHaveLength(1);
  expect(named.wallRoomLabels[0]).toMatchObject({
    name: "Гостиная у окна", kind: "living", color: RED,
  });
  await expect(page.getByRole("button", { name: /Гостиная у окна/ })).toBeVisible();
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  const floorPoint = await projectedFloorPoint(page, original, 1.17, 1.33);
  await expect.poll(async () => {
    const [r, g, b] = await pixel(page, floorPoint);
    return r > g + 20 && r > b + 20;
  }).toBe(true);
  await page.screenshot({ path: "../SpacePlan-AI-named-3D.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(named);
  await expect(viewer).toHaveAttribute("data-camera-position", camera!);
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");

  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();
  await fitPlan(page);
  const [r, g, b] = await pixel(page, await worldPoint(page, 1.17, 1.33));
  expect(r).toBeGreaterThan(g + 20);
  expect(r).toBeGreaterThan(b + 20);
  await page.getByRole("button", { name: /Гостиная у окна/ }).click();
  await page.screenshot({ path: "../SpacePlan-AI-room-labels.png", fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("blank and overlong labels leave the saved record, geometry and history untouched", async ({ page }) => {
  const original = await importPlan(page);
  await selectFloor(page);
  const record = await savedRecord(page);
  for (const invalid of ["   ", "А".repeat(61)]) {
    await page.getByLabel("Название помещения", { exact: true }).fill(invalid);
    await page.getByRole("button", { name: "Сохранить параметры помещения", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /\S/ }).first()).toBeVisible();
    expect(await savedRecord(page)).toBe(record);
    expect(await saved(page)).toEqual(original);
    await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeDisabled();
    await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  }
  const valid = await labelRoom(page, "Спальня", BLUE, "bedroom");
  expect(valid.wallRoomLabels[0].name).toBe("Спальня");
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
});

test("schema 4 labels survive reload and JSON import and color the library thumbnail", async ({ page }) => {
  await importPlan(page);
  await selectFloor(page);
  const named = await labelRoom(page, "Кухня", BLUE, "kitchen");
  expect(named.schemaVersion).toBe(10);
  await page.reload();
  await expect.poll(async () => saved(page)).toEqual(named);
  await page.getByRole("button", { name: /Кухня/ }).click();
  await expect(page.getByLabel("Назначение помещения", { exact: true })).toHaveValue("kitchen");
  await expect(page.getByLabel("Цвет помещения", { exact: true })).toHaveValue(BLUE);
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  const project = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: named.name, exact: true }),
  });
  await expect(project.locator(`.project-thumbnail path[fill="${BLUE}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Закрыть мои проекты", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const bytes = await readFile((await (await downloadPromise).path())!);
  expect(JSON.parse(bytes.toString())).toEqual(named);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "named-copy.json", mimeType: "application/json", buffer: bytes,
  });
  await expect.poll(async () => (await saved(page)).id).not.toBe(named.id);
  const copy = await saved(page);
  expect(copy.schemaVersion).toBe(10);
  expect(copy.wallRoomLabels).toEqual(named.wallRoomLabels);
  expect(copy.walls).toEqual(named.walls);
  await expect(page.getByRole("button", { name: /Кухня/ })).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
});

test("a schema 3 saved wall plan stays byte-identical until a successful metadata edit upgrades it", async ({ page }) => {
  const fixture = enclosedPlan();
  const legacy = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== "wallRoomLabels" && key !== "requirements"));
  legacy.schemaVersion = 3;
  const record = JSON.stringify({
    storageVersion: 1, revision: "legacy-labels-r1", updatedAt: "2026-10-23T00:00:00.000Z", plan: legacy,
  });
  await page.addInitScript(({ id, raw }) => {
    if (localStorage.getItem("room-labels-legacy-seeded")) return;
    localStorage.setItem("spaceplan-ai:project:" + id, raw);
    localStorage.setItem("spaceplan-ai:active-project:v1", id);
    localStorage.setItem("room-labels-legacy-seeded", "yes");
  }, { id: fixture.id, raw: record });
  await page.goto("/");
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  expect(await savedRecord(page)).toBe(record);
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-renderer-status", "ready");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  expect(await savedRecord(page)).toBe(record);
  await page.reload();
  expect(await savedRecord(page)).toBe(record);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await page.getByRole("button", { name: /Помещение 1/ }).click();
  const upgraded = await labelRoom(page, "Кабинет", BLUE, "other");
  expect(upgraded.schemaVersion).toBe(10);
  expect(upgraded.wallRoomLabels).toHaveLength(1);
  expect(upgraded.walls).toEqual(fixture.walls);
  expect(upgraded.rooms).toEqual(fixture.rooms);
  expect(upgraded.roomMode).toBe("walls");
});

test("resizing keeps the same room metadata and updates its anchor when the old point leaves the interior", async ({ page }) => {
  await importPlan(page);
  await selectFloor(page);
  const named = await labelRoom(page, "Санузел", BLUE, "bathroom");
  await page.getByLabel("Внутренняя ширина", { exact: true }).fill("1");
  await page.getByLabel("Внутренняя глубина", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Изменить размеры комнаты", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("1 м²");
  const resized = await saved(page);
  expect(resized.walls.map((item) => item.id)).toEqual(named.walls.map((item) => item.id));
  expect(resized.wallRoomLabels).toHaveLength(1);
  expect(resized.wallRoomLabels[0]).toMatchObject({
    id: named.wallRoomLabels[0].id, name: "Санузел", kind: "bathroom", color: BLUE,
  });
  expect(resized.wallRoomLabels[0].anchor).not.toEqual(named.wallRoomLabels[0].anchor);
  const room = detectWallRooms(resized.walls).rooms[0];
  expect(resized.wallRoomLabels[0].anchor.x).toBeGreaterThan(room.bounds.minX);
  expect(resized.wallRoomLabels[0].anchor.x).toBeLessThan(room.bounds.maxX);
  expect(resized.wallRoomLabels[0].anchor.y).toBeGreaterThan(room.bounds.minY);
  expect(resized.wallRoomLabels[0].anchor.y).toBeLessThan(room.bounds.maxY);
  await page.getByRole("button", { name: /Санузел/ }).click();
  await expect(page.getByLabel("Название помещения", { exact: true })).toHaveValue("Санузел");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(named);
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(resized);
});

test("an unrelated room that changes contour order and a geometry-only T split preserve the named room", async ({ page }) => {
  const fixture = enclosedPlan();
  fixture.walls.push(wall("branch", 2.5, -2, 2.5, 0));
  await importPlan(page, fixture);
  await selectFloor(page);
  const named = await labelRoom(page, "Гостиная", RED);
  await page.getByRole("button", { name: "Комната со стенами", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Прямоугольная комната" });
  await dialog.getByLabel("Внутренний угол X", { exact: true }).fill("-10");
  await dialog.getByLabel("Внутренний угол Y", { exact: true }).fill("0");
  await dialog.getByLabel("Внутренняя ширина", { exact: true }).fill("2");
  await dialog.getByLabel("Внутренняя глубина", { exact: true }).fill("3");
  await dialog.getByRole("button", { name: "Создать комнату со стенами", exact: true }).click();
  await expect(page.getByTestId("room-count")).toHaveText("02");
  await expect(page.getByTestId("total-area")).toHaveText("24,24 м²");
  await expect(page.getByRole("button", { name: /Гостиная/ })).toBeVisible();
  const added = await saved(page);
  expect(added.wallRoomLabels[0].id).toBe(named.wallRoomLabels[0].id);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Создать T-соединение стены 5: конец", exact: true }).click();
  const split = await saved(page);
  expect(split.walls).toHaveLength(added.walls.length + 1);
  expect(split.wallRoomLabels[0].id).toBe(named.wallRoomLabels[0].id);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await page.getByRole("button", { name: /Гостиная/ }).click();
  await expect(page.getByTestId("wall-room-area")).toHaveText("18,24 м²");
  await expect(page.getByLabel("Назначение помещения", { exact: true })).toHaveValue("living");
  await expect(page.getByRole("region", { name: "Непривязанные помещения", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(added);
});

test("merging two named rooms leaves explicit unassigned metadata that can be assigned or deleted with undo", async ({ page }) => {
  const fixture = enclosedPlan();
  fixture.walls.push(wall("divider", 2.5, 0, 2.5, 4));
  await importPlan(page, fixture);
  await selectFloor(page, 1, 2);
  await labelRoom(page, "Спальня", BLUE, "bedroom");
  await selectFloor(page, 4, 2);
  const separate = await labelRoom(page, "Кухня", RED, "kitchen");
  expect(separate.wallRoomLabels).toHaveLength(2);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  const merged = await saved(page);
  expect(merged.wallRoomLabels).toHaveLength(2);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  const unassigned = page.getByRole("region", { name: "Непривязанные помещения", exact: true });
  await expect(unassigned).toBeVisible();
  await expect(unassigned.getByRole("button", { name: "Привязать «Спальня» к выбранному помещению", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /Помещение 1/ }).click();
  await unassigned.getByRole("button", { name: "Привязать «Спальня» к выбранному помещению", exact: true }).click();
  const assigned = await saved(page);
  expect(assigned.walls).toEqual(merged.walls);
  await expect(page.getByLabel("Название помещения", { exact: true })).toHaveValue("Спальня");
  await expect(unassigned.getByRole("button", { name: "Привязать «Кухня» к выбранному помещению", exact: true })).toBeDisabled();
  await unassigned.getByRole("button", { name: "Удалить параметры «Кухня»", exact: true }).click();
  expect((await saved(page)).wallRoomLabels).toHaveLength(1);
  await expect(unassigned).toHaveCount(0);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(assigned);
  await expect(unassigned).toBeVisible();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(merged);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(separate);
  await expect(page.getByTestId("room-count")).toHaveText("02");
  await expect(unassigned).toHaveCount(0);
});

test("manual mode retains wall labels and mobile save/reset controls fit and remain undoable", async ({ page }) => {
  await importPlan(page);
  await selectFloor(page);
  const named = await labelRoom(page, "Прихожая", BLUE, "hall");
  await page.getByRole("button", { name: "Ручные комнаты", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  expect((await saved(page)).wallRoomLabels).toEqual(named.wallRoomLabels);
  await page.getByRole("button", { name: "Комнаты по стенам", exact: true }).click();
  await page.getByRole("button", { name: /Прихожая/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Название помещения", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByLabel("Название помещения", { exact: true }).fill("Холл");
  await page.getByRole("button", { name: "Сохранить параметры помещения", exact: true }).click();
  const renamed = await saved(page);
  expect(renamed.wallRoomLabels[0].name).toBe("Холл");
  expect(renamed.walls).toEqual(named.walls);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "../../work/spaceplan-room-labels-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Сбросить параметры помещения", exact: true }).click();
  expect((await saved(page)).wallRoomLabels).toEqual([]);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(renamed);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(page.getByRole("button", { name: /Холл/ })).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
});
