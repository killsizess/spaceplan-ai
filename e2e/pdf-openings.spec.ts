import { expect, test, type Page } from "@playwright/test";
import { settleCamera } from "./frames";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { openingPlanPdfFixture, WALL_PLAN_ORIGIN, WALL_PLAN_UNITS_PER_METRE } from "./pdf-fixture";

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

/** A project with the opening fixture as its calibrated underlay and its 7 walls accepted. */
async function projectWithWalls(page: Page) {
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Двери и окна из PDF");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await savedPlan(page);
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.getByLabel("Файл плана PDF", { exact: true }).setInputFiles({
    name: "Квартира-проёмы.pdf", mimeType: "application/pdf", buffer: openingPlanPdfFixture(),
  });
  const dialog = page.getByRole("dialog", { name: "Выберите страницу PDF" });
  await expect(page.getByTestId("pdf-preview")).toHaveAttribute("data-status", "ready");
  await dialog.getByRole("button", { name: "Использовать страницу" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-underlay-loaded", "true");
  const underlay = (await savedPlan(page)).underlay!;

  // Without a scale there is nothing to look for; and without walls there is nowhere to put an opening.
  const block = page.getByTestId("pdf-opening-suggestions");
  await expect(block).toBeVisible();
  await expect(block.getByRole("button", { name: "Предложить двери и окна" })).toBeDisabled();

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
  await expect(block.getByRole("button", { name: "Предложить двери и окна" })).toBeDisabled();
  await expect(block).toContainText("нет стен");

  // The window's glazing lines are not offered as a wall: 7 walls, with a gap at each opening.
  const walls = page.getByTestId("pdf-wall-suggestions");
  await walls.getByRole("button", { name: "Предложить стены" }).click();
  await expect(page.getByTestId("wall-suggestion-count")).toHaveText("7");
  await walls.getByRole("button", { name: "Добавить стены (7)" }).click();
  expect((await savedPlan(page)).walls).toHaveLength(7);
  return { block };
}

test("doors and windows found in a vector PDF are suggested, doubted when thin, and added in one step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { block } = await projectWithWalls(page);
  const walled = await savedPlan(page);
  const canvas = page.getByTestId("plan-canvas");

  await block.getByRole("button", { name: "Предложить двери и окна" }).click();
  await expect(page.getByTestId("opening-suggestion-count")).toHaveText("3");
  // Only the two sure ones start switched on; the bare gap is «неуверенно» and starts off.
  await expect(page.getByTestId("opening-suggestion-selected")).toHaveText("2");
  await expect(page.getByTestId("opening-suggestion-doubtful")).toHaveText("1");
  await expect(canvas).toHaveAttribute("data-opening-candidates", "3");
  await expect(canvas).toHaveAttribute("data-opening-candidates-selected", "2");
  // Suggestions are not part of the plan; dismissing changes nothing.
  expect(await savedPlan(page)).toEqual(walled);

  const doubtful = block.locator('li[data-confidence="low"]');
  await expect(doubtful).toHaveCount(1);
  await expect(doubtful).toContainText("неуверенно");
  await expect(doubtful.getByRole("checkbox")).not.toBeChecked();
  await doubtful.getByText("Почему").click();
  await expect(doubtful).toContainText("тип не определён");
  const sure = block.locator('li[data-confidence="high"]');
  await expect(sure).toHaveCount(2);
  await expect(block.locator('li[data-confidence="high"][data-kind="door"]')).toContainText("дуга открывания");
  await expect(block.locator('li[data-confidence="high"][data-kind="window"]')).toContainText("линии остекления");
  await block.getByRole("button", { name: "Отклонить" }).click();
  await expect(canvas).toHaveAttribute("data-opening-candidates", "0");
  expect(await savedPlan(page)).toEqual(walled);

  // Accept the two sure ones: two short walls close the gaps, the openings sit in them.
  await block.getByRole("button", { name: "Предложить двери и окна" }).click();
  await block.getByRole("button", { name: "Добавить проёмы (2)" }).click();
  const withTwo = await savedPlan(page);
  expect(withTwo.walls).toHaveLength(9);
  expect(withTwo.openings).toHaveLength(2);
  const door = withTwo.openings.find((item) => item.kind === "door")!;
  const window = withTwo.openings.find((item) => item.kind === "window")!;
  // The bottom-wall door: hinge at the start of the opening, opening into the room (towards −Y).
  expect(door.door).toEqual({ hinge: "start", side: "left" });
  expect(door.width).toBeCloseTo(0.9, 2);
  expect(door).toMatchObject({ offset: 0, height: 2.1, sillHeight: 0 });
  expect(window.width).toBeCloseTo(1.2, 2);
  expect(window).toMatchObject({ offset: 0, height: 1.2, sillHeight: 0.9 });
  expect(window).not.toHaveProperty("door");
  // Each opening is in a new wall that shares end points with its neighbours.
  const added = withTwo.walls.slice(7);
  expect(added.map((item) => item.id)).toEqual(expect.arrayContaining([door.wallId, window.wallId]));
  for (const piece of added) {
    const ends = [piece.start, piece.end];
    for (const end of ends) {
      expect(walled.walls.some((item) => [item.start, item.end].some((other) => Math.hypot(other.x - end.x, other.y - end.y) < 1e-9))).toBe(true);
    }
  }
  await expect(canvas).toHaveAttribute("data-opening-candidates", "0");

  // One undo step removes the two openings and both walls.
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await savedPlan(page)).toEqual(walled);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await savedPlan(page)).openings).toHaveLength(2);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();

  // The doubtful one can be switched on by the user, changed to a window, and all three close the room.
  await block.getByRole("button", { name: "Предложить двери и окна" }).click();
  await expect(page.getByTestId("opening-suggestion-selected")).toHaveText("2");
  await doubtful.getByRole("checkbox").check();
  await expect(page.getByTestId("opening-suggestion-selected")).toHaveText("3");
  await doubtful.getByLabel(/^Тип проёма/).selectOption("window");
  await expect(block.locator('li[data-confidence="low"]')).toHaveAttribute("data-kind", "window");
  await block.getByRole("button", { name: "Добавить проёмы (3)" }).click();
  const all = await savedPlan(page);
  expect(all.walls).toHaveLength(10);
  expect(all.openings.map((item) => item.kind).sort()).toEqual(["door", "window", "window"]);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await page.getByRole("button", { name: "Комнаты по стенам" }).click();
  await expect(page.getByTestId("room-count")).toHaveText("01");
  expect(errors).toEqual([]);
});

