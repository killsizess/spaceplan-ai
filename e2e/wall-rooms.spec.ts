import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";
import { PerspectiveCamera, Vector3 } from "three";
import { fitPlan, settleCamera, settleFrames } from "./frames";

const wall = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.2,
  height: 2.7,
});
function enclosedPlan(): FloorPlan {
  return {
    ...createEmptyPlan("closed"),
    name: "Комнаты из стен",
    rooms: [
      {
        id: "manual",
        name: "Ручная комната",
        kind: "other",
        color: "#dfe8df",
        x: 20,
        y: 20,
        width: 4,
        height: 3,
      },
    ],
    walls: [
      wall("top", 0, 0, 5, 0),
      wall("right", 5, 0, 5, 4),
      wall("bottom", 5, 4, 0, 4),
      wall("left", 0, 4, 0, 0),
    ],
  };
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
async function importPlan(page: Page, plan: FloorPlan) {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "rooms.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(
    page.getByRole("heading", { name: plan.name, exact: true }),
  ).toBeVisible();
  await saved(page);
}
async function worldClick(page: Page, x: number, y: number) {
  await settleCamera(page);
  const canvas = page.getByTestId("plan-canvas");
  const box = await canvas.boundingBox();
  const transform = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")),
    y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  await page.mouse.click(
    box!.x + transform.x + x * transform.scale,
    box!.y + transform.y + y * transform.scale,
  );
}

