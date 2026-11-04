import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

interface ConnectionMarker {
  id: string;
  wallId: string;
  endpoint: "start" | "end";
  kind: "open" | "near-endpoint" | "near-wall" | "junction";
  point: { x: number; y: number };
  distance?: number;
}

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

function rectangle(gap = 0): FloorPlan {
  return {
    ...createEmptyPlan("connections"),
    name: gap ? "Проверка соединений стен" : "Замкнутые соединения стен",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 5, 0),
      wall("right", 5 + gap, 0, 5 + gap, 4),
      wall("bottom", 5 + gap, 4, 0, 4),
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

async function importPlan(page: Page, plan: FloorPlan): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "wall-connections.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(plan)),
  });
  await expect(page.getByRole("heading", { name: plan.name, exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByRole("region", { name: "Соединения стен" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  return saved(page);
}

async function markers(page: Page): Promise<ConnectionMarker[]> {
  return JSON.parse(
    (await page.getByTestId("plan-canvas").getAttribute(
      "data-wall-connections",
    )) ?? "null",
  ) as ConnectionMarker[];
}

async function pixels(page: Page): Promise<string[]> {
  // Compare the actual Konva output, not just its diagnostic DOM metadata.
  return page.getByTestId("plan-canvas").locator("canvas").evaluateAll(
    async (elements) => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return elements.map((element) => {
        if (!(element instanceof HTMLCanvasElement))
          throw new Error("Missing Konva canvas element");
        return element.toDataURL();
      });
    },
  );
}

async function expectGapMarkers(page: Page) {
  await expect(page.getByTestId("connection-count")).toHaveText("2");
  await expect.poll(async () => markers(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      wallId: "top",
      endpoint: "end",
      kind: "near-endpoint",
      point: { x: 5, y: 0 },
      distance: expect.closeTo(0.1, 10),
    }),
    expect.objectContaining({
      wallId: "right",
      endpoint: "start",
      kind: "near-endpoint",
      point: { x: 5.1, y: 0 },
      distance: expect.closeTo(0.1, 10),
    }),
  ]));
  expect(await markers(page)).toHaveLength(2);
}

test("closed endpoints have no warnings; a small mismatch can be repaired and undone", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page, rectangle());
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  await expect.poll(async () => markers(page)).toEqual([]);
  const original = await importPlan(page, rectangle(0.1));
  await expectGapMarkers(page);
  // The warning concerns endpoint coordinates. Physical wall thickness can still
  // close a floor contour, so this test deliberately does not assert zero area.
  await page.getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await page.getByLabel("Конец X", { exact: true }).fill("5.1");
  await page.getByRole("button", { name: "Применить свойства", exact: true })
    .click();
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  await expect.poll(async () => markers(page)).toEqual([]);
  const repaired = {
    ...original,
    walls: original.walls.map((item) => item.id === "top"
      ? { ...item, end: { x: 5.1, y: 0 } }
      : item),
  };
  await expect.poll(async () => saved(page)).toEqual(repaired);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expectGapMarkers(page);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(repaired);
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  expect(errors).toEqual([]);
});

test("warning visibility changes canvas pixels without altering saves, history or the diagnostic count", async ({
  page,
}) => {
  const original = await importPlan(page, rectangle(0.1));
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await expectGapMarkers(page);
  const record = await savedRecord(page);
  const visiblePixels = await pixels(page);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  const visibility = page.getByLabel("Свободные концы стен", { exact: true });
  await expect(visibility).toBeChecked();
  await visibility.uncheck();
  await expect.poll(async () => markers(page)).toEqual([]);
  await expect(page.getByTestId("connection-count")).toHaveText("2");
  expect(await pixels(page)).not.toEqual(visiblePixels);
  await visibility.check();
  await expectGapMarkers(page);
  expect(await pixels(page)).toEqual(visiblePixels);
  await page.getByRole("button", { name: "Настройки вида", exact: true }).click();
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three"))
    .toHaveAttribute("data-renderer-status", "ready");
  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();
  await expectGapMarkers(page);
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true }))
    .toBeDisabled();
});

test("a diagnostic item selects its wall and centers its endpoint without fitting the entire plan", async ({
  page,
}) => {
  const original = await importPlan(page, rectangle(0.1));
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  const record = await savedRecord(page);
  const canvas = page.getByTestId("plan-canvas");
  const scale = Number(await canvas.getAttribute("data-scale"));
  await page.getByRole("button", {
    name: "Показать конец стены 1: конец",
    exact: true,
  }).click();
  await expect(page.getByLabel("Конец X", { exact: true })).toHaveValue("5");
  await expect.poll(async () => canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = Number(element.getAttribute("data-camera-x"));
    const y = Number(element.getAttribute("data-camera-y"));
    const currentScale = Number(element.getAttribute("data-scale"));
    return {
      xError: Math.abs(x + 5 * currentScale - bounds.width / 2),
      yError: Math.abs(y - bounds.height / 2),
    };
  })).toEqual({ xError: expect.closeTo(0, 4), yError: expect.closeTo(0, 4) });
  expect(Number(await canvas.getAttribute("data-scale"))).toBe(scale);
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.screenshot({ path: "../SpacePlan-AI-connections.png", fullPage: true });
});