test("a click on a suggested opening on the plan switches it, and Accept adds only the chosen ones", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { block } = await projectWithWalls(page);
  const canvas = page.getByTestId("plan-canvas");
  await block.getByRole("button", { name: "Предложить двери и окна" }).click();
  await expect(page.getByTestId("opening-suggestion-count")).toHaveText("3");
  const points = JSON.parse((await canvas.getAttribute("data-opening-candidate-points"))!) as [number, number][];
  expect(points).toHaveLength(3);
  const selected = page.getByTestId("opening-suggestion-selected");

  await block.getByRole("button", { name: "Снять все" }).click();
  await expect(selected).toHaveText("0");
  await expect(block.getByRole("button", { name: "Добавить проёмы (0)" })).toBeDisabled();
  // Switch the first one on by clicking it on the plan.
  await clickWorld(page, ...points[0]);
  await expect(selected).toHaveText("1");
  await expect(canvas).toHaveAttribute("data-opening-candidates-selected", "1");
  await block.getByRole("button", { name: "Добавить проёмы (1)" }).click();
  const plan = await savedPlan(page);
  expect(plan.openings).toHaveLength(1);
  expect(plan.walls).toHaveLength(8);
  expect(errors).toEqual([]);
});

test("a plan without PDF lines offers no door and window suggestions", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await expect(page.getByTestId("pdf-opening-suggestions")).toHaveCount(0);
});
