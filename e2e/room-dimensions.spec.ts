import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

interface InternalDimension {
  id: string;
  width: number;
  depth: number;
  mode: "lines" | "compact";
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText(
    "Сохранено в браузере",
  );
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

async function savedRecord(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(
    () =>
      localStorage.getItem(
        "spaceplan-ai:project:" +
          localStorage.getItem("spaceplan-ai:active-project:v1"),
      )!,
  );
}

async function internalDimensions(page: Page): Promise<InternalDimension[]> {
  return JSON.parse(
    (await page.getByTestId("plan-canvas").getAttribute(
      "data-internal-dimensions",
    )) ?? "null",
  ) as InternalDimension[];
}

async function expectDimensions(
  page: Page,
  width: number,
  depth: number,
  mode: InternalDimension["mode"] = "lines",
) {
  await expect.poll(async () => internalDimensions(page)).toEqual([
    {
      id: expect.any(String),
      width: expect.closeTo(width, 10),
      depth: expect.closeTo(depth, 10),
      mode,
    },
  ]);
}

async function objectCanvasPixels(page: Page): Promise<string> {
  // Read the actual Konva object layer, not a duplicate DOM description.
  return page.getByTestId("plan-canvas").locator("canvas").last().evaluate(
    async (canvas) => {
      if (!(canvas instanceof HTMLCanvasElement))
        throw new Error("Missing Konva canvas element");
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return canvas.toDataURL();
    },
  );
}

async function createMeasuredRoom(page: Page): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Внутренние размеры комнаты");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await page.getByRole("button", { name: "Комната со стенами", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Прямоугольная комната" });
  await dialog.getByLabel("Внутренняя ширина", { exact: true }).fill("5");
  await dialog.getByLabel("Внутренняя глубина", { exact: true }).fill("4");
  await dialog.getByRole("button", { name: "Создать комнату со стенами" })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  await expect(page.getByTestId("wall-room-area")).toHaveText("20 м²");
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  return saved(page);
}

async function importPlan(page: Page, plan: FloorPlan): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "room-dimensions.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  return saved(page);
}

function outline(points: readonly { x: number; y: number }[]): Wall[] {
  return points.map((start, index) => ({
    id: `boundary-${index}`,
    start,
    end: points[(index + 1) % points.length],
    thickness: 0.2,
    height: 2.7,
  }));
}

function interiorRectangle(): FloorPlan {
  return {
    ...createEmptyPlan("internal-dimensions"),
    name: "Внутренние размеры 5 × 4",
    roomMode: "walls",
    walls: outline([
      { x: -0.1, y: -0.1 },
      { x: 5.1, y: -0.1 },
      { x: 5.1, y: 4.1 },
      { x: -0.1, y: 4.1 },
    ]),
  };
}

async function zoomOutTo(page: Page, maximumScale: number) {
  const canvas = page.getByTestId("plan-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  for (let attempt = 0; attempt < 40; attempt++) {
    const scale = Number(await canvas.getAttribute("data-scale"));
    if (scale <= maximumScale) return;
    await page.mouse.wheel(0, 100);
    await expect.poll(async () =>
      Number(await canvas.getAttribute("data-scale")),
    ).toBeLessThan(scale);
  }
  throw new Error("Zoom did not reach the requested scale");
}

test("internal dimensions show usable 5 × 4 m, update after resizing and undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await createMeasuredRoom(page);
  await expectDimensions(page, 5, 4);
  await expect(page.getByRole("list", { name: "Внутренние размеры помещений" }))
    .toContainText("5 × 4 м внутри");
  const wallLengths = original.walls.map((wall) =>
    Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y),
  );
  // Physical wall axes are longer than the usable interior dimensions.
  expect(wallLengths[0]).toBeCloseTo(5.2, 10);
  expect(wallLengths[1]).toBeCloseTo(4.2, 10);
  await page.screenshot({
    path: "../SpacePlan-AI-dimensions.png",
    fullPage: true,
  });
  await page.getByLabel("Внутренняя ширина", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Изменить размеры комнаты" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("24 м²");
  await expectDimensions(page, 6, 4);
  await expect(page.getByRole("list", { name: "Внутренние размеры помещений" }))
    .toContainText("6 × 4 м внутри");
  const enlarged = await saved(page);
  expect(enlarged.walls[0].end.x - enlarged.walls[0].start.x)
    .toBeCloseTo(6.2, 10);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByTestId("total-area")).toHaveText("20 м²");
  await expectDimensions(page, 5, 4);
  await page.reload();
  await expectDimensions(page, 5, 4);
  await expect.poll(async () => saved(page)).toEqual(original);
  expect(errors).toEqual([]);
});

