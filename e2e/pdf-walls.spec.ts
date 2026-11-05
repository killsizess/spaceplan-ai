import { expect, test, type Page } from "@playwright/test";
import { settleCamera } from "./frames";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { WALL_PLAN_ORIGIN, WALL_PLAN_UNITS_PER_METRE, wallPlanPdfFixture } from "./pdf-fixture";

async function savedPlan(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem(
          "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
        )!,
      ).plan as FloorPlan,
  );
}

async function clickWorld(page: Page, x: number, y: number) {
  await settleCamera(page);
  const canvas = page.getByTestId("plan-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing canvas");
  const view = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")),
    y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  await page.mouse.click(box.x + view.x + x * view.scale, box.y + view.y + y * view.scale);
}

test("walls found in a vector PDF are suggested, shown, accepted in one step and form rooms", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Стены из PDF");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await savedPlan(page);

  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.getByLabel("Файл плана PDF", { exact: true }).setInputFiles({
    name: "Квартира-стены.pdf",
    mimeType: "application/pdf",
    buffer: wallPlanPdfFixture(),
  });
  const dialog = page.getByRole("dialog", { name: "Выберите страницу PDF" });
  await expect(page.getByTestId("pdf-preview")).toHaveAttribute("data-status", "ready");
  await dialog.getByRole("button", { name: "Использовать страницу" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-underlay-loaded", "true");
  const imported = await savedPlan(page);
  const underlay = imported.underlay!;

  // The block appears for the PDF page; walls need a real scale first.
  const block = page.getByTestId("pdf-wall-suggestions");
  await expect(block).toContainText("векторных линий");
  await expect(block.getByRole("button", { name: "Предложить стены" })).toBeDisabled();

  // Calibrate on the outer face of the bottom wall: 10.2 m between its ends.
  const world = (pdfX: number, pdfY: number) => ({
    x: underlay.x + (pdfX / 600) * underlay.pixelWidth * underlay.metersPerPixel,
    y: underlay.y + ((400 - pdfY) / 400) * underlay.pixelHeight * underlay.metersPerPixel,
  });
  const faceY = WALL_PLAN_ORIGIN - 0.1 * WALL_PLAN_UNITS_PER_METRE;
  const left = world(WALL_PLAN_ORIGIN - 0.1 * WALL_PLAN_UNITS_PER_METRE, faceY);
  const right = world(WALL_PLAN_ORIGIN + 10.1 * WALL_PLAN_UNITS_PER_METRE, faceY);
  await clickWorld(page, left.x, left.y);
  await clickWorld(page, right.x, right.y);
  await page.getByLabel("Известная длина, м").fill("10,2");
  await page.getByRole("button", { name: "Применить масштаб" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calibrated = await savedPlan(page);
  expect(calibrated.underlay?.calibrated).toBe(true);
  expect(calibrated.walls).toEqual([]);

  await block.getByRole("button", { name: "Предложить стены" }).click();
  // Exterior walls split at the partition and the branch, partition split at the branch.
  await expect(page.getByTestId("wall-suggestion-count")).toHaveText("10");
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-wall-candidates", "10");
  // Suggestions are not part of the plan until accepted; dismissing changes nothing.
  expect((await savedPlan(page)).walls).toEqual([]);
  await block.getByRole("button", { name: "Отклонить" }).click();
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-wall-candidates", "0");
  expect(await savedPlan(page)).toEqual(calibrated);
  await block.getByRole("button", { name: "Предложить стены" }).click();
  await expect(page.getByTestId("wall-suggestion-count")).toHaveText("10");

  // Each suggestion can be switched off in the list or by a click on the plan.
  const canvas = page.getByTestId("plan-canvas");
  const selectedCount = page.getByTestId("wall-suggestion-selected");
  await block.getByRole("checkbox", { name: /^Стена 1\b/ }).uncheck();
  await expect(selectedCount).toHaveText("9");
  await expect(canvas).toHaveAttribute("data-wall-candidates-selected", "9");
  const points = JSON.parse((await canvas.getAttribute("data-wall-candidate-points"))!) as [number, number][];
  await clickWorld(page, ...points[0]);
  await expect(selectedCount).toHaveText("10");
  await expect(block.getByRole("checkbox", { name: /^Стена 1\b/ })).toBeChecked();
  await block.getByRole("button", { name: "Снять все" }).click();
  await expect(selectedCount).toHaveText("0");
  await expect(block.getByRole("button", { name: "Добавить стены (0)" })).toBeDisabled();
  await block.getByRole("button", { name: "Выбрать все" }).click();
  await expect(selectedCount).toHaveText("10");

  // Only the selected walls are added, still as one step.
  await clickWorld(page, ...points[3]);
  await expect(selectedCount).toHaveText("9");
  await block.getByRole("button", { name: "Добавить стены (9)" }).click();
  expect((await savedPlan(page)).walls).toHaveLength(9);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await savedPlan(page)).walls).toEqual([]);

  await block.getByRole("button", { name: "Предложить стены" }).click();
  await expect(selectedCount).toHaveText("10");
  await block.getByRole("button", { name: "Добавить стены (10)" }).click();
  const withWalls = await savedPlan(page);
  expect(withWalls.walls).toHaveLength(10);
  for (const wall of withWalls.walls) expect(wall.thickness).toBeCloseTo(0.2, 2);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-wall-candidates", "0");
  await expect(block.getByRole("button", { name: "Предложить стены" })).toBeVisible();

  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await page.getByRole("button", { name: "Комнаты по стенам" }).click();
  await expect(page.getByTestId("room-count")).toHaveText("03");
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-wall-room-count", "3");

  // Undo the room mode, then the accepted walls: one step for all ten.
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await savedPlan(page)).walls).toEqual([]);
  expect(errors).toEqual([]);
});

test("plans without lines from a PDF page offer no wall suggestions", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  // The example plan has no PDF lines: no block.
  await expect(page.getByTestId("pdf-wall-suggestions")).toHaveCount(0);
});
