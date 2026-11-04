import { expect, test, type Page } from "@playwright/test";
import { createSpatialExamplePlan } from "../src/domain/floor-plan/examples";
import type { FloorPlan } from "../src/domain/floor-plan/types";

const SOURCE = "Исходная планировка";
const VARIANT = `${SOURCE} · вариант`;

async function stored(page: Page, id?: string): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate((target) => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + (target ?? localStorage.getItem("spaceplan-ai:active-project:v1")),
  )!).plan as FloorPlan, id);
}

const library = (page: Page) => page.getByRole("dialog", { name: /Мои проекты/ });
const card = (page: Page, id: string) => library(page).locator(`[data-testid="saved-project"][data-project-id="${id}"]`);

async function openProject(page: Page, id: string, name: string) {
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await card(page, id).getByRole("button", { name: `Открыть ${name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function compare(page: Page) {
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Сравнение планов" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a variant keeps its source and a snapshot, and compares with it after the source changed or is gone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await stored(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "source.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...createSpatialExamplePlan(), name: SOURCE, roomMode: "walls" })),
  });
  await expect(page.getByRole("heading", { name: SOURCE, exact: true })).toBeVisible();
  const source = await stored(page);
  expect(source).not.toHaveProperty("origin");

  await page.getByRole("button", { name: "Вариант", exact: true }).click();
  await expect(page.getByRole("heading", { name: VARIANT, exact: true })).toBeVisible();
  const variant = await stored(page);
  expect(variant.schemaVersion).toBe(7);
  expect(variant.origin).toMatchObject({ planId: source.id, planName: SOURCE });
  expect(variant.origin!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(variant.origin!.snapshot.walls).toEqual(source.walls);
  expect(variant.origin!.snapshot).not.toHaveProperty("underlay");
  expect(variant.origin!.snapshot).not.toHaveProperty("origin");

  // Right after creation: the source is compared by default, and nothing differs.
  let dialog = await compare(page);
  await expect(dialog.getByLabel("Сравнить с проектом", { exact: true })).toHaveValue("origin:snapshot");
  await expect(dialog.getByTestId("plan-compare-origin-note")).toHaveAttribute("data-origin-status", "unchanged");
  await expect(dialog.getByTestId("plan-compare-identical")).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть сравнение", exact: true }).click();

  // The source is edited afterwards: the variant still compares with the plan it was made from.
  await openProject(page, source.id, SOURCE);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 6", exact: true }).click();
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.3");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(async () => (await stored(page)).walls[5].start.x).toBeCloseTo(8.3, 9);
  await openProject(page, variant.id, VARIANT);
  dialog = await compare(page);
  await expect(dialog.getByTestId("plan-compare-origin-note")).toHaveAttribute("data-origin-status", "changed");
  await expect(dialog.getByTestId("plan-compare-origin-note")).toContainText("изменён после создания варианта");
  await expect(dialog.getByTestId("plan-compare-identical")).toBeVisible();
  // Against the edited source itself the plans differ, as before.
  await dialog.getByLabel("Сравнить с проектом", { exact: true }).selectOption({ label: SOURCE });
  await expect(dialog.getByTestId("plan-compare-identical")).toHaveCount(0);
  await expect(dialog.getByTestId("plan-compare-changes")).toContainText("Стены: добавлено 0, удалено 0, изменено 3");
  await dialog.getByRole("button", { name: "Закрыть сравнение", exact: true }).click();

  // The source is deleted: a plain message, no error, and the comparison still works.
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await card(page, source.id).getByRole("button", { name: `В корзину ${SOURCE}`, exact: true }).click();
  await card(page, source.id).getByRole("button", { name: "Переместить в корзину", exact: true }).click();
  await expect(card(page, source.id)).toHaveCount(0);
  await page.keyboard.press("Escape");
  dialog = await compare(page);
  const note = dialog.getByTestId("plan-compare-origin-note");
  await expect(note).toHaveAttribute("data-origin-status", "missing");
  await expect(note).toContainText("больше нет в библиотеке");
  await expect(dialog.getByTestId("plan-compare-identical")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // A reload keeps it all: the origin is part of the saved project.
  await page.reload();
  expect((await stored(page)).origin?.planId).toBe(source.id);
  expect(errors).toEqual([]);
});

test("a project that is not a variant compares as before and has no origin note", async ({ page }) => {
  await page.goto("/");
  await stored(page);
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Сравнение планов" });
  await expect(dialog.getByTestId("plan-compare-origin-note")).toHaveCount(0);
  await expect(dialog).toContainText("В библиотеке нет других проектов");
});
