import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { apartment, variantOf } from "../src/domain/rules/rules.fixtures";
import type { FloorPlan } from "../src/domain/floor-plan/types";

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function importPlan(page: Page, fixture: FloorPlan) {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "xray.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
}

const openXray = async (page: Page) => {
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Квартира/ });
  await expect(dialog).toBeVisible();
  return dialog;
};
const finding = (page: Page, rule: string) => page.locator(`[data-testid="xray-finding"][data-rule="${rule}"]`);

test("no rules run until the owner chooses the region, and the answers are saved with the plan", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, apartment({}));
  await openXray(page);
  await expect(page.getByTestId("xray-no-rules")).toContainText("Укажите, где находится квартира");
  await expect(page.getByTestId("xray-draft")).toHaveCount(0);

  await page.getByLabel("Где находится квартира").selectOption("other");
  await expect(page.getByTestId("xray-no-rules")).toContainText("Для этого региона базы правил пока нет");
  await expect(page.getByLabel("В квартире есть газ")).toHaveCount(0);

  await page.getByLabel("Где находится квартира").selectOption("moscow");
  await expect(page.getByTestId("xray-no-rules")).toHaveCount(0);
  await expect(page.getByTestId("xray-draft")).toContainText("специалист их ещё не сверил");
  await expect(page.getByTestId("xray-documents")).toContainText("№ 841-ПП от 18.04.2025");
  await expect(page.getByTestId("xray-documents")).toContainText("Не прочитан № 3005-ПП");
  await expect(page.getByTestId("xray-not-checked")).toContainText("Вентиляционные каналы");
  await expect(page.getByTestId("xray-missing")).toContainText("Осталось вопросов: 6");

  await page.getByLabel("В квартире есть газ").selectOption("yes");
  await page.getByLabel("Этажом ниже").selectOption("same-layout");
  await expect(page.getByTestId("xray-missing")).toContainText("Осталось вопросов: 4");
  expect((await saved(page)).buildingFacts).toEqual({ region: "moscow", gasified: true, below: "same-layout" });

  // The answers travel with the plan: through a reload and an exported file.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Квартира", exact: true })).toBeVisible();
  await openXray(page);
  await expect(page.getByLabel("В квартире есть газ")).toHaveValue("yes");
  await page.getByRole("button", { name: "Закрыть X-Ray" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON" }).click();
  const exported = JSON.parse(await readFile(await (await download).path(), "utf8")) as FloorPlan;
  expect(exported.schemaVersion).toBe(8);
  expect(exported.buildingFacts?.gasified).toBe(true);

  // An answer is an edit like any other: undo takes it back.
  await openXray(page);
  await page.getByLabel("Перекрытия деревянные").selectOption("no");
  await expect.poll(async () => (await saved(page)).buildingFacts?.woodenFloors).toBe(false);
  await page.getByRole("button", { name: "Закрыть X-Ray" }).click();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => (await saved(page)).buildingFacts?.woodenFloors).toBeUndefined();
  expect(errors).toEqual([]);
});

test("every wall gets an answer with the point of the document behind it", async ({ page }) => {
  await importPlan(page, apartment());
  await openXray(page);
  await expect(page.getByTestId("xray-wall")).toHaveCount(7);
  await expect(page.getByTestId("xray-count-specialist")).toHaveText("4");
  await expect(page.getByTestId("xray-count-project")).toHaveText("2");
  await expect(page.getByTestId("xray-count-unknown")).toHaveText("1");

  const top = page.locator('[data-wall="top"]');
  await expect(top).toHaveAttribute("data-procedure", "specialist");
  await expect(top).toContainText("508-ПП, прил. 1, пп. 9.3, 9.6");
  const betweenKitchenAndLiving = page.locator('[data-wall="living-kitchen"]');
  await expect(betweenKitchenAndLiving).toHaveAttribute("data-procedure", "unknown");

  // Answering the gas question moves that wall to another procedure at once.
  await page.getByLabel("В квартире есть газ").selectOption("yes");
  await expect(betweenKitchenAndLiving).toHaveAttribute("data-procedure", "forbidden");
  await expect(betweenKitchenAndLiving).toContainText("508-ПП, прил. 1, п. 9.16");
  await page.getByLabel("В квартире есть газ").selectOption("no");
  await expect(betweenKitchenAndLiving).toHaveAttribute("data-procedure", "simplified");
  await expect(betweenKitchenAndLiving).toContainText("508-ПП, прил. 1, пп. 19.6.1, 19.1");

  await expect(page.getByTestId("xray-room")).toHaveCount(2);
  await expect(finding(page, "moscow.pp47.25")).toContainText("Окно наружу есть");
  await expect(page.getByTestId("xray-overall")).toHaveCount(0);

  // A wall in the list can be found on the plan.
  await page.locator('[data-wall="living-bath"]').getByRole("button", { name: "Показать на плане" }).click();
  await expect(page.getByTestId("xray-dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Удалить стену", exact: true })).toBeVisible();
  await expect(page.getByLabel("Тип стены", { exact: true })).toHaveValue("partition");
});

