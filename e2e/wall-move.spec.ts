import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Opening, Wall } from "../src/domain/floor-plan/types";
import { settleFrames } from "./frames";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.2,
  height: 2.7,
});
const door = (id: string, wallId: string, offset: number): Opening => ({
  id, wallId, kind: "door", offset, width: 0.9, height: 2.1, sillHeight: 0,
});

/** The partition rests on the outer walls; the branch rests on the partition and the right wall. */
function apartment(): FloorPlan {
  return {
    ...createEmptyPlan("wall-move"),
    name: "Перенос стены",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0),
      wall("right", 10, 0, 10, 6),
      wall("bottom", 10, 6, 0, 6),
      wall("left", 0, 6, 0, 0),
      wall("partition", 6, 0, 6, 6),
      wall("branch", 6, 3, 10, 3),
      wall("stub", 3, 6, 3, 4.5),
    ],
    openings: [door("door-partition", "partition", 1), door("door-branch", "branch", 1)],
  };
}

/** The partition moved by dx along x, with the branch start and its door kept in place. */
function moved(plan: FloorPlan, dx: number): FloorPlan {
  return {
    ...plan,
    walls: plan.walls.map((item) =>
      item.id === "partition" ? wall("partition", 6 + dx, 0, 6 + dx, 6) :
        item.id === "branch" ? wall("branch", 6 + dx, 3, 10, 3) : item,
    ),
    openings: plan.openings.map((item) => item.id === "door-branch" ? { ...item, offset: 1 - dx } : item),
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function savedRecord(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(() => localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!);
}

/** Offsets are recomputed in floating point; compare them to a nanometre. */
function rounded(plan: FloorPlan): FloorPlan {
  return {
    ...plan,
    walls: plan.walls.map((item) => ({
      ...item,
      start: { x: Math.round(item.start.x * 1e9) / 1e9, y: Math.round(item.start.y * 1e9) / 1e9 },
      end: { x: Math.round(item.end.x * 1e9) / 1e9, y: Math.round(item.end.y * 1e9) / 1e9 },
    })),
    openings: plan.openings.map((item) => ({ ...item, offset: Math.round(item.offset * 1e9) / 1e9 })),
  };
}

async function expectSavedPlan(page: Page, plan: FloorPlan) {
  await expect.poll(async () => rounded(await saved(page))).toEqual(rounded(plan));
}

async function importPlan(page: Page) {
  const fixture = apartment();
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "wall-move.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  await expect(page.getByTestId("room-count")).toHaveText("03");
  await expect(page.getByTestId("total-area")).toHaveText("54,64 м²");
  const plan = await saved(page);
  expect(plan.walls).toEqual(fixture.walls);
  return plan;
}

async function selectPartition(page: Page) {
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
  await page.getByRole("button", { name: "Показать весь план", exact: true }).click();
  // The camera moves on the next frame; a point read before that is off the wall.
  await settleFrames(page);
  await expect(page.getByLabel("Начало X", { exact: true })).toBeVisible();
}

async function screenPoint(page: Page, point: { x: number; y: number }) {
  const canvas = page.getByTestId("plan-canvas");
  const box = (await canvas.boundingBox())!;
  const camera = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")),
    y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  return { x: box.x + camera.x + point.x * camera.scale, y: box.y + camera.y + point.y * camera.scale };
}

/** Presses the move handle and drags it by `dx` metres along x without releasing. */
async function startMoveDrag(page: Page, dx: number) {
  const canvas = page.getByTestId("plan-canvas");
  await expect(canvas).toHaveAttribute("data-wall-move-handle", /\d/);
  // The partition slides along the outer walls it rests on.
  await expect(canvas).toHaveAttribute("data-wall-move-direction", "-1,0");
  const [x, y] = (await canvas.getAttribute("data-wall-move-handle"))!.split(",").map(Number);
  // The branch rests on the middle of the partition (y = 3); the handle stays clear of it.
  expect(Math.abs(y - 3)).toBeGreaterThan(0.1);
  expect(y).toBeGreaterThan(0);
  expect(y).toBeLessThan(6);
  const from = await screenPoint(page, { x, y });
  const to = await screenPoint(page, { x: x + dx, y });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await expect(canvas).toHaveAttribute("data-active-wall-move", "partition");
}

test("the move handle carries a partition with its T-branch and door in one undoable step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page);
  await selectPartition(page);
  await startMoveDrag(page, 1);
  // Diagnostics and inner dimensions pause during the preview, as for corner drags.
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-internal-dimensions", "[]");
  await page.mouse.up();
  const first = moved(original, 1);
  await expectSavedPlan(page, first);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-active-wall-move", "");
  await expect(page.getByTestId("room-count")).toHaveText("03");
  // The branch is 1 m shorter, so 0.2 m² of floor under it is freed.
  await expect(page.getByTestId("total-area")).toHaveText("54,84 м²");
  // The partition stays selected with its new position in the inspector.
  await expect(page.getByLabel("Начало X", { exact: true })).toHaveValue("7");
  await page.screenshot({ path: "../SpacePlan-AI-wall-move.png", fullPage: true });

  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, original);
  await expect(page.getByTestId("total-area")).toHaveText("54,64 м²");
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expectSavedPlan(page, first);

  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-floor-count", "3");
  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();

  await page.reload();
  await expectSavedPlan(page, first);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const exported = JSON.parse((await readFile((await (await downloadPromise).path())!)).toString()) as FloorPlan;
  // The format is unchanged: v5 walls and openings, no derived move data.
  expect(exported.schemaVersion).toBe(7);
  expect(rounded(exported).walls).toEqual(rounded(first).walls);
  expect(Object.keys(exported.walls[4]).sort()).toEqual(["end", "height", "id", "start", "thickness"]);
  expect(errors).toEqual([]);
});

