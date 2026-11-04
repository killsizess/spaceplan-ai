import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, kind?: Wall["kind"]): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7, ...(kind ? { kind } : {}),
});

function apartment(): FloorPlan {
  return {
    ...createEmptyPlan("report"),
    name: "Квартира для отчёта",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0, "bearing"),
      wall("right", 10, 0, 10, 6, "bearing"),
      wall("bottom", 10, 6, 0, 6, "bearing"),
      wall("left", 0, 6, 0, 0, "bearing"),
      wall("partition", 6, 0, 6, 6, "partition"),
    ],
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function importPlan(page: Page, plan: FloorPlan) {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "report.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
}

async function openReport(page: Page, name: string) {
  await page.getByRole("button", { name: "Отчёт", exact: true }).click();
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function downloadPdf(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать PDF", exact: true }).click();
  const download = await pending;
  const bytes = await readFile((await download.path())!);
  return { name: download.suggestedFilename(), text: bytes.toString("latin1"), size: bytes.length };
}

test("a sound plan gets a clear report with its limits, and a PDF with the drawing attached", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, apartment());
  const before = await saved(page);
  const dialog = await openReport(page, "Квартира для отчёта");
  await expect(page.getByTestId("report-verdict")).toHaveAttribute("data-level", "clear");
  await expect(page.getByTestId("report-verdict")).toContainText("Замечаний нет");
  await expect(page.getByTestId("report-wall-kinds")).toContainText("несущих 4 · перегородок 1 · не указано 0");
  await expect(page.getByTestId("report-area")).not.toHaveText("не определена");
  await expect(page.getByTestId("report-level-verified")).toContainText("Геометрия без замечаний");
  await expect(page.getByTestId("report-level-specialist")).toHaveCount(0);
  const limits = page.getByTestId("report-limits");
  await expect(limits).toContainText("не заменяет проект");
  await expect(limits).toContainText("база правил ещё не подключена");

  const pdf = await downloadPdf(page);
  expect(pdf.name).toBe("Квартира для отчёта — отчёт.pdf");
  expect(pdf.text.startsWith("%PDF-1.4")).toBe(true);
  // The report's page and the drawing.
  expect(pdf.text).toMatch(/\/Count 2 /);
  expect(pdf.size).toBeGreaterThan(30_000);
  await expect(page.getByTestId("report-message")).toContainText("сохранён");

  // Reading a report changes nothing in the project.
  await dialog.getByRole("button", { name: "Закрыть отчёт" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await saved(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("an unknown wall type blocks a clear verdict and is reported as an assumption", async ({ page }) => {
  const plan = apartment();
  plan.walls[4] = wall("partition", 6, 0, 6, 6);
  await importPlan(page, plan);
  await openReport(page, plan.name);
  await expect(page.getByTestId("report-verdict")).toHaveAttribute("data-level", "assumption");
  const level = page.getByTestId("report-level-assumption");
  await expect(level).toContainText("Тип не указан у стен: 1 из 5");
  await expect(level).toContainText("приложение его не определяет");
});

test("a variant that moves a bearing wall is sent to a specialist, compared with its source", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, apartment());
  await page.getByRole("button", { name: "Вариант", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Квартира для отчёта · вариант", exact: true })).toBeVisible();
  let dialog = await openReport(page, "Квартира для отчёта · вариант");
  await expect(page.getByTestId("report-level-verified")).toContainText("Вариант совпадает с исходным планом");
  await expect(page.getByTestId("report-origin")).toContainText("Вариант плана «Квартира для отчёта»");
  await dialog.getByRole("button", { name: "Закрыть отчёт" }).click();

  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  // Moving the partition rests on the bearing walls: their common ends stay on them.
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.5");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[4].start.x).toBeCloseTo(6.5, 9);
  dialog = await openReport(page, "Квартира для отчёта · вариант");
  await expect(page.getByTestId("report-level-assumption")).toContainText("Изменено перегородок: 1");
  await expect(page.getByTestId("report-level-assumption")).toContainText("Требования к перепланировке не проверялись");
  await dialog.getByRole("button", { name: "Закрыть отчёт" }).click();

  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  page.once("dialog", (confirm) => void confirm.accept());
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(4);
  await openReport(page, "Квартира для отчёта · вариант");
  await expect(page.getByTestId("report-verdict")).toHaveAttribute("data-level", "specialist");
  await expect(page.getByTestId("report-verdict")).toContainText("Нужен специалист");
  await expect(page.getByTestId("report-level-specialist")).toContainText("Затронута несущая стена: стена 1 исходного плана удалена");
  expect((await downloadPdf(page)).text.startsWith("%PDF")).toBe(true);
  expect(errors).toEqual([]);
});

test("a plan whose rooms cannot be computed still gets a report, without a drawing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const walls: Wall[] = [];
  for (let line = 0; line <= 11; line++) {
    walls.push(wall(`h${line}`, 0, line * 2, 22, line * 2), wall(`v${line}`, line * 2, 0, line * 2, 22));
  }
  const plan: FloorPlan = { ...createEmptyPlan("grid"), name: "Сетка", roomMode: "walls", walls };
  await importPlan(page, plan);
  await openReport(page, "Сетка");
  await expect(page.getByTestId("report-verdict")).toHaveAttribute("data-level", "undetermined");
  await expect(page.getByTestId("report-area")).toHaveText("не определена");
  await expect(page.getByTestId("report-level-undetermined")).toContainText("больше 100 помещений");
  const pdf = await downloadPdf(page);
  expect(pdf.text).toMatch(/\/Count 1 /);
  expect(errors).toEqual([]);
});
