import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createVariantsExamplePlan } from "../src/domain/generation/example-flat";
import type { FloorPlan } from "../src/domain/floor-plan/types";


async function importPlan(page: Page, plan: FloorPlan) {
  await page.goto("/");
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "proof.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
}

const openXray = async (page: Page) => {
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await expect(page.getByTestId("xray-dialog")).toBeVisible();
};
const wallCard = (page: Page, wallId: string) => page.locator(`[data-testid="xray-wall"][data-wall="${wallId}"]`);

test("asking about a wall explains the answer and leaves the project alone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, createVariantsExamplePlan());
  await openXray(page);
  await wallCard(page, "living-kitchen").getByRole("button", { name: "Что, если убрать" }).click();

  const dialog = page.getByTestId("proof-dialog");
  await expect(dialog.getByRole("heading", { name: "Что, если убрать стену 6" })).toBeVisible();
  await expect(dialog).toContainText("Это только вопрос: ваш проект не изменился");
  await expect(page.getByTestId("proof-label")).toHaveText("Нет данных");
  await expect(page.getByTestId("proof-draft")).toContainText("черновик");

  // The chain.
  await expect(page.getByTestId("proof-decision")).toHaveCount(1);
  await expect(page.getByTestId("proof-decision")).toContainText("Убрать стену 6 (перегородка) между «Гостиная» и «Кухня»");
  await expect(page.getByTestId("proof-reason").first()).toContainText("508-ПП");
  await expect(page.getByTestId("proof-depends").first()).toContainText("Тип стены 6: перегородка");

  // What would change it, found by running the rules again.
  const gas = page.getByTestId("proof-alternative").filter({ hasText: "В квартире есть газ" });
  await expect(gas).toContainText("Не допускается");
  await expect(gas).toContainText("Газифицированная кухня");
  await expect(page.getByTestId("proof-alternative").filter({ hasText: "Тип стены 6" })).toContainText("Нужен специалист");

  // What it stands on, and how far it goes.
  await expect(page.getByTestId("proof-inputs")).toContainText("Указано владельцем плана и не проверялось");
  await expect(page.getByTestId("proof-inputs")).toContainText("Стена 6");
  await expect(page.getByTestId("proof-area")).toContainText("→");
  await expect(page.getByTestId("proof-limits")).toContainText("не заменяет");
  await expect(page.getByTestId("proof-fingerprint")).toContainText("а не электронная подпись");

  // Closing returns to X-Ray, and the plan has not moved.
  await page.getByRole("button", { name: "Закрыть Proof" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("xray-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть X-Ray" }).click();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выбрать стену 6", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выбрать стену 11", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a question becomes a variant only when asked to", async ({ page }) => {
  await importPlan(page, createVariantsExamplePlan());
  await openXray(page);
  await wallCard(page, "living-bedroom").getByRole("button", { name: "Что, если убрать" }).click();
  await expect(page.getByTestId("proof-label")).toHaveText("Упрощённый порядок");
  await page.getByTestId("proof-dialog").getByRole("button", { name: "Сохранить как вариант" }).click();

  await expect(page.getByTestId("proof-dialog")).toHaveCount(0);
  await expect(page.getByTestId("xray-dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /без стены 5/ })).toBeVisible();

  // Saved, it is a variant like any other: X-Ray sees it and explains it from its own button.
  await openXray(page);
  await expect(page.getByTestId("xray-overall")).toBeVisible();
  await page.getByTestId("xray-overall").getByRole("button", { name: "Почему такой вывод" }).click();
  const dialog = page.getByTestId("proof-dialog");
  await expect(page.getByTestId("proof-decision")).toContainText("Убрать стену 5");
  await expect(dialog).not.toContainText("Это только вопрос");
  await expect(dialog.getByRole("button", { name: "Сохранить как вариант" })).toHaveCount(0);
  await page.getByRole("button", { name: "Закрыть Proof" }).click();
  await page.getByRole("button", { name: "Закрыть X-Ray" }).click();

  // The report of a variant leads to the same place; the report of a source plan does not.
  await page.locator('.scenario-rail [data-step="report"]').getByRole("button").click();
  await page.getByRole("button", { name: "Почему такой вывод" }).click();
  await expect(page.getByTestId("proof-decision")).toContainText("Убрать стену 5");
});

test("a proposal of the generator is explained over the list, which stays", async ({ page }) => {
  await importPlan(page, createVariantsExamplePlan());
  await page.locator('.scenario-rail [data-step="variants"]').getByRole("button").click();
  const list = page.getByTestId("variants-dialog");
  await list.getByRole("button", { name: "Подобрать варианты" }).click();
  const card = page.getByTestId("variant-card").first();
  await card.getByRole("button", { name: "Почему такой вывод" }).click();

  const dialog = page.getByTestId("proof-dialog");
  const decisions = page.getByTestId("proof-decision");
  await expect(decisions).toHaveCount(2);
  await expect(decisions.first()).toContainText("Поставить новую стену 12 (перегородка): дверь в ней");
  // Naming the new room is a step of its own. The old room keeps its name, so it is one step:
  // two would mean both halves were named anew.
  await expect(decisions.nth(1)).toContainText("Назвать новое помещение «Спальня 2» (спальня)");
  await expect(page.getByTestId("proof-label")).toHaveText("Упрощённый порядок");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("variant-card")).toHaveCount(6);

  await card.getByRole("button", { name: "Почему такой вывод" }).click();
  await dialog.getByRole("button", { name: "Сохранить как вариант" }).click();
  await expect(list).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /подбор 1/ })).toBeVisible();
});

