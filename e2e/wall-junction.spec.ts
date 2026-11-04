import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import { spatialBounds } from "../src/domain/floor-plan/spatial";
import type { FloorPlan, Opening, Wall } from "../src/domain/floor-plan/types";
import { settleFrames } from "./frames";

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

function openRectangle(): FloorPlan {
  return {
    ...createEmptyPlan("wall-junction-room"),
    name: "Комната с Т-соединением",
    roomMode: "walls",
    walls: [
      wall("main", 0, 0, 6, 0),
      wall("branch", 5, 0.25, 5, 4),
      wall("bottom", 5, 4, 0, 4),
      wall("left", 0, 4, 0, 0),
    ],
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" +
      localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function savedRecord(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(() => localStorage.getItem(
    "spaceplan-ai:project:" +
      localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!);
}

async function importPlan(page: Page, fixture: FloorPlan): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "wall-junction.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  const imported = await saved(page);
  expect(imported.walls).toEqual(fixture.walls);
  expect(imported.openings).toEqual(fixture.openings);
  return imported;
}

const join = (page: Page, number: number, endpoint: "начало" | "конец") =>
  page.getByRole("button", {
    name: `Создать T-соединение стены ${number}: ${endpoint}`,
    exact: true,
  });

function newSegment(before: FloorPlan, after: FloorPlan): Wall {
  expect(after.walls).toHaveLength(before.walls.length + 1);
  const additions = after.walls.filter((item) =>
    !before.walls.some((original) => original.id === item.id),
  );
  expect(additions).toHaveLength(1);
  return additions[0];
}

async function selectFloorIn3D(page: Page, before: FloorPlan) {
  const viewer = page.getByTestId("plan-three");
  const box = (await viewer.boundingBox())!;
  const position = (await viewer.getAttribute("data-camera-position"))!
    .split(",").map(Number);
  const bounds = spatialBounds(before);
  const camera = new PerspectiveCamera(42, box.width / box.height, 0.01, 1000);
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  camera.updateMatrixWorld();
  const point = new Vector3(2, 0, 2).project(camera);
  await page.mouse.click(
    box.x + ((point.x + 1) * box.width) / 2,
    box.y + ((1 - point.y) * box.height) / 2,
  );
}

function openingEndpoints(plan: FloorPlan, opening: Opening) {
  const host = plan.walls.find((item) => item.id === opening.wallId)!;
  const dx = host.end.x - host.start.x;
  const dy = host.end.y - host.start.y;
  const length = Math.hypot(dx, dy);
  return [opening.offset, opening.offset + opening.width].map((distance) => ({
    x: host.start.x + (dx * distance) / length,
    y: host.start.y + (dy * distance) / length,
  }));
}

test("an exact T contact becomes a shared triple node with atomic undo and redo", async ({
  page,
}) => {
  const original = await importPlan(page, {
    ...createEmptyPlan("exact-junction"),
    name: "Общий узел трёх стен",
    roomMode: "walls",
    walls: [wall("main", 0, 0, 6, 0), wall("branch", 3, 0, 3, 4)],
  });
  const record = await savedRecord(page);
  await expect(page.getByTestId("connection-count")).toHaveText("4");
  await expect(join(page, 2, "начало")).toHaveText("Создать T-соединение");
  expect(await savedRecord(page)).toBe(record);
  await join(page, 2, "начало").click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(3);
  const connected = await saved(page);
  const addition = newSegment(original, connected);
  expect(connected.walls.find((item) => item.id === "main"))
    .toEqual(wall("main", 0, 0, 3, 0));
  expect(connected.walls.find((item) => item.id === "branch"))
    .toEqual(original.walls[1]);
  expect(addition).toEqual(wall(addition.id, 3, 0, 6, 0));
  await expect(page.getByTestId("connection-count")).toHaveText("3");
  const branchNumber = connected.walls.findIndex((item) => item.id === "branch") + 1;
  await expect(join(page, branchNumber, "начало")).toHaveCount(0);
  await page.getByRole("button", {
    name: `Выбрать стену ${branchNumber}`, exact: true,
  })
    .click();
  await expect(page.getByLabel("Сохранять соединения", { exact: true }))
    .toBeChecked();
  await page.getByLabel("Начало Y", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Применить свойства", exact: true })
    .click();
  const moved: FloorPlan = {
    ...connected,
    walls: connected.walls.map((item) => item.id === "main"
      ? { ...item, end: { x: 3, y: 1 } }
      : { ...item, start: { x: 3, y: 1 } }),
  };
  await expect.poll(async () => saved(page)).toEqual(moved);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(connected);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(connected);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(moved);
});

test("a nearby T end closes a real room in 2D and 3D without moving the camera", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page, openRectangle());
  await expect(page.getByTestId("connection-count")).toHaveText("2");
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await expect(join(page, 2, "начало")).toBeVisible();
  await page.screenshot({
    path: "../SpacePlan-AI-T-junction.png", fullPage: true, animations: "disabled",
  });
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-floor-count", "0");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await settleFrames(page);
  const cameraPosition = (await viewer.getAttribute("data-camera-position"))!;
  await join(page, 2, "начало").click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(5);
  const connected = await saved(page);
  const addition = newSegment(original, connected);
  expect(connected.walls.find((item) => item.id === "main"))
    .toEqual(wall("main", 0, 0, 5, 0));
  expect(connected.walls.find((item) => item.id === "branch"))
    .toEqual(wall("branch", 5, 0, 5, 4));
  expect(addition).toEqual(wall(addition.id, 5, 0, 6, 0));
  expect(connected.walls.find((item) => item.id === "bottom"))
    .toEqual(original.walls[2]);
  expect(connected.walls.find((item) => item.id === "left"))
    .toEqual(original.walls[3]);
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await expect(page.getByTestId("connection-count")).toHaveText("1");
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-camera-position", cameraPosition);
  await selectFloorIn3D(page, original);
  await expect(page.getByTestId("wall-room-area")).toHaveText("18,24 м²");
  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();
  await expect(page.getByTestId("plan-canvas"))
    .toHaveAttribute("data-wall-room-count", "1");
  await page.screenshot({
    path: "../SpacePlan-AI-T-connected.png", fullPage: true, animations: "disabled",
  });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(connected);
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  expect(errors).toEqual([]);
});

test("reversed and diagonal target openings retain their world positions through reload and JSON", async ({
  page,
}) => {
  const fixtures = [
    {
      name: "Обратное направление стены с проёмами",
      main: wall("main", 6, 0, 0, 0),
      branch: wall("branch", 3, 0.25, 3, 4),
      point: { x: 3, y: 0 },
      splitLength: 3,
      beforeOffset: 0.5,
      afterOffset: 4,
    },
    {
      name: "Диагональная стена с проёмами",
      main: wall("main", 6, 8, 0, 0),
      branch: wall("branch", 2.8, 4.15, 0.8, 5.65),
      point: { x: 3, y: 4 },
      splitLength: 5,
      beforeOffset: 1,
      afterOffset: 7,
    },
  ];
  for (const fixture of fixtures) {
    await test.step(fixture.name, async () => {
      const original = await importPlan(page, {
        ...createEmptyPlan("junction-openings"),
        name: fixture.name,
        roomMode: "walls",
        walls: [fixture.main, fixture.branch],
        openings: [
          {
            id: "before", wallId: "main", kind: "door",
            offset: fixture.beforeOffset, width: 1, height: 2.1, sillHeight: 0,
          },
          {
            id: "after", wallId: "main", kind: "window",
            offset: fixture.afterOffset, width: 1.1, height: 1.1, sillHeight: 0.9,
          },
        ],
      });
      await join(page, 2, "начало").click();
      await expect.poll(async () => (await saved(page)).walls.length).toBe(3);
      const connected = await saved(page);
      const addition = newSegment(original, connected);
      expect(connected.walls.find((item) => item.id === "main"))
        .toEqual({ ...fixture.main, end: fixture.point });
      expect(addition).toEqual({
        ...fixture.main, id: addition.id, start: fixture.point,
      });
      expect(connected.walls.find((item) => item.id === "branch")!.start.x)
        .toBeCloseTo(fixture.point.x, 10);
      expect(connected.walls.find((item) => item.id === "branch")!.start.y)
        .toBeCloseTo(fixture.point.y, 10);
      expect(connected.openings).toEqual([
        original.openings[0],
        {
          ...original.openings[1], wallId: addition.id,
          offset: fixture.afterOffset - fixture.splitLength,
        },
      ]);
      for (const opening of original.openings) {
        const before = openingEndpoints(original, opening);
        const after = openingEndpoints(connected,
          connected.openings.find((item) => item.id === opening.id)!);
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          expect(after[endpoint].x).toBeCloseTo(before[endpoint].x, 10);
          expect(after[endpoint].y).toBeCloseTo(before[endpoint].y, 10);
        }
      }
      await page.reload();
      await expect.poll(async () => saved(page)).toEqual(connected);
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
      const bytes = await readFile((await (await downloadPromise).path())!);
      expect(JSON.parse(bytes.toString())).toEqual(connected);
      await page.getByLabel("Файл проекта JSON").setInputFiles({
        name: "junction-again.json", mimeType: "application/json", buffer: bytes,
      });
      await expect.poll(async () => (await saved(page)).id).not.toBe(connected.id);
      const imported = await saved(page);
      expect(imported.walls).toEqual(connected.walls);
      expect(imported.openings).toEqual(connected.openings);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("crossing openings and invalid source walls reject the entire T operation", async ({
  page,
}) => {
  const fixtures: { name: string; branch: Wall; openings: Opening[] }[] = [
    {
      name: "Проём пересекает точку разделения",
      branch: wall("branch", 3, 0.25, 3, 3),
      openings: [{
        id: "crossing", wallId: "main", kind: "door",
        offset: 2.5, width: 1, height: 2.1, sillHeight: 0,
      }],
    },
    {
      name: "Проём не помещается в укороченной стене",
      branch: wall("branch", 3, -0.25, 3, 1),
      openings: [{
        id: "overflow", wallId: "branch", kind: "door",
        offset: 0.1, width: 1.1, height: 2.1, sillHeight: 0,
      }],
    },
    {
      name: "Схлопывание присоединяемой стены",
      branch: wall("branch", 3, 0.25, 3, 0),
      openings: [],
    },
    {
      name: "Стены лежат на одной прямой",
      branch: wall("branch", 3.2, 0, 3.5, 0),
      openings: [],
    },
  ];
  for (const fixture of fixtures) {
    await test.step(fixture.name, async () => {
      const original = await importPlan(page, {
        ...createEmptyPlan("invalid-junction"),
        name: fixture.name,
        roomMode: "walls",
        walls: [wall("main", 0, 0, 6, 0), fixture.branch],
        openings: fixture.openings,
      });
      const record = await savedRecord(page);
      const count = (await page.getByTestId("connection-count").textContent())!;
      await join(page, 2, "начало").click();
      await expect(page.getByRole("region", {
        name: "Рабочая область редактора", exact: true,
      }).getByRole("alert")).toBeVisible();
      expect(await saved(page)).toEqual(original);
      expect(await savedRecord(page)).toBe(record);
      await expect(page.getByTestId("connection-count")).toHaveText(count);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
      await expect(page.getByRole("button", { name: "Повторить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("open ends and endpoint candidates do not offer a T operation or change history", async ({
  page,
}) => {
  for (const candidate of ["open", "near-endpoint"] as const) {
    await test.step(candidate, async () => {
      const original = await importPlan(page, {
        ...createEmptyPlan("no-junction"),
        name: "Концы без Т-примыкания",
        roomMode: "walls",
        walls: [
          wall("main", 0, 0, 5, 0),
          candidate === "open"
            ? wall("branch", 2.5, 1, 2.5, 3)
            : wall("branch", 5.2, 0, 5.2, 3),
        ],
      });
      await expect(page.getByRole("button", { name: /^Создать T-соединение стены/ }))
        .toHaveCount(0);
      if (candidate === "near-endpoint") {
        await expect(page.getByRole("button", {
          name: "Соединить конец стены 2: начало", exact: true,
        })).toBeVisible();
      }
      expect(await saved(page)).toEqual(original);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("390 px view keeps the T action reachable and joins without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page, openRectangle());
  const action = join(page, 2, "начало");
  await expect(action).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  const box = (await action.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../work/spaceplan-t-junction-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await action.click();
  await expect(page.getByTestId("total-area")).toHaveText("18,24 м²");
  await expect(page.getByTestId("connection-count")).toHaveText("1");
  const connected = await saved(page);
  expect(newSegment(original, connected).start).toEqual({ x: 5, y: 0 });
  expect(connected.walls.find((item) => item.id === "branch"))
    .toEqual(wall("branch", 5, 0, 5, 4));
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});
