import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { settleCamera } from "./frames";
import type { FloorPlan } from "../src/domain/floor-plan/types";

async function saved(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveText(
    "Сохранено в браузере",
  );
}
async function plan(page: Page): Promise<FloorPlan> {
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem(
          "spaceplan-ai:project:" +
            localStorage.getItem("spaceplan-ai:active-project:v1"),
        )!,
      ).plan as FloorPlan,
  );
}
async function emptyPlan(page: Page) {
  await page.goto("/");
  await saved(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("План по чертежу");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await expect(
    page.getByRole("heading", { name: "План по чертежу", exact: true }),
  ).toBeVisible();
  await saved(page);
}
async function screenPoint(page: Page, x: number, y: number) {
  await settleCamera(page);
  const canvas = page.getByTestId("plan-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing canvas");
  const transform = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")),
    y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  return {
    x: box.x + transform.x + x * transform.scale,
    y: box.y + transform.y + y * transform.scale,
  };
}
async function clickWorld(page: Page, x: number, y: number) {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function wall(
  page: Page,
  start: [number, number],
  end: [number, number],
) {
  await page
    .getByRole("button", { name: "Нарисовать стену", exact: true })
    .click();
  const a = await screenPoint(page, ...start),
    b = await screenPoint(page, ...end);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await saved(page);
}
async function imageFixture(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fffdf8";
    ctx.fillRect(0, 0, 800, 600);
    ctx.strokeStyle = "#7f877c";
    ctx.lineWidth = 6;
    ctx.strokeRect(80, 80, 640, 440);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(400, 80);
    ctx.lineTo(400, 520);
    ctx.moveTo(400, 310);
    ctx.lineTo(720, 310);
    ctx.stroke();
    ctx.fillStyle = "#858c80";
    ctx.font = "20px Arial";
    ctx.fillText("6,40 м", 355, 55);
    ctx.font = "16px Arial";
    ctx.fillText("ГОСТИНАЯ", 195, 300);
    ctx.fillText("СПАЛЬНЯ", 515, 190);
    ctx.fillText("КУХНЯ", 530, 425);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(data, "base64");
}
async function upload(page: Page) {
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.getByLabel("Изображение плана JPG или PNG").setInputFiles({
    name: "Квартира.png",
    mimeType: "image/png",
    buffer: await imageFixture(page),
  });
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-underlay-loaded",
    "true",
  );
  await expect(
    page.getByText("Масштаб ещё не настроен", { exact: true }),
  ).toBeVisible();
  await saved(page);
}

test("trace a raster at calibrated scale, edit openings, persist and export everything", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await emptyPlan(page);
  await upload(page);
  await clickWorld(page, 1, 1);
  await clickWorld(page, 9, 1);
  await expect(
    page.getByRole("dialog", { name: "Укажите известный размер" }),
  ).toBeVisible();
  await page.getByLabel("Известная длина, м").fill("0");
  await page.getByRole("button", { name: "Применить масштаб" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "от 0,1 до 100",
  );
  await page.getByLabel("Известная длина, м").fill("6,4");
  await page.getByRole("button", { name: "Применить масштаб" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await saved(page);
  expect((await plan(page)).underlay?.metersPerPixel).toBeCloseTo(0.01, 5);
  await wall(page, [1, 1], [7.4, 1]);
  await wall(page, [7.4, 1], [7.4, 5.4]);
  expect((await plan(page)).walls).toHaveLength(2);
  await page
    .getByRole("button", { name: "Добавить дверь", exact: true })
    .click();
  await clickWorld(page, 3, 1);
  await saved(page);
  await expect(page.getByLabel("Ширина проёма")).toHaveValue("0.9");
  await page.getByLabel("Ширина проёма").fill("1");
  await page.getByRole("button", { name: "Применить свойства" }).click();
  await saved(page);
  await page
    .getByRole("button", { name: "Добавить окно", exact: true })
    .click();
  await clickWorld(page, 7.4, 3.2);
  await saved(page);
  await expect(page.getByLabel("Высота от пола")).toHaveValue("0.9");
  await page.getByLabel("Ширина проёма").fill("50");
  await page.getByRole("button", { name: "Применить свойства" }).click();
  await expect(
    page
      .getByRole("region", { name: "Рабочая область редактора" })
      .getByRole("alert"),
  ).toContainText("границ");
  expect((await plan(page)).openings[1].width).toBe(1.2);
  await page
    .getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await page.getByLabel("Толщина стены").fill("0.25");
  await page.getByRole("button", { name: "Применить свойства" }).click();
  await saved(page);
  await page
    .getByRole("button", { name: "Удалить стену", exact: true })
    .click();
  await saved(page);
  expect((await plan(page)).walls).toHaveLength(1);
  expect((await plan(page)).openings).toHaveLength(1);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await saved(page);
  expect((await plan(page)).walls).toHaveLength(2);
  expect((await plan(page)).openings).toHaveLength(2);
  await page.getByRole("button", { name: "Выбрать", exact: true }).click();
  await page
    .getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await page.screenshot({
    path: "../SpacePlan-AI-construction.png",
    fullPage: true,
  });
  const original = await plan(page);
  await page.reload();
  await saved(page);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-underlay-loaded",
    "true",
  );
  expect(await plan(page)).toEqual(original);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise,
    path = await download.path();
  if (!path) throw new Error("Missing download");
  const bytes = await readFile(path);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(original);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "trace.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect.poll(async () => (await plan(page)).id).not.toBe(original.id);
  await saved(page);
  const imported = await plan(page);
  expect({ ...imported, id: original.id }).toEqual(original);
  expect(errors).toEqual([]);
});

test("underlay visibility, move, removal and undo preserve geometry", async ({
  page,
}) => {
  await emptyPlan(page);
  await upload(page);
  await page.getByRole("button", { name: "Выбрать", exact: true }).click();
  const before = (await plan(page)).underlay!;
  await page.getByRole("button", { name: "Сдвинуть", exact: true }).click();
  const a = await screenPoint(page, 4, 3),
    b = await screenPoint(page, 5, 3.5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  expect((await plan(page)).underlay?.x).toBeCloseTo(before.x + 1, 1);
  await page.getByLabel("Показывать подложку").uncheck();
  await saved(page);
  expect((await plan(page)).underlay?.visible).toBe(false);
  await page.getByLabel("Показывать подложку").check();
  await saved(page);
  await page
    .getByRole("button", { name: "Удалить подложку", exact: true })
    .click();
  await saved(page);
  expect((await plan(page)).underlay).toBeUndefined();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await saved(page);
  expect((await plan(page)).underlay?.dataUrl).toBe(before.dataUrl);
});

test("bad images are rejected without changing current plan; source controls fit mobile", async ({
  page,
}) => {
  await emptyPlan(page);
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  const original = await plan(page);
  for (const file of [
    { name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not png") },
    {
      name: "huge.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.alloc(12 * 1024 * 1024 + 1),
    },
  ]) {
    await page.getByLabel("Изображение плана JPG или PNG").setInputFiles(file);
    await expect(page.getByTestId("project-notice")).toBeVisible();
    expect(await plan(page)).toEqual(original);
    await page.getByRole("button", { name: "Закрыть сообщение" }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await upload(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Масштаб", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../work/spaceplan-source-mobile.png",
    fullPage: true,
  });
});

test("old version one projects restore and upgrade on first edit", async ({
  page,
}) => {
  const old = {
    schemaVersion: 1,
    unit: "m",
    id: "legacy",
    name: "Старый проект",
    rooms: [],
    walls: [],
    openings: [],
  };
  await page.addInitScript((value) => {
    localStorage.setItem(
      "spaceplan-ai:project:legacy",
      JSON.stringify({
        storageVersion: 1,
        revision: "old",
        updatedAt: "2026-10-19T00:00:00.000Z",
        plan: value,
      }),
    );
    localStorage.setItem("spaceplan-ai:active-project:v1", "legacy");
  }, old);
  await page.goto("/");
  await saved(page);
  await expect(
    page.getByRole("heading", { name: "Старый проект", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Добавить первую комнату", exact: true })
    .click();
  await saved(page);
  expect((await plan(page)).schemaVersion).toBe(10);
  expect((await plan(page)).rooms).toHaveLength(1);
});

test("mismatched raster metadata is reported and can be repaired without overwriting the original", async ({
  page,
}) => {
  await emptyPlan(page);
  await upload(page);
  const original = await plan(page);
  if (!original.underlay) throw new Error("Missing source image");
  const malformed = {
    ...original,
    underlay: {
      ...original.underlay,
      pixelWidth: original.underlay.pixelWidth + 1,
    },
  };
  await page
    .getByLabel("Файл проекта JSON")
    .setInputFiles({
      name: "bad-image-metadata.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(malformed)),
    });
  await expect(page.getByTestId("project-notice")).toContainText(
    "Размеры изображения не совпадают",
  );
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-underlay-loaded",
    "false",
  );
  const retained = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("spaceplan-ai:project:" + id)!).plan,
    original.id,
  );
  expect(retained).toEqual(original);
  await upload(page);
  expect((await plan(page)).underlay?.pixelWidth).toBe(800);
});
