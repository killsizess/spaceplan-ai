import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { readyTemplate, templateFlat } from "../src/domain/template/template.fixtures";

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
    name: "template.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
}

const templateTab = (page: Page) => page.getByRole("tab", { name: "Шаблон", exact: true });

async function openAsBuyer(page: Page, plan: FloorPlan) {
  await importPlan(page, plan);
  await templateTab(page).click();
  await page.getByRole("button", { name: "Открыть как покупатель" }).click();
  await expect(page.getByTestId("buyer-bar")).toBeVisible();
  await expect(page.getByTestId("buyer-panel")).toBeVisible();
}

test("the developer prepares a template and sees what keeps it from a buyer", async ({ page }) => {
  await importPlan(page, templateFlat());
  await templateTab(page).click();
  await page.getByRole("button", { name: "Начать подготовку" }).click();
  const status = page.getByTestId("template-status");
  await expect(status).toHaveText("Не готов для покупателя");
  const issues = page.getByTestId("template-issues");
  await expect(issues.locator('[data-issue="not-confirmed"]')).toContainText("Стены и проёмы не подтверждены");
  await expect(issues.locator('[data-issue="no-fixed"]')).toContainText("Отметьте мокрые зоны");

  await page.getByRole("button", { name: "Подтвердить стены и проёмы" }).click();
  await page.getByRole("button", { name: "Отметить кухни и санузлы как мокрые зоны" }).click();
  await page.getByLabel("Входная дверь").selectOption({ label: "Дверь в стене 3" });
  await page.getByRole("button", { name: "Разрешить перегородки вне мокрых зон" }).click();
  for (const room of ["Гостиная", "Спальня", "Прихожая"]) {
    await page.getByTestId("template-buyer-rooms").getByLabel(room).check();
  }
  await expect(status).toHaveText("Готов для покупателя");

  const plan = await saved(page);
  expect(plan.schemaVersion).toBe(11);
  expect(plan.template?.confirmed?.walls).toHaveLength(plan.walls.length);
  expect(plan.template?.fixed.map((item) => item.kind).sort()).toEqual(["entrance-door", "wet-zone", "wet-zone"]);
  expect(plan.template?.buyerWalls).toContain("living-bedroom");
  expect(plan.template?.buyerWalls).not.toContain("top");

  // A wall of unknown type makes it not ready again, and says which.
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  await page.getByLabel("Тип стены", { exact: true }).selectOption("unknown");
  await templateTab(page).click();
  await expect(status).toHaveText("Не готов для покупателя");
  await expect(issues.locator('[data-issue="unknown-walls"]')).toContainText("Тип не указан у стен: 5");
});

test("a buyer cannot touch a bearing wall and is told why", async ({ page }) => {
  await openAsBuyer(page, readyTemplate());
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  await expect(page.getByTestId("buyer-lock")).toContainText("Несущая стена: менять её нельзя");
  await expect(page.getByRole("button", { name: "Удалить стену", exact: true })).toBeDisabled();
  const before = await saved(page);

  // Not a silent refusal: the keyboard tries anyway, and the plan says why it did not change.
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alert").filter({ hasText: "Несущая стена" }).first()).toBeVisible();
  expect((await saved(page)).walls).toEqual(before.walls);
  expect(JSON.parse((await page.locator("[data-locked-walls]").getAttribute("data-locked-walls"))!)).toContain("top");
});

test("each change of a buyer is checked, marked in 2D and 3D, and can be undone", async ({ page }) => {
  await openAsBuyer(page, readyTemplate());
  await expect(page.getByTestId("buyer-no-changes")).toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  await expect(page.getByTestId("buyer-lock")).toHaveCount(0);
  await page.getByLabel("Сдвиг по X").fill("0.5");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();

  await page.getByRole("tab", { name: "Изменения", exact: true }).click();
  const change = page.getByTestId("buyer-change").first();
  await expect(change).toContainText("Перенести стену 5");
  await expect(change.getByTestId("buyer-verdict")).toHaveText("Упрощённый порядок");
  await expect(change.getByTestId("buyer-level")).toHaveText("Предположение");
  await expect(change.getByTestId("buyer-rule")).toContainText("508-ПП");
  await expect(change.getByTestId("buyer-rule-status")).toContainText("черновик");
  const tones = JSON.parse((await page.locator("[data-wall-tones]").first().getAttribute("data-wall-tones"))!);
  expect(tones["living-bedroom"]).toBe("ok");

  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-renderer-status", "ready");
  expect(JSON.parse((await page.getByTestId("plan-three").getAttribute("data-wall-tones"))!)).toHaveProperty("living-bedroom");
  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();

  await change.getByRole("button", { name: "Отменить это изменение" }).click();
  await expect(page.getByTestId("buyer-no-changes")).toBeVisible();
  const wall = (await saved(page)).walls.find((item) => item.id === "living-bedroom")!;
  expect(wall.start.x).toBeCloseTo(7, 9);
});

test("a question about the building is asked only where it matters, and the answer re-checks", async ({ page }) => {
  const facts = { region: "moscow" as const };
  await openAsBuyer(page, { ...readyTemplate({ ...templateFlat(), buildingFacts: facts }), buildingFacts: facts });
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await page.getByRole("tab", { name: "Изменения", exact: true }).click();

  const question = page.locator('[data-question="fact:woodenFloors"]');
  await expect(question).toContainText("Перекрытия деревянные?");
  await expect(question).toContainText("Убрать стену 5");
  await question.getByRole("button", { name: "Да", exact: true }).click();
  await expect(page.getByTestId("buyer-change").first().getByTestId("buyer-verdict")).toHaveText("Нужен проект");
  await expect(page.locator('[data-question="fact:woodenFloors"]')).toHaveCount(0);
  await expect(page.getByTestId("buyer-unconfirmed")).toContainText("ответ покупателя");
});

test("a project of format 10 opens unchanged and is saved as 11", async ({ page }) => {
  const old = JSON.parse(await readFile("public/rules/test-apartment.json", "utf8"));
  expect(old.schemaVersion).toBe(10);
  await importPlan(page, old);
  const plan = await saved(page);
  expect(plan.schemaVersion).toBe(11);
  expect(plan.walls).toEqual(old.walls);
  expect(plan.openings).toEqual(old.openings);
  expect(plan.wallRoomLabels).toEqual(old.wallRoomLabels);
});
