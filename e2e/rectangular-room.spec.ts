import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { fitPlan } from "./frames";

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText(
    "Сохранено в браузере",
  );
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem(
          "spaceplan-ai:project:" +
            localStorage.getItem("spaceplan-ai:active-project:v1"),
        )!,
      ).plan as FloorPlan,
  );
}

async function newPlan(page: Page) {
  await page.goto("/");
  await saved(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Комната по точным размерам");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await expect.poll(async () => (await saved(page)).walls.length).toBe(0);
  return saved(page);
}

function expectClosedRectangle(plan: FloorPlan) {
  expect(plan.schemaVersion).toBe(10);
  expect(plan.roomMode).toBe("walls");
  expect(plan.walls).toHaveLength(4);
  expect(plan.rooms).toEqual([]);
  expect(plan.openings).toEqual([]);
  expect(new Set(plan.walls.map((wall) => wall.id)).size).toBe(4);
  const nodeUses = new Map<string, number>();
  for (const wall of plan.walls) {
    expect(wall.thickness).toBe(0.2);
    expect(wall.height).toBe(2.7);
    expect(wall.start.x === wall.end.x || wall.start.y === wall.end.y).toBe(true);
    for (const point of [wall.start, wall.end]) {
      const key = `${point.x}:${point.y}`;
      nodeUses.set(key, (nodeUses.get(key) ?? 0) + 1);
    }
  }
  expect(nodeUses.size).toBe(4);
  expect([...nodeUses.values()]).toEqual([2, 2, 2, 2]);
}

test("a room created from internal dimensions has four walls, resizes atomically and survives JSON", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const empty = await newPlan(page);
  await page.getByRole("button", { name: "Комната со стенами", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Прямоугольная комната" });
  await expect(dialog.getByLabel("Внутренняя ширина", { exact: true }))
    .toHaveValue("5");
  await expect(dialog.getByLabel("Внутренняя глубина", { exact: true }))
    .toHaveValue("4");
  await expect(dialog.getByLabel("Толщина стен", { exact: true }))
    .toHaveValue("0.2");
  await expect(dialog.getByLabel("Высота стен", { exact: true }))
    .toHaveValue("2.7");
  await dialog.getByRole("button", { name: "Создать комнату со стенами" })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  await expect(page.getByTestId("wall-room-area")).toHaveText("20 м²");
  await expect(page.getByTestId("wall-room-perimeter")).toHaveText("18 м");
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(page.getByTestId("plan-canvas"))
    .toHaveAttribute("data-wall-room-count", "1");
  const original = await saved(page);
  expectClosedRectangle(original);

  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-wall-solids", "4");
  await page.getByLabel("Внутренняя ширина", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Изменить размеры комнаты" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("24 м²");
  await expect(page.getByTestId("wall-room-area")).toHaveText("24 м²");
  await expect(page.getByTestId("wall-room-perimeter")).toHaveText("20 м");
  const enlarged = await saved(page);
  expectClosedRectangle(enlarged);
  expect(enlarged.walls.map((wall) => wall.id)).toEqual(
    original.walls.map((wall) => wall.id),
  );
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-wall-solids", "4");

  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(empty);
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(enlarged);
  await expect(page.getByTestId("total-area")).toHaveText("24 м²");

  await page.reload();
  await expect.poll(async () => saved(page)).toEqual(enlarged);
  await expect(page.getByTestId("total-area")).toHaveText("24 м²");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const bytes = await readFile((await (await downloadPromise).path())!);
  expect(JSON.parse(bytes.toString())).toEqual(enlarged);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "rectangular-room.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect.poll(async () => (await saved(page)).id).not.toBe(enlarged.id);
  const imported = await saved(page);
  expect(imported.walls).toEqual(enlarged.walls);
  expectClosedRectangle(imported);
  await expect(page.getByTestId("total-area")).toHaveText("24 м²");
  await page.getByRole("button", { name: /Помещение 1/ }).click();
  await expect(page.getByLabel("Внутренняя ширина", { exact: true }))
    .toHaveValue("6");
  await expect(page.getByLabel("Внутренняя глубина", { exact: true }))
    .toHaveValue("4");
  await fitPlan(page);
  await page.screenshot({
    path: "../SpacePlan-AI-rectangular-room.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("resizing a room keeps its doors and windows where they are on the plan", async ({ page }) => {
  const corner = { tl: { x: -0.1, y: -0.1 }, tr: { x: 5.1, y: -0.1 }, br: { x: 5.1, y: 4.1 }, bl: { x: -0.1, y: 4.1 } };
  const fixture: FloorPlan = {
    ...createEmptyPlan("resize-openings"), name: "Комната с проёмами", roomMode: "walls",
    walls: [
      { id: "top", start: corner.tl, end: corner.tr, thickness: 0.2, height: 2.7 },
      { id: "right", start: corner.tr, end: corner.br, thickness: 0.2, height: 2.7 },
      { id: "bottom", start: corner.br, end: corner.bl, thickness: 0.2, height: 2.7 },
      { id: "left", start: corner.bl, end: corner.tl, thickness: 0.2, height: 2.7 },
    ],
    openings: [
      { id: "entry", wallId: "left", kind: "door", offset: 1, width: 0.9, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } },
      { id: "window", wallId: "bottom", kind: "window", offset: 1, width: 1.2, height: 1.2, sillHeight: 0.9 },
    ],
  };
  const position = (plan: FloorPlan, id: string) => {
    const opening = plan.openings.find((item) => item.id === id)!;
    const wall = plan.walls.find((item) => item.id === opening.wallId)!;
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    return {
      x: wall.start.x + (wall.end.x - wall.start.x) * opening.offset / length,
      y: wall.start.y + (wall.end.y - wall.start.y) * opening.offset / length,
    };
  };
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "resize-openings.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  const original = await saved(page);
  const roomIds = async () =>
    (JSON.parse((await page.getByTestId("plan-canvas").getAttribute("data-internal-dimensions")) ?? "[]") as { id: string }[])
      .map((item) => item.id);
  await expect.poll(roomIds).toHaveLength(1);
  const [roomId] = await roomIds();
  const roomButton = page.getByRole("button", { name: /Помещение 1/ });
  await roomButton.click();
  await page.getByLabel("Внутренняя ширина", { exact: true }).fill("7");
  await page.getByLabel("Внутренняя глубина", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Изменить размеры комнаты" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("42 м²");
  // The same four walls bound the room: its key and the selection survive resizing.
  await expect.poll(roomIds).toEqual([roomId]);
  await expect(roomButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("wall-room-area")).toHaveText("42 м²");
  await expect(page.getByLabel("Внутренняя ширина", { exact: true })).toHaveValue("7");
  const resized = await saved(page);
  // The left wall stays put and keeps its door; the bottom wall moves down 2 m
  // with its window but the window does not slide along the wall.
  expect(position(resized, "entry").x).toBeCloseTo(position(original, "entry").x, 9);
  expect(position(resized, "entry").y).toBeCloseTo(position(original, "entry").y, 9);
  expect(position(resized, "window").x).toBeCloseTo(position(original, "window").x, 9);
  expect(position(resized, "window").y).toBeCloseTo(position(original, "window").y + 2, 9);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect.poll(roomIds).toEqual([roomId]);
});

test("invalid room dimensions keep the dialog and saved plan intact", async ({
  page,
}) => {
  const empty = await newPlan(page);
  await page.getByRole("button", { name: "Комната со стенами", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Прямоугольная комната" });
  await dialog.getByLabel("Внутренняя ширина", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "Создать комнату со стенами" })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect.poll(async () => saved(page)).toEqual(empty);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => saved(page)).toEqual(empty);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Комната со стенами", exact: true })
    .click();
  await expect(dialog.getByLabel("Внутренняя ширина", { exact: true }))
    .toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "Создать комнату со стенами" })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  await page.getByLabel("Внутренняя глубина", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Изменить размеры комнаты" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  expectClosedRectangle(await saved(page));
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../work/spaceplan-rectangular-room-mobile.png",
    fullPage: true,
  });
});
