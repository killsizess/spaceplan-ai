import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import { spatialBounds } from "../src/domain/floor-plan/spatial";
import type { FloorPlan, Opening, Wall } from "../src/domain/floor-plan/types";

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

function crossing(): FloorPlan {
  return {
    ...createEmptyPlan("wall-intersection"),
    name: "Пересечение двух стен",
    roomMode: "walls",
    walls: [wall("a", 0, 2, 6, 2), wall("b", 3, 0, 3, 4)],
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
    name: "wall-intersections.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByRole("region", { name: "Пересечения стен", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  const imported = await saved(page);
  expect(imported.walls).toEqual(fixture.walls);
  expect(imported.openings).toEqual(fixture.openings);
  return imported;
}

const join = (page: Page, first = 1, second = 2) =>
  page.getByRole("button", {
    name: `Соединить пересечение стен ${first} и ${second}`, exact: true,
  });

const locate = (page: Page, first = 1, second = 2) =>
  page.getByRole("button", {
    name: `Показать пересечение стен ${first} и ${second}`, exact: true,
  });

async function settleFrames(page: Page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

async function markers(page: Page): Promise<{
  wallIds: [string, string]; point: { x: number; y: number };
}[]> {
  return JSON.parse((await page.getByTestId("plan-canvas").getAttribute(
    "data-wall-intersections",
  )) ?? "null");
}

async function pixels(page: Page): Promise<string[]> {
  return page.getByTestId("plan-canvas").locator("canvas").evaluateAll(
    async (elements) => {
      await document.fonts.ready;
      for (let frame = 0; frame < 2; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return elements.map((element) => {
        if (!(element instanceof HTMLCanvasElement))
          throw new Error("Missing Konva canvas element");
        return element.toDataURL();
      });
    },
  );
}

function expectSplit(
  before: FloorPlan,
  after: FloorPlan,
  point: { x: number; y: number },
): Map<string, Wall> {
  expect(after.walls).toHaveLength(before.walls.length + 2);
  const additions = after.walls.filter((item) =>
    !before.walls.some((original) => original.id === item.id),
  );
  expect(additions).toHaveLength(2);
  expect(new Set(after.walls.map((item) => item.id)).size)
    .toBe(after.walls.length);
  const downstream = new Map<string, Wall>();
  for (const original of before.walls.slice(0, 2)) {
    expect(after.walls.find((item) => item.id === original.id))
      .toEqual({ ...original, end: point });
    const fragment = additions.find((item) =>
      item.end.x === original.end.x && item.end.y === original.end.y,
    );
    expect(fragment).toBeDefined();
    expect(fragment).toEqual({ ...original, id: fragment!.id, start: point });
    downstream.set(original.id, fragment!);
  }
  for (const untouched of before.walls.slice(2)) {
    expect(after.walls.find((item) => item.id === untouched.id)).toEqual(untouched);
  }
  return downstream;
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

test("locating an intersection from 3D keeps manual zoom, selects a wall and does not save", async ({
  page,
}) => {
  const original = await importPlan(page, crossing());
  await expect(page.getByTestId("intersection-count")).toHaveText("1");
  const canvas = page.getByTestId("plan-canvas");
  const camera = () => canvas.evaluate((element) => ({
    x: Number(element.getAttribute("data-camera-x")),
    y: Number(element.getAttribute("data-camera-y")),
    scale: Number(element.getAttribute("data-scale")),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await settleFrames(page);
  const fitted = await camera();
  await expect.poll(async () => markers(page)).toEqual([
    expect.objectContaining({ wallIds: ["a", "b"], point: { x: 3, y: 2 } }),
  ]);
  const visiblePixels = await pixels(page);
  const record = await savedRecord(page);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  const visibility = page.getByRole("checkbox", {
    name: "Пересечения стен", exact: true,
  });
  await expect(visibility).toBeChecked();
  await visibility.uncheck();
  await expect.poll(async () => markers(page)).toEqual([]);
  await expect(page.getByTestId("intersection-count")).toHaveText("1");
  expect(await pixels(page)).not.toEqual(visiblePixels);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  for (let step = 0; step < 3; step++) {
    const scale = (await camera()).scale;
    await page.getByRole("button", { name: "Увеличить масштаб", exact: true })
      .click();
    await expect.poll(async () => (await camera()).scale).toBeGreaterThan(scale);
  }
  const manualScale = (await camera()).scale;
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three"))
    .toHaveAttribute("data-renderer-status", "ready");
  await locate(page).click();
  await expect(canvas).toBeVisible();
  await expect.poll(async () => markers(page)).toEqual([
    expect.objectContaining({ wallIds: ["a", "b"], point: { x: 3, y: 2 } }),
  ]);
  await expect(page.getByLabel("Начало X", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Начало Y", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Конец X", { exact: true })).toHaveValue("6");
  await settleFrames(page);
  const focused = await camera();
  expect(focused.scale).toBeCloseTo(manualScale, 8);
  expect(focused.x + 3 * focused.scale).toBeCloseTo(focused.width / 2, 6);
  expect(focused.y + 2 * focused.scale).toBeCloseTo(focused.height / 2, 6);
  await settleFrames(page);
  expect(await camera()).toEqual(focused);
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await settleFrames(page);
  await expect.poll(camera).toEqual(fitted);
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true }))
    .toBeDisabled();
});

test("joining a crossing splits both walls into one movable four-end node with atomic undo and redo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = await importPlan(page, crossing());
  await expect(join(page)).toHaveText("Соединить стены");
  await join(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../SpacePlan-AI-intersections.png", fullPage: true,
    animations: "disabled",
  });
  await join(page).click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(4);
  const connected = await saved(page);
  expectSplit(original, connected, { x: 3, y: 2 });
  expect(connected.openings).toEqual(original.openings);
  await expect(page.getByTestId("intersection-count")).toHaveText("0");
  await expect(join(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await expect(page.getByLabel("Сохранять соединения", { exact: true }))
    .toBeChecked();
  await page.getByLabel("Конец Y", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Применить свойства", exact: true })
    .click();
  const moved: FloorPlan = {
    ...connected,
    walls: connected.walls.map((item) => original.walls.some((source) =>
      source.id === item.id,
    ) ? { ...item, end: { x: 3, y: 3 } }
      : { ...item, start: { x: 3, y: 3 } }),
  };
  await expect.poll(async () => saved(page)).toEqual(moved);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(connected);
  await page.getByRole("region", {
    name: "Пересечения стен", exact: true,
  }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../SpacePlan-AI-cross-connected.png", fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByTestId("intersection-count")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(connected);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(moved);
  expect(errors).toEqual([]);
});

test("exact splitting preserves room areas, selectable 3D floors and the current camera", async ({
  page,
}) => {
  const original = await importPlan(page, {
    ...crossing(),
    name: "Четыре помещения с пересечением",
    walls: [
      ...crossing().walls,
      wall("top", 0, 0, 6, 0), wall("right", 6, 0, 6, 4),
      wall("bottom", 6, 4, 0, 4), wall("left", 0, 4, 0, 0),
    ],
  });
  await expect(page.getByTestId("intersection-count")).toHaveText("1");
  await expect(page.getByTestId("total-area")).toHaveText("20,16 м²");
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-floor-count", "4");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await settleFrames(page);
  const position = (await viewer.getAttribute("data-camera-position"))!;
  await join(page).click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(8);
  const connected = await saved(page);
  expectSplit(original, connected, { x: 3, y: 2 });
  await expect(page.getByTestId("intersection-count")).toHaveText("0");
  await expect(page.getByTestId("total-area")).toHaveText("20,16 м²");
  await expect(viewer).toHaveAttribute("data-floor-count", "4");
  await expect(viewer).toHaveAttribute("data-camera-position", position);
  const box = (await viewer.boundingBox())!;
  const [x, y, z] = position.split(",").map(Number);
  const bounds = spatialBounds(original);
  const camera = new PerspectiveCamera(42, box.width / box.height, 0.01, 1000);
  camera.position.set(x, y, z);
  camera.lookAt(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  camera.updateMatrixWorld();
  const point = new Vector3(1, 0, 1).project(camera);
  await page.mouse.click(
    box.x + ((point.x + 1) * box.width) / 2,
    box.y + ((1 - point.y) * box.height) / 2,
  );
  await expect(page.getByTestId("wall-room-area")).toHaveText("5,04 м²");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByTestId("total-area")).toHaveText("20,16 м²");
  await expect(viewer).toHaveAttribute("data-floor-count", "4");
  await expect(viewer).toHaveAttribute("data-camera-position", position);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(connected);
  await expect(page.getByTestId("total-area")).toHaveText("20,16 м²");
});

test("openings on both reversed or diagonal walls preserve world positions through reload and JSON", async ({
  page,
}) => {
  const fixtures = [
    {
      name: "Обратное направление обеих стен",
      walls: [wall("a", 6, 2, 0, 2), wall("b", 3, 5, 3, -1)],
      point: { x: 3, y: 2 }, splits: [3, 3], afterOffsets: [4, 4.2],
    },
    {
      name: "Диагональная стена с пересечением",
      walls: [wall("a", 6, 8, 0, 0), wall("b", 0, 4, 6, 4)],
      point: { x: 3, y: 4 }, splits: [5, 3], afterOffsets: [7, 4.2],
    },
  ];
  for (const fixture of fixtures) {
    await test.step(fixture.name, async () => {
      const original = await importPlan(page, {
        ...crossing(), name: fixture.name,
        walls: fixture.walls.map((item, index) => index === 1
          ? { ...item, thickness: 0.3, height: 3.2 } : item),
        openings: fixture.walls.flatMap((item, index): Opening[] => [
          {
            id: `${item.id}-before`, wallId: item.id, kind: "door",
            offset: 0.5, width: 1, height: 2.1, sillHeight: 0,
          },
          {
            id: `${item.id}-after`, wallId: item.id, kind: "window",
            offset: fixture.afterOffsets[index], width: 1.1,
            height: 1.1, sillHeight: 0.9,
          },
        ]),
      });
      await expect(page.getByTestId("intersection-count")).toHaveText("1");
      await join(page).click();
      await expect.poll(async () => (await saved(page)).walls.length).toBe(4);
      const connected = await saved(page);
      const downstream = expectSplit(original, connected, fixture.point);
      expect(connected.openings).toHaveLength(original.openings.length);
      for (const opening of original.openings) {
        const after = connected.openings.find((item) => item.id === opening.id)!;
        const hostIndex = original.walls.findIndex((item) => item.id === opening.wallId);
        expect(after).toEqual(opening.id.endsWith("-before") ? opening : {
          ...opening,
          wallId: downstream.get(opening.wallId)!.id,
          offset: opening.offset - fixture.splits[hostIndex],
        });
        const beforePoints = openingEndpoints(original, opening);
        const afterPoints = openingEndpoints(connected, after);
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          expect(afterPoints[endpoint].x).toBeCloseTo(beforePoints[endpoint].x, 10);
          expect(afterPoints[endpoint].y).toBeCloseTo(beforePoints[endpoint].y, 10);
        }
      }
      await page.reload();
      await expect.poll(async () => saved(page)).toEqual(connected);
      await page.getByRole("tab", { name: "Стены", exact: true }).click();
      await expect(page.getByTestId("intersection-count")).toHaveText("0");
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
      const bytes = await readFile((await (await downloadPromise).path())!);
      expect(JSON.parse(bytes.toString())).toEqual(connected);
      await page.getByLabel("Файл проекта JSON").setInputFiles({
        name: "intersections-again.json", mimeType: "application/json", buffer: bytes,
      });
      await expect.poll(async () => (await saved(page)).id).not.toBe(connected.id);
      const imported = await saved(page);
      expect(imported.walls).toEqual(connected.walls);
      expect(imported.openings).toEqual(connected.openings);
      await page.getByRole("tab", { name: "Стены", exact: true }).click();
      await expect(page.getByTestId("intersection-count")).toHaveText("0");
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("an opening across the second wall split rejects both wall changes and does not save history", async ({
  page,
}) => {
  const original = await importPlan(page, {
    ...crossing(), name: "Защита проёма второй стены",
    openings: [
      {
        id: "first-valid", wallId: "a", kind: "door",
        offset: 0.5, width: 1, height: 2.1, sillHeight: 0,
      },
      {
        id: "second-crossing", wallId: "b", kind: "window",
        offset: 1.5, width: 1, height: 1.1, sillHeight: 0.9,
      },
    ],
  });
  const record = await savedRecord(page);
  await join(page).click();
  await expect(page.getByRole("region", {
    name: "Пересечения стен", exact: true,
  }).getByRole("alert")).toBeVisible();
  expect(await saved(page)).toEqual(original);
  expect(await savedRecord(page)).toBe(record);
  await expect(page.getByTestId("intersection-count")).toHaveText("1");
  await expect(join(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true }))
    .toBeDisabled();
  await test.step("a third interior wall prevents a partial connection of the pair", async () => {
    const concurrent = await importPlan(page, {
      ...crossing(), name: "Тройное пересечение середин",
      walls: [...crossing().walls, wall("c", 0, 0, 6, 4)],
    });
    await expect(page.getByTestId("intersection-count")).toHaveText("3");
    const concurrentRecord = await savedRecord(page);
    await join(page).click();
    await expect(page.getByRole("region", {
      name: "Пересечения стен", exact: true,
    }).getByRole("alert")).toBeVisible();
    expect(await saved(page)).toEqual(concurrent);
    expect(await savedRecord(page)).toBe(concurrentRecord);
    await expect(page.getByTestId("intersection-count")).toHaveText("3");
    await expect(page.getByRole("button", { name: "Отменить", exact: true }))
      .toBeDisabled();
    await expect(page.getByRole("button", { name: "Повторить", exact: true }))
      .toBeDisabled();
  });
  await test.step("a third wall ending at the intersection already has the shared coordinate", async () => {
    const endpointContact = await importPlan(page, {
      ...crossing(), name: "Третья стена концом в пересечении",
      walls: [...crossing().walls, wall("c", 3, 2, 5, 4)],
    });
    await expect(page.getByTestId("intersection-count")).toHaveText("1");
    await join(page).click();
    await expect.poll(async () => (await saved(page)).walls.length).toBe(5);
    expectSplit(endpointContact, await saved(page), { x: 3, y: 2 });
    await expect(page.getByTestId("intersection-count")).toHaveText("0");
  });
});

test("T contacts, shared endpoints, collinear overlaps and separated lines are not interior crossings", async ({
  page,
}) => {
  const fixtures = [
    { name: "T-примыкание", walls: [wall("a", 0, 0, 6, 0), wall("b", 3, 0, 3, 3)] },
    { name: "Общий конец", walls: [wall("a", 0, 0, 6, 0), wall("b", 6, 0, 6, 3)] },
    { name: "Коллинеарное наложение", walls: [wall("a", 0, 0, 6, 0), wall("b", 2, 0, 8, 0)] },
    { name: "Раздельные отрезки", walls: [wall("a", 0, 0, 6, 0), wall("b", 3, 1, 3, 3)] },
  ];
  for (const fixture of fixtures) {
    await test.step(fixture.name, async () => {
      const original = await importPlan(page, {
        ...crossing(), name: fixture.name, walls: fixture.walls,
      });
      const record = await savedRecord(page);
      await expect(page.getByTestId("intersection-count")).toHaveText("0");
      await expect(page.getByRole("button", { name: /^Соединить пересечение стен/ }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Показать пересечение стен/ }))
        .toHaveCount(0);
      expect(await saved(page)).toEqual(original);
      expect(await savedRecord(page)).toBe(record);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("390 px view keeps intersection actions and rejection messages reachable without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page, crossing());
  await expect(page.getByTestId("intersection-count")).toHaveText("1");
  await locate(page).scrollIntoViewIfNeeded();
  for (const action of [locate(page), join(page)]) {
    await expect(action).toBeVisible();
    await action.scrollIntoViewIfNeeded();
    const box = (await action.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../work/spaceplan-intersections-mobile.png", fullPage: true,
    animations: "disabled",
  });
  await join(page).click();
  await expect(page.getByTestId("intersection-count")).toHaveText("0");
  expectSplit(original, await saved(page), { x: 3, y: 2 });
  const rejected = await importPlan(page, {
    ...crossing(), name: "Мобильная защита проёма",
    openings: [{
      id: "crossing", wallId: "b", kind: "door",
      offset: 1.5, width: 1, height: 2.1, sillHeight: 0,
    }],
  });
  const record = await savedRecord(page);
  await join(page).click();
  const alert = page.getByRole("region", {
    name: "Пересечения стен", exact: true,
  }).getByRole("alert");
  await expect(alert).toBeVisible();
  const alertBox = (await alert.boundingBox())!;
  expect(alertBox.x).toBeGreaterThanOrEqual(0);
  expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(390);
  expect(await saved(page)).toEqual(rejected);
  expect(await savedRecord(page)).toBe(record);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});

test("a capped crossing list paginates without changing the plan, save record or history", async ({
  page,
}) => {
  const original = await importPlan(page, {
    ...crossing(), name: "Большой список пересечений", roomMode: "manual",
    rooms: [],
    walls: [
      ...Array.from({ length: 12 }, (_, index) =>
        wall(`h-${String(index + 1).padStart(2, "0")}`, 0, index + 1, 13, index + 1),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        wall(`v-${String(index + 1).padStart(2, "0")}`, index + 1, 0, index + 1, 13),
      ),
    ],
  });
  const record = await savedRecord(page);
  const region = page.getByRole("region", {
    name: "Пересечения стен", exact: true,
  });
  const actions = region.getByRole("button", { name: /^Соединить пересечение стен/ });
  await expect(page.getByTestId("intersection-count")).toHaveText("100");
  await expect(region.getByText(/^Показаны первые 100 пересечений\./))
    .toBeVisible();
  await expect.poll(async () => (await markers(page)).length).toBe(100);
  await expect(actions).toHaveCount(6);
  await region.getByRole("button", { name: "Показать ещё (94)", exact: true })
    .click();
  await expect(actions).toHaveCount(12);
  await expect(region.getByRole("button", {
    name: "Показать ещё (88)", exact: true,
  })).toBeVisible();
  expect(await saved(page)).toEqual(original);
  expect(await savedRecord(page)).toBe(record);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true }))
    .toBeDisabled();
});
