import { expect, test } from "@playwright/test";
import { createSpatialExamplePlan } from "../src/domain/floor-plan/examples";
import type { FloorPlan } from "../src/domain/floor-plan/types";

test("a room lists its neighbours across walls, doors between them and doors outside", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture: FloorPlan = { ...createSpatialExamplePlan(), name: "Соседи помещений", roomMode: "walls" };
  await page.goto("/");
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "neighbours.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: "Соседи помещений", exact: true })).toBeVisible();
  await expect(page.getByTestId("room-count")).toHaveText("06");

  // Rooms are numbered top to bottom, left to right: 3 is the hall by the entrance.
  await page.locator(".room-list-item", { hasText: "Помещение 3" }).click();
  const panel = page.locator(".properties-panel");
  await expect(panel.getByRole("heading", { name: "Помещение 3", exact: true })).toBeVisible();
  const neighbours = panel.locator(".wall-room-neighbours li");
  await expect(neighbours).toHaveText([
    /Помещение 2\s*общая стена 3,84 м · дверь/,
    /Помещение 6\s*общая стена 1,84 м · без двери/,
    /Помещение 5\s*общая стена 0,88 м · без двери/,
  ]);
  await expect(panel.getByTestId("wall-room-exterior-doors")).toHaveText("Наружу: 1 дверь");

  await panel.getByRole("button", { name: "Выбрать соседнее помещение Помещение 2", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Помещение 2", exact: true })).toBeVisible();
  await expect(neighbours).toHaveCount(3);
  await expect(neighbours.first()).toContainText("дверь");
  await expect(panel.getByTestId("wall-room-exterior-doors")).toHaveCount(0);
  expect(errors).toEqual([]);
});
