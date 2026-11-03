import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.2,
  height: 2.7,
});

function isolatedPlan(): FloorPlan {
  return {
    ...createEmptyPlan("wall-length"),
    name: "Точная длина стены",
    walls: [wall("top", 0, 0, 4, 0)],
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
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

async function importPlan(page: Page, fixture: FloorPlan) {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "wall-length.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  const original = await saved(page);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  await expect(page.getByLabel("Длина стены", { exact: true })).toHaveValue("4");
  return original;
}

async function applyLength(page: Page, length: string) {
  await page.getByLabel("Длина стены", { exact: true }).fill(length);
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
}

test("a precise wall length updates the real 3D wall and is one undo action", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page, isolatedPlan());
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await applyLength(page, "6");
  const enlarged: FloorPlan = {
    ...original,
    walls: [{ ...original.walls[0], end: { x: 6, y: 0 } }],
  };
  await expect.poll(() => saved(page)).toEqual(enlarged);
  await expect(page.getByLabel("Конец X", { exact: true })).toHaveValue("6");
  await expect(page.getByLabel("Конец Y", { exact: true })).toHaveValue("0");
  await expect(viewer).toHaveAttribute("data-wall-solids", "1");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await expect.poll(async () => Number((await viewer.getAttribute("data-camera-position"))?.split(",")[0]))
    .toBeCloseTo(3, 4);
  // Clear selection, then hit the new wall cap beyond its former four-metre end.
  await viewer.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Длина стены", { exact: true })).toHaveCount(0);
  const box = await viewer.boundingBox();
  expect(box).not.toBeNull();
  const position = (await viewer.getAttribute("data-camera-position"))!.split(",").map(Number);
  const camera = new PerspectiveCamera(42, box!.width / box!.height, 0.01, 1000);
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(3, 2.7 / 2, 0);
  camera.updateMatrixWorld();
  const cap = new Vector3(5.5, 2.7, 0).project(camera);
  await page.mouse.click(
    box!.x + ((cap.x + 1) * box!.width) / 2,
    box!.y + ((1 - cap.y) * box!.height) / 2,
  );
  await expect(page.getByLabel("Длина стены", { exact: true })).toHaveValue("6");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(() => saved(page)).toEqual(original);
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  await expect(page.getByLabel("Длина стены", { exact: true })).toHaveValue("4");
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("length preserves connected corners and rejects nonnumeric and zero drafts", async ({ page }) => {
  const fixture = isolatedPlan();
  fixture.roomMode = "walls";
  fixture.walls.push(
    wall("right", 4, 0, 4, 4),
    wall("bottom", 4, 4, 0, 4),
    wall("left", 0, 4, 0, 0),
  );
  const original = await importPlan(page, fixture);
  await expect(page.getByTestId("total-area")).toHaveText("14,44 м²");
  await applyLength(page, "6");
  await expect.poll(() => saved(page)).toEqual({
    ...original,
    walls: original.walls.map((item) => item.id === "top"
      ? { ...item, end: { x: 6, y: 0 } }
      : item.id === "right" ? { ...item, start: { x: 6, y: 0 } } : item),
  });
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(page.getByTestId("total-area")).not.toHaveText("14,44 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(() => saved(page)).toEqual(original);
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  const record = await savedRecord(page);
  for (const invalid of ["NaN", "0"]) {
    await applyLength(page, invalid);
    await expect(page.getByRole("alert").first()).toBeVisible();
    expect(await savedRecord(page)).toBe(record);
    await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  }
});

test("length rolls back every wall when a connected neighbor can no longer fit its door", async ({ page }) => {
  const fixture = isolatedPlan();
  fixture.walls.push(wall("neighbor", 4, 0, 8, 0));
  fixture.openings.push({
    id: "neighbor-door",
    wallId: "neighbor",
    kind: "door",
    offset: 2.8,
    width: 0.9,
    height: 2.1,
    sillHeight: 0,
  });
  const original = await importPlan(page, fixture);
  const record = await savedRecord(page);
  // The shared node at x = 7 would cut the neighbor's door at x = 6.8..7.7.
  await applyLength(page, "7");
  await expect(page.getByRole("region", { name: "Рабочая область редактора", exact: true })
    .getByRole("alert")).toBeVisible();
  expect(await saved(page)).toEqual(original);
  expect(await savedRecord(page)).toBe(record);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeDisabled();
  // At x = 6 the shorter neighbor still holds the door, which stays where it was.
  await applyLength(page, "6");
  await expect.poll(async () => (await saved(page)).walls[1].start).toEqual({ x: 6, y: 0 });
  const shortened = await saved(page);
  expect(shortened.openings[0].offset).toBeCloseTo(0.8, 9);
  expect(shortened.walls[1].start.x + shortened.openings[0].offset).toBeCloseTo(6.8, 9);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeEnabled();
});
