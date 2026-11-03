import { expect, test, type Page } from "@playwright/test";
import { createSpatialExamplePlan } from "../src/domain/floor-plan/examples";
import type { FloorPlan, RoomKind } from "../src/domain/floor-plan/types";
import { setWallRoomLabel } from "../src/domain/floor-plan/wall-room-labels";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";

function apartment(): FloorPlan {
  let plan: FloorPlan = { ...createSpatialExamplePlan(), name: "Исходная планировка", roomMode: "walls" };
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

async function stored(page: Page, id?: string): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate((target) => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + (target ?? localStorage.getItem("spaceplan-ai:active-project:v1")),
  )!).plan as FloorPlan, id);
}

test("a variant is a separate project that can be changed and compared with its source", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await stored(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "source.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(apartment())),
  });
  await expect(page.getByRole("heading", { name: "Исходная планировка", exact: true })).toBeVisible();
  const source = await stored(page);

  await page.getByRole("button", { name: "Вариант", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Исходная планировка · вариант", exact: true })).toBeVisible();
  const variant = await stored(page);
  expect(variant.id).not.toBe(source.id);
  expect(variant.walls).toEqual(source.walls);

  // Enlarge the kitchen in the variant only.
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 6", exact: true }).click();
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.3");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(async () => (await stored(page)).walls[5].start.x).toBeCloseTo(8.3, 9);
  expect((await stored(page, source.id)).walls).toEqual(source.walls);

  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Сравнение планов" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Сравнить с проектом", { exact: true }).selectOption({ label: "Исходная планировка" });
  const kitchen = dialog.getByRole("row", { name: /Кухня: площадь/ });
  await expect(kitchen).toContainText("11,06 м²");
  await expect(kitchen).toContainText("12,21 м²");
  await expect(kitchen).toContainText("+1,15 м²");
  const changes = dialog.getByTestId("plan-compare-changes");
  await expect(changes).toContainText("Стены: добавлено 0, удалено 0, изменено 3");
  await expect(changes).toContainText("Объём работ по стенам: 18,3 м");
  await expect(changes).toContainText("перенесено на плане: 2");
  // Room names were not touched; their automatic rebinding is not a change.
  await expect(changes).toContainText("Параметры помещений: добавлено 0, удалено 0, изменено 0");
  await expect(dialog.getByTestId("plan-compare-identical")).toHaveCount(0);
  await page.screenshot({ path: "../SpacePlan-AI-compare.png", fullPage: true });
  await dialog.getByRole("button", { name: "Закрыть сравнение", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Both projects stay in the library.
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Исходная планировка", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Исходная планировка · вариант", exact: true }).last()).toBeVisible();
  expect(errors).toEqual([]);
});