test("with no rules chosen it says so, and shows what the plan itself shows", async ({ page }) => {
  const { buildingFacts: _none, ...plan } = createVariantsExamplePlan();
  void _none;
  await importPlan(page, plan as FloorPlan);
  await page.locator('.scenario-rail [data-step="variants"]').getByRole("button").click();
  await page.getByTestId("variants-dialog").getByRole("button", { name: "Подобрать варианты" }).click();
  await page.getByTestId("variant-card").first().getByRole("button", { name: "Почему такой вывод" }).click();
  await expect(page.getByTestId("proof-label")).toHaveText("Нормы не проверялись");
  // The new wall and the new room's name: both said to be unchecked.
  await expect(page.getByTestId("proof-silent")).toHaveText(["Правила не проверялись.", "Правила не проверялись."]);
  await expect(page.getByTestId("proof-alternatives")).toHaveCount(0);
  await expect(page.getByTestId("proof-area")).toContainText("→");
});

test("the proof downloads as a PDF", async ({ page }) => {
  await importPlan(page, createVariantsExamplePlan());
  await openXray(page);
  await wallCard(page, "living-kitchen").getByRole("button", { name: "Что, если убрать" }).click();
  const download = page.waitForEvent("download");
  await page.getByTestId("proof-dialog").getByRole("button", { name: "Скачать PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/proof.*\.pdf$/i);
  const path = await file.path();
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(5000);
  await expect(page.getByTestId("proof-message")).toHaveText("Сохранено в PDF.");
  // Two pages of text and the drawing of the plan after the decision.
  expect(bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBeGreaterThanOrEqual(2);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("it fits the screen and its buttons stay reachable", async ({ page }) => {
    await importPlan(page, createVariantsExamplePlan());
    await openXray(page);
    const asked = wallCard(page, "living-kitchen").getByRole("button", { name: "Что, если убрать" });
    await asked.scrollIntoViewIfNeeded();
    await asked.click();
    const dialog = page.getByTestId("proof-dialog");
    await expect(page.getByTestId("proof-label")).toBeVisible();
    const scroll = dialog.locator(".plan-report-scroll");
    expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const box = await dialog.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await expect(dialog.getByRole("button", { name: "Скачать PDF" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Сохранить как вариант" })).toBeInViewport();
  });
});
