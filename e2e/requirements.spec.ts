import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createSpatialExamplePlan } from "../src/domain/floor-plan/examples";
import type { FloorPlan, RoomKind } from "../src/domain/floor-plan/types";
import { setWallRoomLabel } from "../src/domain/floor-plan/wall-room-labels";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";

/** The 3D example with named rooms, so requirements can refer to room kinds. */
function apartment(): FloorPlan {
  let plan: FloorPlan = { ...createSpatialExamplePlan(), name: "Требования", roomMode: "walls" };
  const rooms: [string, RoomKind, (x: number, y: number) => boolean][] = [
    ["Гостиная", "living", (x, y) => x < 5 && y < 4], ["Кухня", "kitchen", (x, y) => x > 5 && x < 8 && y < 4],
    ["Прихожая", "hall", (x, y) => x > 8 && y < 5], ["Ванная", "bathroom", (x, y) => x > 8 && y > 5],
    ["Спальня", "bedroom", (x, y) => x < 4 && y > 4], ["Кабинет", "other", (x, y) => x > 4 && x < 8 && y > 4],
  ];
  for (const room of detectWallRooms(plan.walls).rooms) {
    const [name, kind] = rooms.find(([, , test]) => test(room.labelPoint.x, room.labelPoint.y))!;
    plan = setWallRoomLabel(plan, room, { name, kind, color: "#e8e5dd" }, `label-${kind}`);
  }
  return plan;
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function addRequirement(page: Page, fill: () => Promise<void>) {
  await fill();
  await page.getByRole("button", { name: "Добавить требование", exact: true }).click();
}

test("requirements are saved with the plan and re-checked when the walls change", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = apartment();
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "requirements.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: "Требования", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  const panel = page.locator(".requirements-panel");
  await expect(panel).toContainText("Задайте свои требования");

  await addRequirement(page, async () => {
    await panel.getByLabel("Новое требование", { exact: true }).selectOption("room-min-area");
    await panel.getByLabel("Назначение", { exact: true }).selectOption("kitchen");
    await panel.getByLabel("Площадь не меньше, м²", { exact: true }).fill("12");
  });
  const items = panel.locator(".requirement");
  await expect(items.nth(0)).toHaveAttribute("data-requirement-status", "violated");
  await expect(items.nth(0)).toContainText("Кухня: площадь не меньше 12 м²");
  await expect(items.nth(0)).toContainText("Кухня — 11,06 м²");

  await addRequirement(page, async () => {
    await panel.getByLabel("Новое требование", { exact: true }).selectOption("room-not-walkthrough");
    await panel.getByLabel("Назначение", { exact: true }).selectOption("bedroom");
  });
  await expect(items.nth(1)).toHaveAttribute("data-requirement-status", "violated");
  await expect(items.nth(1)).toContainText("Спальня — дверей: 2");

  await addRequirement(page, async () => {
    await panel.getByLabel("Новое требование", { exact: true }).selectOption("rooms-connected");
    await panel.getByLabel("Назначение", { exact: true }).selectOption("kitchen");
    await panel.getByLabel("Рядом с", { exact: true }).selectOption("hall");
  });
  await expect(items.nth(2)).toHaveAttribute("data-requirement-status", "met");
  await expect(items.nth(2)).toContainText("Кухня ↔ Прихожая");
  await expect(panel.getByTestId("requirements-summary")).toHaveText("нарушено: 2");
  expect((await saved(page)).requirements).toHaveLength(3);

  // Undo and redo the last requirement as one step each.
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(items).toHaveCount(2);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(items).toHaveCount(3);

  // Enlarge the kitchen: move the partition between it and the hall 0.3 m to the right.
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 6", exact: true }).click();
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.3");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[5].start.x).toBeCloseTo(8.3, 9);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(items.nth(0)).toHaveAttribute("data-requirement-status", "met");
  await expect(items.nth(0)).toContainText("Кухня — 12,21 м²");
  await expect(panel.getByTestId("requirements-summary")).toHaveText("нарушено: 1");

  await page.getByRole("button", { name: "Удалить требование: Спальня: не проходная", exact: true }).click();
  await expect(items).toHaveCount(2);
  await expect(panel.getByTestId("requirements-summary")).toHaveText("всё выполнено");

  await page.reload();
  await expect(page.locator(".requirements-panel .requirement")).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const exported = JSON.parse((await readFile((await (await downloadPromise).path())!)).toString()) as FloorPlan;
  expect(exported.schemaVersion).toBe(9);
  expect(exported.requirements.map((item) => item.type)).toEqual(["room-min-area", "rooms-connected"]);
  expect(errors).toEqual([]);
});