test("precise inspector moves keep junctions and reject a move that would tear the partition off", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page);
  await selectPartition(page);
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("-0,5");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  const shifted = moved(original, -0.5);
  await expectSavedPlan(page, shifted);
  await expect(page.getByLabel("Начало X", { exact: true })).toHaveValue("5.5");
  await expect(page.getByLabel("Сдвиг по X", { exact: true })).toHaveValue("0");

  const record = await savedRecord(page);
  await page.getByLabel("Сдвиг по Y", { exact: true }).fill("0.5");
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  // Keeping the neighbours' directions only allows a shift across the wall.
  await expect(page.getByRole("alert").filter({ hasText: "только поперёк себя" })).toBeVisible();
  expect(await savedRecord(page)).toBe(record);
  await page.getByLabel("Соседние стены сохраняют направление", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  const alert = page.getByRole("region", { name: "Рабочая область редактора", exact: true }).getByRole("alert");
  await expect(alert).toContainText("опирается концом на середину другой стены");
  await expectSavedPlan(page, shifted);
  expect(await savedRecord(page)).toBe(record);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("keeping directions lengthens a trapezoid's top wall; the plain move turns its sides instead", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture: FloorPlan = {
    ...createEmptyPlan("trapezoid"),
    name: "Трапеция",
    roomMode: "walls",
    walls: [wall("top", 2, 0, 8, 0), wall("right", 8, 0, 10, 6), wall("bottom", 10, 6, 0, 6), wall("left", 0, 6, 2, 0)],
    openings: [{ id: "window", wallId: "top", kind: "window", offset: 1, width: 1.2, height: 1.2, sillHeight: 0.9 }],
  };
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "trapezoid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: "Трапеция", exact: true })).toBeVisible();
  const original = await saved(page);
  expect(original.walls).toEqual(fixture.walls);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true }).click();
  await page.getByRole("button", { name: "Показать весь план", exact: true }).click();
  // The camera moves on the next frame; a point read before that is off the wall.
  await settleFrames(page);
  const canvas = page.getByTestId("plan-canvas");
  await expect(canvas).toHaveAttribute("data-wall-move-mode", "offset");
  await expect(canvas).toHaveAttribute("data-wall-move-direction", "0,1");

  const drag = async (dy: number) => {
    const [x, y] = (await canvas.getAttribute("data-wall-move-handle"))!.split(",").map(Number);
    const from = await screenPoint(page, { x, y });
    const to = await screenPoint(page, { x, y: y + dy });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await expect(canvas).toHaveAttribute("data-active-wall-move", "top");
    await page.mouse.up();
  };
  await drag(-1);
  // The slanted sides keep their angle; the top wall grows to 16/3 m.
  const offset: FloorPlan = {
    ...original,
    walls: [
      { ...original.walls[0], start: { x: 7 / 3, y: -1 }, end: { x: 23 / 3, y: -1 } },
      { ...original.walls[1], start: { x: 23 / 3, y: -1 } },
      original.walls[2],
      { ...original.walls[3], end: { x: 7 / 3, y: -1 } },
    ],
    openings: [{ ...original.openings[0], offset: 2 / 3 }],
  };
  await expectSavedPlan(page, offset);

  await page.getByLabel("Соседние стены сохраняют направление", { exact: true }).uncheck();
  await expect(canvas).toHaveAttribute("data-wall-move-mode", "move");
  await drag(-0.5);
  // The plain move keeps the top wall's length and turns the sides about their far ends.
  const rigid = await saved(page);
  const top = rigid.walls[0];
  expect(top.start.y).toBeCloseTo(-1.5, 9);
  expect(top.end.x - top.start.x).toBeCloseTo(16 / 3, 9);
  expect(rigid.walls[3].end).toEqual(top.start);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, original);
  expect(errors).toEqual([]);
});

test("Escape and window blur cancel a move drag without saving or history", async ({ page }) => {
  await importPlan(page);
  await selectPartition(page);
  const record = await savedRecord(page);
  for (const cancel of ["Escape", "blur"] as const) {
    await test.step(`cancel with ${cancel}`, async () => {
      await selectPartition(page);
      await startMoveDrag(page, 1.5);
      if (cancel === "Escape") await page.keyboard.press("Escape");
      else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(page.getByTestId("plan-canvas")).toHaveAttribute("data-active-wall-move", "");
      await page.mouse.up();
      expect(await savedRecord(page)).toBe(record);
      await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeDisabled();
    });
  }
});
