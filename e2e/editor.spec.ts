import { expect, test, type Page } from "@playwright/test";

async function newPlan(page: Page) {
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Тестовая квартира");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await expect(
    page.getByRole("heading", { name: "Тестовая квартира" }),
  ).toBeVisible();
}

test("complete room lifecycle, validation and history", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByTestId("plan-canvas").locator("canvas").first(),
  ).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("80 м²");
  await page.screenshot({ path: "../SpacePlan-AI.png", fullPage: true });
  await newPlan(page);
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await page.getByRole("button", { name: "Добавить первую комнату" }).click();
  await expect(page.getByTestId("room-area")).toHaveText("12 м²");
  await page.getByLabel("Ширина", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  await expect(page.getByTestId("room-area")).toHaveText("15 м²");
  await expect(page.getByTestId("total-area")).toHaveText("15 м²");
  await page.getByLabel("Длина", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  await expect(
    page
      .getByRole("region", { name: "Рабочая область редактора" })
      .getByRole("alert"),
  ).toContainText("не меньше 0,5 м");
  await expect(page.getByTestId("total-area")).toHaveText("15 м²");
  await page.getByLabel("Длина", { exact: true }).fill("3");
  await page
    .getByRole("button", { name: "Добавить комнату", exact: true })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("27 м²");
  await page.getByLabel("Координата X").fill("0");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  await expect(
    page
      .getByRole("region", { name: "Рабочая область редактора" })
      .getByRole("alert"),
  ).toContainText("пересекается");
  await expect(page.getByTestId("total-area")).toHaveText("27 м²");
  await page.getByRole("button", { name: "Удалить комнату" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("15 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("27 м²");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("15 м²");
  expect(errors).toEqual([]);
});

test("draw, select, drag and zoom on the actual canvas", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByTestId("plan-canvas").locator("canvas").first(),
  ).toBeVisible();
  await newPlan(page);
  await page
    .getByRole("button", { name: "Нарисовать комнату", exact: true })
    .click();
  await expect(page.getByTestId("zoom-value")).toHaveText("100%");
  const box = await page.getByTestId("plan-canvas").boundingBox();
  if (!box) throw new Error("Missing canvas bounds");
  const startX = box.x + box.width * 0.43,
    startY = box.y + box.height * 0.38;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 180, startY + 120, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("room-area")).toHaveText("6 м²");
  await page.getByRole("button", { name: "Выбрать", exact: true }).click();
  const oldX = Number(await page.getByLabel("Координата X").inputValue());
  await page.mouse.move(startX + 90, startY + 60);
  await page.mouse.down();
  await page.mouse.move(startX + 150, startY + 60, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByLabel("Координата X")).toHaveValue(
    String(Math.round((oldX + 1) * 10) / 10),
  );
  await expect(page.getByTestId("total-area")).toHaveText("6 м²");
  await page.getByRole("button", { name: "Увеличить масштаб" }).click();
  await expect(page.getByTestId("zoom-value")).toHaveText("115%");
  await page.getByRole("button", { name: "Настройки вида" }).click();
  await page.getByLabel("Сетка", { exact: true }).uncheck();
  await expect(page.getByLabel("Сетка", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Показать весь план" }).click();
});

test("small-screen layout remains usable without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Квартира на Садовой" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Ширина", { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Ширина", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "../../work/spaceplan-mobile.png",
    fullPage: true,
  });
});
