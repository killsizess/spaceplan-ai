import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import { spatialBounds } from "../src/domain/floor-plan/spatial";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";
import { fitPlan, settleCamera } from "./frames";

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

function connectedPlan(): FloorPlan {
  return {
    ...createEmptyPlan("connected"),
    name: "Связанные углы стен",
    roomMode: "walls",
    rooms: [
      {
        id: "manual",
        name: "Неактивная ручная комната",
        kind: "other",
        color: "#dfe8df",
        x: 20,
        y: 20,
        width: 3,
        height: 2,
      },
    ],
    walls: [
      wall("top", 0, 0, 5, 0),
      wall("right", 5, 0, 5, 4),
      wall("bottom", 5, 4, 0, 4),
      wall("left", 0, 4, 0, 0),
    ],
    openings: [
      {
        id: "door",
        wallId: "right",
        kind: "door",
        offset: 2.8,
        width: 0.9,
        height: 2.1,
        sillHeight: 0,
      },
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

async function importPlan(page: Page) {
  const fixture = connectedPlan();
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "wall-nodes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(
    page.getByRole("heading", { name: fixture.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  const plan = await saved(page);
  expect(plan.roomMode).toBe("walls");
  expect(plan.walls).toEqual(fixture.walls);
  return plan;
}

async function selectTop(page: Page) {
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await page
    .getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
}

async function applyProperties(page: Page) {
  await page.getByRole("button", { name: "Применить свойства", exact: true })
    .click();
}

function withCorner(plan: FloorPlan, x: number, y: number): FloorPlan {
  return {
    ...plan,
    walls: plan.walls.map((item) =>
      item.id === "top"
        ? { ...item, end: { x, y } }
        : item.id === "right"
          ? { ...item, start: { x, y } }
          : item,
    ),
    // The right wall turns about its unmoved bottom end, so its 0.9 m door
    // keeps the original 0.3 m distance from that end.
    openings: plan.openings.map((item) =>
      item.id === "door" ? { ...item, offset: Math.hypot(5 - x, 4 - y) - 1.2 } : item,
    ),
  };
}

/** Offsets are recomputed in floating point; compare them to a nanometre. */
function rounded(plan: FloorPlan): FloorPlan {
  return {
    ...plan,
    openings: plan.openings.map((item) => ({ ...item, offset: Math.round(item.offset * 1e9) / 1e9 })),
  };
}

async function expectSavedPlan(page: Page, plan: FloorPlan) {
  await expect.poll(async () => rounded(await saved(page))).toEqual(rounded(plan));
}

async function worldPoint(page: Page, x: number, y: number) {
  await settleCamera(page);
  const canvas = page.getByTestId("plan-canvas");
  const box = await canvas.boundingBox();
  const camera = await canvas.evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")),
    y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")),
  }));
  expect(box).not.toBeNull();
  return {
    x: box!.x + camera.x + x * camera.scale,
    y: box!.y + camera.y + y * camera.scale,
  };
}

async function startCornerDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const start = await worldPoint(page, from.x, from.y);
  const end = await worldPoint(page, to.x, to.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-active-wall-node",
    "top:end",
  );
}

test("precision edits keep shared corners, 3D floors, undo and JSON connected", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page);
  await selectTop(page);
  await expect(page.getByLabel("Сохранять соединения", { exact: true }))
    .toBeChecked();
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  const initialCameraPosition = await viewer.getAttribute("data-camera-position");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await expect(viewer).not.toHaveAttribute("data-camera-position", initialCameraPosition!);
  const originalBounds = spatialBounds(original);
  await expect.poll(async () =>
    Number((await viewer.getAttribute("data-camera-position"))?.split(",")[0]),
  ).toBeCloseTo((originalBounds.minX + originalBounds.maxX) / 2, 4);
  const cameraPosition = (await viewer.getAttribute("data-camera-position"))!;
  const cameraTarget = (await viewer.getAttribute("data-camera-target"))!;
  await page.getByLabel("Конец X", { exact: true }).fill("6");
  await applyProperties(page);
  const enlarged = withCorner(original, 6, 0);
  await expectSavedPlan(page, enlarged);
  await expect(page.getByTestId("total-area")).not.toHaveText("18,24 м²");
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-camera-position", cameraPosition);
  await expect(viewer).toHaveAttribute("data-camera-target", cameraTarget);

  // Pick a floor point outside the old rectangle but inside its enlarged corner.
  // This catches a stale 3D mesh even when the room and floor counts stay at one.
  const box = await viewer.boundingBox();
  const position = cameraPosition.split(",").map(Number);
  const camera = new PerspectiveCamera(42, box!.width / box!.height, 0.01, 1000);
  camera.position.set(position[0], position[1], position[2]);
  const target = cameraTarget.split(",").map(Number);
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateMatrixWorld();
  const point = new Vector3(5.4, 0, 0.5).project(camera);
  await page.mouse.click(
    box!.x + ((point.x + 1) * box!.width) / 2,
    box!.y + ((1 - point.y) * box!.height) / 2,
  );
  await expect(page.getByTestId("wall-room-area")).toBeVisible();
  await expect(page.getByTestId("wall-room-area")).toHaveText(
    (await page.getByTestId("total-area").textContent())!,
  );
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, original);
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expectSavedPlan(page, enlarged);
  await expect(viewer).toHaveAttribute("data-camera-position", cameraPosition);

  await page.reload();
  await expectSavedPlan(page, enlarged);
  const enlargedSaved = await saved(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);
  expect(JSON.parse(bytes.toString())).toEqual(enlargedSaved);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "connected-again.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect.poll(async () => (await saved(page)).id).not.toBe(enlarged.id);
  const imported = await saved(page);
  expect(imported.walls).toEqual(enlarged.walls);
  expect(imported.rooms).toEqual(original.rooms);
  expect(imported.openings).toEqual(enlargedSaved.openings);
  await selectTop(page);
  await page.getByLabel("Длина стены", { exact: true }).fill("5");
  await applyProperties(page);
  const rectangle = withCorner(imported, 5, 0);
  await expectSavedPlan(page, rectangle);
  await page.getByLabel("Начало Y", { exact: true }).fill("-1");
  await page.getByLabel("Конец Y", { exact: true }).fill("-1");
  await applyProperties(page);
  await expect(page.getByTestId("total-area")).toHaveText("23,04 м²");
  const expanded = await saved(page);
  expect(expanded.walls[0]).toEqual(wall("top", 0, -1, 5, -1));
  expect(expanded.walls[1].start).toEqual({ x: 5, y: -1 });
  expect(expanded.walls[3].end).toEqual({ x: 0, y: -1 });
  expect(expanded.rooms).toEqual(original.rooms);
  // The right wall grew upwards by 1 m; its door stays at y = 2.8..3.7.
  expect(expanded.openings).toHaveLength(1);
  expect(expanded.openings[0].offset).toBeCloseTo(3.8, 9);
  expect(expanded.walls[1].start.y + expanded.openings[0].offset).toBeCloseTo(2.8, 9);
  expect(errors).toEqual([]);
});

