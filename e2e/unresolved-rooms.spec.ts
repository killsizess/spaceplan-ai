import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7,
});

/** 121 rooms: more than the 100 the editor can derive from walls. */
function grid(): FloorPlan {
  const walls: Wall[] = [];
  for (let line = 0; line <= 11; line++) {
    walls.push(wall(`h${line}`, 0, line * 2, 22, line * 2));
    walls.push(wall(`v${line}`, line * 2, 0, line * 2, 22));
  }
  return { ...createEmptyPlan("grid"), name: "Слишком много помещений", roomMode: "walls", walls };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

test("a project whose rooms cannot be computed opens with an explanation and loses nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = grid();
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "grid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();

  const notice = page.getByTestId("unresolved-rooms-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Помещения по стенам не определены");
  await expect(page.getByTestId("unresolved-rooms-reason")).toContainText("больше 100 помещений");
  await expect(notice).toContainText("Стен: 24");
  await expect(notice).toContainText("ничего не удалено");
  await expect(page.getByTestId("room-count")).toHaveText("00");

  // Nothing was changed or dropped by opening it, and it is saved as it came.
  const plan = await saved(page);
  expect(plan.walls).toEqual(fixture.walls);
  expect(plan.roomMode).toBe("walls");

  // It survives a reload and shows up in the library as readable.
  await page.reload();
  await expect(page.getByTestId("unresolved-rooms-notice")).toBeVisible();
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Слишком много помещений");
  await page.keyboard.press("Escape");

  // The 3D view does not fail without rooms.
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-renderer-status", "ready");
  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();

  // The project can still be exported as JSON.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const exported = JSON.parse((await readFile((await (await download).path())!)).toString()) as FloorPlan;
  expect(exported.walls).toEqual(fixture.walls);

  // Switching to manual rooms keeps every wall and can be undone.
  await page.getByRole("button", { name: "Перейти к ручным комнатам", exact: true }).click();
  await expect(page.getByTestId("unresolved-rooms-notice")).toHaveCount(0);
  expect((await saved(page)).walls).toEqual(fixture.walls);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("unresolved-rooms-notice")).toBeVisible();
  expect(errors).toEqual([]);
});

test("removing two wall lines fixes it, and Undo brings the explanation back", async ({ page }) => {
  const fixture = grid();
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "grid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByTestId("unresolved-rooms-notice")).toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  // The last horizontal and vertical lines are walls 23 and 24 in plan order.
  for (const number of [24, 23]) {
    await page.getByRole("button", { name: `Выбрать стену ${number}`, exact: true }).click();
    await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  }
  await expect.poll(async () => (await saved(page)).walls.length).toBe(22);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(page.getByTestId("unresolved-rooms-notice")).toHaveCount(0);
  await expect(page.getByTestId("room-count")).toHaveText("100");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("unresolved-rooms-notice")).toBeVisible();
});