test("a variant made in the app is checked against its source, down to a forbidden merge", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, apartment({ region: "moscow", gasified: true, below: "no-dwelling", above: "no-dwelling" }));
  await page.getByRole("button", { name: "Вариант", exact: true }).click();
  await expect(page.getByRole("heading", { name: /вариант/i })).toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выбрать стену 7", exact: true })).toHaveCount(0);
  const stored = await saved(page);
  expect(stored.origin?.planName).toBe("Квартира");

  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await expect(page.getByTestId("xray-overall")).toHaveAttribute("data-procedure", "forbidden");
  await expect(finding(page, "moscow.508.9.16")).toContainText("Газифицированная кухня объединена с жилой комнатой");
  await expect(finding(page, "moscow.508.9.16")).toContainText("508-ПП, прил. 1, п. 9.16");
  // With gas the wall cannot go at all, so no simpler procedure is named for it.
  await expect(finding(page, "moscow.508.19.6.1")).toHaveCount(0);

  await page.getByLabel("В квартире есть газ").selectOption("no");
  await expect(finding(page, "moscow.508.19.6.1")).toContainText("упрощённый порядок");
  // Without gas the ban goes away, but a changed kitchen still has no clear answer.
  await expect(finding(page, "moscow.508.9.16")).toContainText("запрет для газа не применён");
  await expect(finding(page, "moscow.kitchen.changed")).toContainText("Границы кухни изменены");
  await expect(page.getByTestId("xray-overall")).toHaveAttribute("data-procedure", "unknown");
  await page.getByLabel("В квартире есть газ").selectOption("");
  await expect(finding(page, "moscow.508.9.16")).toContainText("неизвестно, есть ли газ");
  await page.getByLabel("В квартире есть газ").selectOption("yes");
  await page.getByRole("button", { name: "Закрыть X-Ray" }).click();

  // The report carries the same conclusion, its source and the edition of the rules.
  await page.getByRole("button", { name: "Отчёт", exact: true }).click();
  const report = page.getByRole("dialog");
  await expect(page.getByTestId("report-verdict")).toHaveAttribute("data-level", "specialist");
  await expect(page.getByTestId("report-level-specialist")).toContainText("Газифицированная кухня объединена");
  await expect(page.getByTestId("report-level-specialist")).toContainText("508-ПП, прил. 1, п. 9.16");
  await expect(page.getByTestId("report-limits")).toContainText("база правил от 05.11.2026");
  await expect(page.getByTestId("report-limits")).toContainText("База не сверена со специалистом");
  await expect(page.getByTestId("report-limits")).not.toContainText("база правил ещё не подключена");
  await expect(report).not.toContainText("допустимо.");
  expect(errors).toEqual([]);
});

test("a saved variant keeps being checked after its source project is deleted", async ({ page }) => {
  await importPlan(page, variantOf(apartment(), (plan) => ({
    ...plan,
    name: "Квартира, вариант",
    walls: plan.walls.filter((wall) => wall.id !== "top"),
    openings: plan.openings.filter((opening) => opening.wallId !== "top"),
  })));
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await expect(page.getByTestId("xray-overall")).toHaveAttribute("data-procedure", "specialist");
  await expect(finding(page, "moscow.508.9.3")).toContainText("стена 1 исходного плана удалена");
});

test("X-Ray fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importPlan(page, apartment());
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await expect(page.getByTestId("xray-wall").first()).toBeVisible();
  const overflow = await page.getByTestId("xray-dialog").evaluate((node) => {
    const scroller = node.querySelector(".plan-report-scroll")!;
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the test apartment published for the specialist opens and answers", async ({ page, request }) => {
  const response = await request.get("/rules/test-apartment.json");
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "test-apartment.json", mimeType: "application/json", buffer: await response.body(),
  });
  await expect(page.getByRole("heading", { name: "Тестовая квартира для сверки", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await expect(page.getByTestId("xray-draft")).toBeVisible();
  await expect(page.getByTestId("xray-wall")).toHaveCount(7);
  await expect(page.locator('[data-wall="living-kitchen"]')).toHaveAttribute("data-procedure", "unknown");
});