test("a pinned wall reports a move and contradictory area limits are flagged", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "pinned.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(apartment())),
  });
  await expect(page.getByRole("heading", { name: "Требования", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  const panel = page.locator(".requirements-panel");
  const items = panel.locator(".requirement");

  await addRequirement(page, async () => {
    await panel.getByLabel("Новое требование", { exact: true }).selectOption("wall-fixed");
    await panel.getByLabel("Стена", { exact: true }).selectOption({ label: "Стена 6" });
  });
  await expect(items.nth(0)).toContainText("Стена 6 не меняется");
  await expect(items.nth(0)).toHaveAttribute("data-requirement-status", "met");

  for (const [type, value] of [["room-min-area", "12"], ["room-max-area", "10"]] as const) {
    await addRequirement(page, async () => {
      await panel.getByLabel("Новое требование", { exact: true }).selectOption(type);
      await panel.getByLabel("Назначение", { exact: true }).selectOption("kitchen");
      await panel.locator("#requirement-area").fill(value);
    });
  }
  await expect(panel.getByRole("list", { name: "Противоречия между требованиями" })).toContainText(
    "Кухня: минимальная площадь больше максимальной",
  );

  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 6", exact: true }).click();
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.3");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(items.nth(0)).toHaveAttribute("data-requirement-status", "violated");
  await expect(items.nth(0)).toContainText("Стена перенесена");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(items.nth(0)).toHaveAttribute("data-requirement-status", "met");
  expect((await saved(page)).requirements.map((item) => item.type)).toEqual(["wall-fixed", "room-min-area", "room-max-area"]);
  expect(errors).toEqual([]);
});

test("a requirement for one named room checks only that room and outlines it on the plan", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "one-room.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(apartment())),
  });
  await expect(page.getByRole("heading", { name: "Требования", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  const panel = page.locator(".requirements-panel");
  const canvas = page.getByTestId("plan-canvas");
  await expect(canvas).toHaveAttribute("data-flagged-rooms", "[]");

  await addRequirement(page, async () => {
    await panel.getByLabel("Новое требование", { exact: true }).selectOption("room-min-area");
    await panel.getByLabel("Помещение", { exact: true }).selectOption({ label: "Кабинет" });
    await expect(panel.getByLabel("Назначение", { exact: true })).toHaveCount(0);
    await panel.locator("#requirement-area").fill("16");
  });
  const item = panel.locator(".requirement").first();
  await expect(item).toContainText("«Кабинет»: площадь не меньше 16 м²");
  await expect(item).toHaveAttribute("data-requirement-status", "violated");
  await expect(item).toContainText("Кабинет — 14,9 м²");
  // Exactly the study is outlined as breaking a requirement.
  await expect.poll(async () => JSON.parse((await canvas.getAttribute("data-flagged-rooms"))!).length).toBe(1);
  expect((await saved(page)).requirements[0]).toMatchObject({ type: "room-min-area", kind: "other", labelId: "label-other", minArea: 16 });

  await page.getByRole("button", { name: "Удалить требование: «Кабинет»: площадь не меньше 16 м²", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-flagged-rooms", "[]");
  expect(errors).toEqual([]);
});