test("a shared 2D handle supports repeated drags and one undo per gesture", async ({
  page,
}) => {
  const original = await importPlan(page);
  await selectTop(page);
  await fitPlan(page);
  await startCornerDrag(page, { x: 5, y: 0 }, { x: 6, y: 0 });
  await page.mouse.up();
  const first = withCorner(original, 6, 0);
  await expectSavedPlan(page, first);
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(page.getByTestId("total-area")).not.toHaveText("18,24 м²");
  await startCornerDrag(page, { x: 6, y: 0 }, { x: 7, y: 0 });
  await page.mouse.up();
  const second = withCorner(original, 7, 0);
  await expectSavedPlan(page, second);
  await expect(page.getByLabel("Конец X", { exact: true })).toHaveValue("7");
  await page.screenshot({ path: "../SpacePlan-AI-wall-nodes.png", fullPage: true });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, first);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expectSavedPlan(page, first);
});

test("Escape and window blur cancel node drags without saving or history", async ({
  page,
}) => {
  const original = await importPlan(page);
  await selectTop(page);
  await fitPlan(page);
  const record = await savedRecord(page);
  for (const cancel of ["Escape", "blur"] as const) {
    await test.step(`cancel with ${cancel}`, async () => {
      await selectTop(page);
      await startCornerDrag(page, { x: 5, y: 0 }, { x: 6, y: 0 });
      expect(await savedRecord(page)).toBe(record);
      if (cancel === "Escape") await page.keyboard.press("Escape");
      else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(page.getByTestId("plan-canvas")).not.toHaveAttribute(
        "data-active-wall-node",
        /./,
      );
      await page.mouse.up();
      await expectSavedPlan(page, original);
      expect(await savedRecord(page)).toBe(record);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
      await expect(page.getByRole("button", { name: "Повторить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("invalid connected edits preserve the saved plan and independent editing is explicit", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page);
  await selectTop(page);
  await fitPlan(page);
  const record = await savedRecord(page);
  const alert = page
    .getByRole("region", { name: "Рабочая область редактора", exact: true })
    .getByRole("alert");
  // The top remains valid, but its neighbor would start inside its door at y = 2.8..3.7.
  await startCornerDrag(page, { x: 5, y: 0 }, { x: 5, y: 3 });
  await page.mouse.up();
  await expect(alert).toBeVisible();
  await expectSavedPlan(page, original);
  expect(await savedRecord(page)).toBe(record);
  await page.getByLabel("Конец Y", { exact: true }).fill("3");
  await applyProperties(page);
  await expect(alert).toBeVisible();
  await expectSavedPlan(page, original);
  expect(await savedRecord(page)).toBe(record);
  await selectTop(page);
  await expect(alert).not.toBeVisible();
  await page.getByLabel("Конец X", { exact: true }).fill("0");
  await page.getByLabel("Конец Y", { exact: true }).fill("0");
  await applyProperties(page);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expectSavedPlan(page, original);
  expect(await savedRecord(page)).toBe(record);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByLabel("Сохранять соединения", { exact: true }).uncheck();
  await page.getByLabel("Конец X", { exact: true }).fill("6");
  await applyProperties(page);
  await expectSavedPlan(page, {
    ...original,
    walls: original.walls.map((item) =>
      item.id === "top" ? { ...item, end: { x: 6, y: 0 } } : item,
    ),
  });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expectSavedPlan(page, original);
  // The preview of a door being cut is drawn past the wall start, not thrown.
  expect(errors).toEqual([]);
});