test("locating from 3D preserves manual zoom after remount and fit can release the endpoint focus", async ({
  page,
}) => {
  const original = await importPlan(page, rectangle(0.1));
  const canvas = page.getByTestId("plan-canvas");
  const camera = () => canvas.evaluate((element) => ({
    x: Number(element.getAttribute("data-camera-x")),
    y: Number(element.getAttribute("data-camera-y")),
    scale: Number(element.getAttribute("data-scale")),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  const settleFrames = () => page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await settleFrames();
  const fitted = await camera();
  const record = await savedRecord(page);
  for (let step = 0; step < 4; step++) {
    const previousScale = (await camera()).scale;
    await page.getByRole("button", { name: "Увеличить масштаб", exact: true })
      .click();
    await expect.poll(async () => (await camera()).scale)
      .toBeGreaterThan(previousScale);
  }
  const manualScale = (await camera()).scale;
  expect(manualScale).toBeGreaterThan(fitted.scale);
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three"))
    .toHaveAttribute("data-renderer-status", "ready");
  await page.getByRole("button", {
    name: "Показать конец стены 1: конец",
    exact: true,
  }).click();
  await expect(canvas).toBeVisible();
  await settleFrames();
  const focused = await camera();
  expect(focused.scale).toBeCloseTo(manualScale, 8);
  expect(focused.x + 5 * focused.scale).toBeCloseTo(focused.width / 2, 6);
  expect(focused.y).toBeCloseTo(focused.height / 2, 6);
  await settleFrames();
  expect(await camera()).toEqual(focused);
  await page.getByRole("button", { name: "Показать весь план", exact: true })
    .click();
  await settleFrames();
  await expect.poll(camera).toEqual(fitted);
  await settleFrames();
  expect(await camera()).toEqual(fitted);
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Повторить", exact: true }))
    .toBeDisabled();
});

test("T contacts and nearby wall interiors are identified without splitting walls or creating shared nodes", async ({
  page,
}) => {
  for (const gap of [0, 0.2]) {
    await test.step(gap ? "near-wall" : "junction", async () => {
      const kind = gap ? "near-wall" : "junction";
      const fixture: FloorPlan = {
        ...createEmptyPlan("junction"),
        name: "Т-образное примыкание стен",
        roomMode: "walls",
        walls: [wall("main", 0, 0, 5, 0), wall("branch", 2.5, gap, 2.5, 2)],
      };
      const original = await importPlan(page, fixture);
      await expect.poll(async () => (await markers(page)).filter(
        (marker) => marker.kind === kind,
      )).toEqual([
        expect.objectContaining({
          wallId: "branch",
          endpoint: "start",
          point: { x: 2.5, y: gap },
          distance: expect.closeTo(gap, 10),
        }),
      ]);
      const diagnostics = await markers(page);
      expect(diagnostics.filter((marker) => marker.kind === "open"))
        .toHaveLength(3);
      expect(diagnostics).toHaveLength(4);
      await expect(page.getByTestId("connection-count")).toHaveText("4");
      expect((await saved(page)).walls).toEqual(fixture.walls);
      expect(await saved(page)).toEqual(original);
      await expect(page.getByTestId("wall-count")).toHaveText("2 стены");
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("reload and JSON import derive diagnostics from the walls without serializing them", async ({
  page,
}) => {
  const original = await importPlan(page, rectangle(0.1));
  await expectGapMarkers(page);
  const record = await savedRecord(page);
  await page.reload();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expectGapMarkers(page);
  expect(await savedRecord(page)).toBe(record);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);
  expect(JSON.parse(bytes.toString())).toEqual(original);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "connections-again.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect.poll(async () => (await saved(page)).id).not.toBe(original.id);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expectGapMarkers(page);
  expect((await saved(page)).walls).toEqual(original.walls);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
});

test("390 px view keeps connection diagnostics accessible without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page, rectangle(0.1));
  await expectGapMarkers(page);
  const record = await savedRecord(page);
  await page.getByRole("button", {
    name: "Показать конец стены 2: начало",
    exact: true,
  }).click();
  await expect(page.getByLabel("Начало X", { exact: true })).toHaveValue("5.1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../work/spaceplan-connections-mobile.png",
    fullPage: true,
  });
  expect(await savedRecord(page)).toBe(record);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
});