test("dimension visibility changes actual pixels and camera controls leave saves and history intact", async ({
  page,
}) => {
  const original = await importPlan(page, interiorRectangle());
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await expectDimensions(page, 5, 4);
  const record = await savedRecord(page);
  const pixelsWithDimensions = await objectCanvasPixels(page);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  await page.getByLabel("Размеры комнат", { exact: true }).uncheck();
  await expect.poll(async () => internalDimensions(page)).toEqual([]);
  expect(await objectCanvasPixels(page)).not.toBe(pixelsWithDimensions);
  await page.getByLabel("Размеры комнат", { exact: true }).check();
  await expectDimensions(page, 5, 4);
  expect(await objectCanvasPixels(page)).toBe(pixelsWithDimensions);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  const canvas = page.getByTestId("plan-canvas");
  const initialScale = Number(await canvas.getAttribute("data-scale"));
  await page.getByRole("button", { name: "Увеличить масштаб", exact: true })
    .click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-scale")))
    .toBeGreaterThan(initialScale);
  await expectDimensions(page, 5, 4);
  await page.getByRole("button", { name: "Перемещать вид", exact: true }).click();
  const cameraX = Number(await canvas.getAttribute("data-camera-x"));
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const point = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2,
  };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await canvas.getAttribute("data-camera-x")))
    .toBeCloseTo(cameraX + 40, 5);
  await expectDimensions(page, 5, 4);
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true }))
    .toBeDisabled();
});

test("390 px view stays within the screen and dimensions compact then hide at low zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page, interiorRectangle());
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await expectDimensions(page, 5, 4);
  const record = await savedRecord(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await zoomOutTo(page, 27);
  await expectDimensions(page, 5, 4, "compact");
  await objectCanvasPixels(page);
  await page.screenshot({
    path: "../../work/spaceplan-dimensions-compact-mobile.png",
    fullPage: false,
  });
  await expectDimensions(page, 5, 4, "compact");
  expect(Number(await page.getByTestId("plan-canvas").getAttribute("data-scale")))
    .toBeLessThanOrEqual(27);
  await zoomOutTo(page, 19);
  await expect.poll(async () => internalDimensions(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
});

test("concave rooms and rooms with holes never show bounding boxes as internal dimensions", async ({
  page,
}) => {
  const concave: FloorPlan = {
    ...createEmptyPlan("concave-dimensions"),
    name: "Непрямоугольное помещение",
    roomMode: "walls",
    walls: outline([
      { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 },
      { x: 3, y: 3 }, { x: 3, y: 6 }, { x: 0, y: 6 },
    ]),
  };
  const withHole = interiorRectangle();
  withHole.name = "Помещение с опорой";
  withHole.walls.push({
    id: "column",
    start: { x: 2, y: 2 },
    end: { x: 3, y: 2 },
    thickness: 0.4,
    height: 2.7,
  });
  for (const plan of [concave, withHole]) {
    await test.step(plan.name, async () => {
      await importPlan(page, plan);
      await expect(page.getByTestId("room-count")).toHaveText("01");
      await expect(page.getByTestId("plan-canvas"))
        .toHaveAttribute("data-wall-room-count", "1");
      await expect.poll(async () => internalDimensions(page)).toEqual([]);
      const area = plan === concave ? "24,65 м²" : "19,6 м²";
      await expect(page.getByTestId("total-area")).toHaveText(area);
    });
  }
});