test("wall rooms show true internal area, select in 2D/3D and persist the chosen mode", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = enclosedPlan();
  // Valid imported IDs must not collide with derived rooms in selection/raycasting.
  // The room key comes from its boundary wall IDs, so a window takes the key here.
  original.openings.push({
    id: detectWallRooms(original.walls).rooms[0].id,
    wallId: "top",
    kind: "window",
    offset: 1,
    width: 1.2,
    height: 1.2,
    sillHeight: 0.9,
  });
  await importPlan(page, original);
  await expect(page.getByTestId("total-area")).toHaveText("12 м²");
  await page
    .getByRole("button", { name: "Комнаты по стенам", exact: true })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-wall-room-count",
    "1",
  );
  await fitPlan(page);
  await worldClick(page, 2, 2);
  await expect(page.getByTestId("wall-room-area")).toHaveText("18,24 м²");
  await expect(page.getByTestId("wall-room-perimeter")).toHaveText("17,2 м");
  const stored = await saved(page);
  expect(stored.schemaVersion).toBe(11);
  expect(stored.roomMode).toBe("walls");
  expect(stored.rooms).toEqual(original.rooms);
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-wall-room-count", "1");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await settleFrames(page);
  await expect(viewer).toHaveAttribute("data-camera-position", /,/);
  const box = await viewer.boundingBox();
  const position = (await viewer.getAttribute("data-camera-position"))!
    .split(",")
    .map(Number);
  const camera = new PerspectiveCamera(
    42,
    box!.width / box!.height,
    0.01,
    1000,
  );
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(2.5, (2.7 - 0.06) / 2, 2);
  camera.updateMatrixWorld();
  const point = new Vector3(2, 0, 2).project(camera);
  await page.mouse.click(
    box!.x + ((point.x + 1) * box!.width) / 2,
    box!.y + ((1 - point.y) * box!.height) / 2,
  );
  await expect(page.getByTestId("wall-room-area")).toHaveText("18,24 м²");
  await viewer.focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("project-notice")).toContainText(
    "определяется стенами",
  );
  expect((await saved(page)).walls).toHaveLength(4);
  await page.getByRole("button", { name: "Закрыть сообщение" }).click();
  await page.getByRole("button", { name: "Вписать 3D-план" }).click();
  await page.screenshot({
    path: "../SpacePlan-AI-wall-rooms-3D.png",
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Комнаты по стенам" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);
  expect(JSON.parse(bytes.toString()).roomMode).toBe("walls");
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "saved.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect.poll(async () => (await saved(page)).id).not.toBe(stored.id);
  expect((await saved(page)).rooms).toEqual(original.rooms);
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await page
    .getByRole("button", { name: "Ручные комнаты", exact: true })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("12 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  expect(errors).toEqual([]);
});

test("changing thickness, removing a partition and opening a boundary update derived rooms and undo", async ({
  page,
}) => {
  const original = enclosedPlan();
  original.roomMode = "walls";
  original.walls.push(wall("divider", 0, 2, 5, 2));
  original.openings.push({
    id: "door",
    wallId: "divider",
    kind: "door",
    offset: 1,
    width: 0.9,
    height: 2.1,
    sillHeight: 0,
  });
  await importPlan(page, original);
  await expect(page.getByTestId("room-count")).toHaveText("02");
  await expect(page.getByTestId("total-area")).toHaveText("17,28 м²");
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page
    .getByRole("button", { name: "Выбрать стену 5", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Удалить стену", exact: true })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  expect((await saved(page)).openings).toHaveLength(0);
  await page
    .getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await page.getByLabel("Толщина стены", { exact: true }).fill("0.4");
  await page.getByRole("button", { name: "Применить свойства" }).click();
  await expect(page.getByTestId("total-area")).toHaveText("17,76 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("17,28 м²");
  await page
    .getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Удалить стену", exact: true })
    .click();
  await expect(page.getByTestId("total-area")).toHaveText("8,64 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("17,28 м²");
});

test("column holes remain outside area and mobile source controls fit", async ({
  page,
}) => {
  const original = enclosedPlan();
  original.roomMode = "walls";
  original.walls.push({ ...wall("column", 2, 2, 3, 2), thickness: 0.4 });
  await importPlan(page, original);
  await expect(page.getByTestId("total-area")).toHaveText("17,84 м²");
  await worldClick(page, 1, 1);
  await expect(page.getByTestId("wall-room-area")).toHaveText("17,84 м²");
  await expect(page.getByTestId("wall-room-perimeter")).toHaveText("20 м");
  await page.screenshot({
    path: "../SpacePlan-AI-wall-rooms.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Комнаты по стенам" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Комнаты по стенам" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../work/spaceplan-wall-rooms-mobile.png",
    fullPage: true,
  });
});

test("drawing closed walls creates rooms without manual rectangles", async ({
  page,
}) => {
  await page.goto("/");
  await saved(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Обводка помещений");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await page
    .getByRole("button", { name: "Комнаты по стенам", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать обводку стен", exact: true })
    .click();
  const drawWall = async (x1: number, y1: number, x2: number, y2: number) => {
    await settleCamera(page);
    await settleCamera(page);
    const canvas = page.getByTestId("plan-canvas");
    const box = await canvas.boundingBox();
    const transform = await canvas.evaluate((node) => ({
      x: Number(node.getAttribute("data-camera-x")),
      y: Number(node.getAttribute("data-camera-y")),
      scale: Number(node.getAttribute("data-scale")),
    }));
    await page.mouse.move(
      box!.x + transform.x + x1 * transform.scale,
      box!.y + transform.y + y1 * transform.scale,
    );
    await page.mouse.down();
    await page.mouse.move(
      box!.x + transform.x + x2 * transform.scale,
      box!.y + transform.y + y2 * transform.scale,
      { steps: 8 },
    );
    await page.mouse.up();
  };
  await drawWall(-2, -2, 2, -2);
  await drawWall(2, -2, 2, 2);
  await drawWall(2, 2, -2, 2);
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await drawWall(-2, 2, -2, -2);
  await expect(page.getByTestId("total-area")).toHaveText("14,44 м²");
  expect((await saved(page)).rooms).toHaveLength(0);
  await drawWall(0, -2, 0, 2);
  await expect(page.getByTestId("total-area")).toHaveText("13,68 м²");
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(page.getByTestId("room-count")).toHaveText("02");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("14,44 м²");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("13,68 м²");
});
