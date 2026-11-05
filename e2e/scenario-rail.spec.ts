import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.2, height: 2.7,
});
const room = (): FloorPlan => ({
  ...createEmptyPlan("rail"),
  name: "Маршрут",
  roomMode: "walls",
  walls: [wall("a", 0, 0, 5, 0), wall("b", 5, 0, 5, 4), wall("c", 5, 4, 0, 4), wall("d", 0, 4, 0, 0)],
});

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
    name: "rail.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
}

const step = (page: Page, id: string) => page.locator(`.scenario-rail [data-step="${id}"]`);

test("the route follows the plan and each step opens its place", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, room());
  await expect(step(page, "drawing")).toHaveAttribute("data-state", "done");
  await expect(step(page, "walls")).toHaveAttribute("data-state", "done");
  await expect(step(page, "walls")).toContainText("4 стены");
  await expect(step(page, "kinds")).toHaveAttribute("data-state", "attention");
  await expect(step(page, "kinds")).toContainText("без типа 4");

  await step(page, "drawing").getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Подложка", exact: true })).toHaveAttribute("aria-selected", "true");
  await step(page, "kinds").getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Стены", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wall-kind-summary")).toContainText("без типа 4");
  await step(page, "requirements").getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Комнаты", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".requirements-panel")).toBeInViewport();
  await step(page, "variants").getByRole("button").click();
  const compare = page.getByRole("dialog", { name: "Сравнение планов" });
  await expect(compare).toBeVisible();
  await compare.getByRole("button", { name: "Закрыть сравнение" }).click();
  await step(page, "report").getByRole("button").click();
  await expect(page.getByTestId("report-verdict")).toBeVisible();
  expect(errors).toEqual([]);
});

test("wall types are marked right in the list, the next wall is one click away, and the plan shows them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, room());
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  const summary = page.getByTestId("wall-kind-summary");
  await expect(page.getByTestId("wall-kind-legend")).toBeVisible();

  await page.getByRole("button", { name: "Стена 1: несущая", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[0].kind).toBe("bearing");
  await expect(page.getByRole("button", { name: "Стена 1: несущая", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(summary).toContainText("без типа 3");

  // The way to the next wall without a type skips the marked one.
  await summary.getByRole("button", { name: "Следующая стена без типа" }).click();
  await expect(page.getByLabel("Тип стены", { exact: true })).toHaveValue("unknown");
  await expect(page.getByRole("button", { name: "Выбрать стену 2", exact: true })).toHaveClass(/selected/);

  await page.getByRole("button", { name: "Стена 2: перегородка", exact: true }).click();
  await page.getByRole("button", { name: "Стена 3: несущая", exact: true }).click();
  await page.getByRole("button", { name: "Стена 4: перегородка", exact: true }).click();
  await expect(summary).toContainText("Тип указан у всех стен");
  await expect(step(page, "kinds")).toHaveAttribute("data-state", "done");

  // Each mark is one undo step, and taking the mark off a bearing wall still asks first.
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(summary).toContainText("без типа 1");
  let asked = "";
  page.once("dialog", (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Стена 1: перегородка", exact: true }).click();
  await expect.poll(() => asked).toContain("перестанет считаться несущей");
  expect((await saved(page)).walls[0].kind).toBe("bearing");
  expect(errors).toEqual([]);
});

test("the library warns about a project with a problem and names a variant's source", async ({ page }) => {
  const walls: Wall[] = [];
  for (let line = 0; line <= 11; line++) {
    walls.push(wall(`h${line}`, 0, line * 2, 22, line * 2), wall(`v${line}`, line * 2, 0, line * 2, 22));
  }
  await importPlan(page, { ...createEmptyPlan("grid"), name: "Сетка", roomMode: "walls", walls });
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "rail.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(room())),
  });
  await expect(page.getByRole("heading", { name: "Маршрут", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Вариант", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Маршрут · вариант", exact: true })).toBeVisible();
  await saved(page);

  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  const library = page.getByRole("dialog", { name: /Мои проекты/ });
  await expect(library.getByTestId("project-warning")).toContainText("Помещения не определены: ");
  await expect(library.getByTestId("project-warning")).toContainText("больше 100 помещений");
  await expect(library.getByTestId("project-origin")).toContainText("Вариант плана «Маршрут»");
  await expect(library.getByTestId("project-unknown-walls").first()).toContainText("Без типа:");
  await expect(library).toContainText("1 помещение");
});

test("a project that cannot be read is announced, left in place and can be saved", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("broken-installed")) {
      localStorage.setItem("broken-installed", "yes");
      localStorage.setItem("spaceplan-ai:project:broken", '{"storageVersion":1,"plan":"повреждено"}');
    }
  });
  await page.goto("/");
  await expect(page.getByText("Не удалось прочитать проектов: 1")).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("spaceplan-ai:project:broken"));
  expect(stored).toContain("повреждено");
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  const library = page.getByRole("dialog", { name: /Мои проекты/ });
  const pending = page.waitForEvent("download");
  await library.getByRole("button", { name: "Скачать эти записи" }).click();
  const download = await pending;
  const records = JSON.parse((await readFile((await download.path())!)).toString()) as { key: string; raw: string }[];
  expect(records).toEqual([{ key: "spaceplan-ai:project:broken", raw: '{"storageVersion":1,"plan":"повреждено"}' }]);
});

test("the route shows all its steps at every width", async ({ page }) => {
  await importPlan(page, room());
  for (const width of [1440, 1280, 1100, 1024, 900]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.locator(".scenario-rail").evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow, `at ${width}`).toBeLessThanOrEqual(0);
    await expect(step(page, "report").getByRole("button")).toBeVisible();
  }
});
