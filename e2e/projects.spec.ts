import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  createEmptyPlan,
  createExamplePlan,
} from "../src/domain/floor-plan/operations";

async function saved(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveText(
    "Сохранено в браузере",
  );
}
async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill(name);
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await saved(page);
}
async function activeRecord(page: Page) {
  return page.evaluate(() => {
    const id = localStorage.getItem("spaceplan-ai:active-project:v1");
    return localStorage.getItem("spaceplan-ai:project:" + id);
  });
}

test("autosave restores edits after reload and preserves multiple projects", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await saved(page);
  await createProject(page, "Квартира А");
  await page.getByRole("button", { name: "Добавить первую комнату" }).click();
  await page.getByLabel("Ширина", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  await saved(page);
  await page.reload();
  await saved(page);
  await expect(
    page.getByRole("heading", { name: "Квартира А", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("15 м²");
  await createProject(page, "Квартира Б");
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Мои проекты/ })).toBeVisible();
  await page.screenshot({
    path: "../SpacePlan-AI-projects.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Открыть Квартира А", exact: true })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("15 м²");
  await expect(
    page.getByRole("button", { name: "Отменить", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("JSON download roundtrips as a separate project", async ({ page }) => {
  await page.goto("/");
  await saved(page);
  const original = await activeRecord(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.spaceplan\.json$/);
  const path = await download.path();
  if (!path || !original) throw new Error("Missing exported or stored file");
  const bytes = await readFile(path);
  const exported = JSON.parse(bytes.toString("utf8"));
  expect(exported).toEqual(JSON.parse(original).plan);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "copy.spaceplan.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await saved(page);
  await expect
    .poll(async () => {
      const current = await activeRecord(page);
      return current ? JSON.parse(current).plan.id : null;
    })
    .not.toBe(exported.id);
  await expect(page.getByTestId("total-area")).toHaveText("80 м²");
  const retained = await page.evaluate(
    (id) => localStorage.getItem("spaceplan-ai:project:" + id),
    exported.id,
  );
  expect(retained).toBe(original);
});

test("invalid, future-version, overlapping and oversized imports leave current data intact", async ({
  page,
}) => {
  await page.goto("/");
  await saved(page);
  const original = await activeRecord(page);
  const plan = createExamplePlan();
  const files = [
    { content: "{", message: "JSON" },
    {
      content: JSON.stringify({ ...plan, schemaVersion: 12 }),
      message: "Версия формата",
    },
    {
      content: JSON.stringify({
        ...plan,
        rooms: [...plan.rooms, { ...plan.rooms[0], id: "overlap" }],
      }),
      message: "пересек",
    },
    { content: " ".repeat(4 * 1024 * 1024 + 1), message: "слишком большой" },
  ];
  for (const file of files) {
    await page.getByLabel("Файл проекта JSON").setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from(file.content),
    });
    await expect(page.getByTestId("project-notice")).toContainText(
      file.message,
    );
    await expect(page.getByTestId("total-area")).toHaveText("80 м²");
    expect(await activeRecord(page)).toBe(original);
    await page.getByRole("button", { name: "Закрыть сообщение" }).click();
  }
});

test("quota failure keeps last saved version and working edits until retry", async ({
  page,
}) => {
  await page.goto("/");
  await saved(page);
  const original = await activeRecord(page);
  await page.evaluate(() => {
    const target = window as Window & { spaceplanQuota?: boolean };
    target.spaceplanQuota = true;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (target.spaceplanQuota && key.startsWith("spaceplan-ai:project:"))
        throw new DOMException("Full", "QuotaExceededError");
      return originalSet.call(this, key, value);
    };
  });
  await page.getByLabel("Ширина", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  await expect(page.getByTestId("save-status")).toHaveText("Не сохранено");
  await expect(page.getByTestId("total-area")).toHaveText("72 м²");
  expect(await activeRecord(page)).toBe(original);
  await page.evaluate(() => {
    (window as Window & { spaceplanQuota?: boolean }).spaceplanQuota = false;
  });
  await page.getByRole("button", { name: "Повторить сохранение" }).click();
  await saved(page);
  await page.reload();
  await saved(page);
  await expect(page.getByTestId("total-area")).toHaveText("72 м²");
});

test("simultaneous tabs detect conflicts and preserve both versions as separate projects", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await saved(page);
  const other = await context.newPage();
  await other.goto("/");
  await saved(other);
  await page.getByLabel("Ширина", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  await saved(page);
  await expect(other.getByTestId("save-status")).toHaveText("Конфликт версий");
  await other.getByLabel("Ширина", { exact: true }).fill("3");
  await other.getByRole("button", { name: "Применить изменения" }).click();
  await expect(other.getByTestId("total-area")).toHaveText("72 м²");
  await other
    .getByRole("button", { name: "Сохранить копию", exact: true })
    .click();
  await saved(other);
  await expect(
    other.getByRole("heading", {
      name: "Квартира на Садовой — копия",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("76 м²");
  const widths = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("spaceplan-ai:project:"))
      .map((key) => JSON.parse(localStorage.getItem(key)!).plan.rooms[0].width)
      .sort(),
  );
  expect(widths).toEqual([3, 4]);
  await other.close();
});

test("corrupted saved records are retained and reported in the library", async ({
  page,
}) => {
  const valid = {
    storageVersion: 1,
    revision: "r1",
    updatedAt: "2026-10-19T00:00:00.000Z",
    plan: { ...createEmptyPlan("valid"), name: "Исправный проект" },
  };
  await page.addInitScript((record) => {
    localStorage.setItem("spaceplan-ai:project:broken", "{");
    localStorage.setItem("spaceplan-ai:project:valid", JSON.stringify(record));
    localStorage.setItem("spaceplan-ai:active-project:v1", "broken");
  }, valid);
  await page.goto("/");
  await saved(page);
  await expect(
    page.getByRole("heading", { name: "Исправный проект", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Не удалось прочитать записей: 1",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("spaceplan-ai:project:broken"),
    ),
  ).toBe("{");
});
