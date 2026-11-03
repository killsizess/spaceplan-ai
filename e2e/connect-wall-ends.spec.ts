import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import { spatialBounds } from "../src/domain/floor-plan/spatial";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";
import { formatArea } from "../src/lib/format";

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

function rectangle(gap: number): FloorPlan {
  return {
    ...createEmptyPlan("connect-wall-ends"),
    name: "Соединение близких концов",
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
    () => JSON.parse(localStorage.getItem(
      "spaceplan-ai:project:" +
        localStorage.getItem("spaceplan-ai:active-project:v1"),
    )!).plan as FloorPlan,
  );
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
    name: "connect-wall-ends.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  return saved(page);
}

const connect = (page: Page, number: number, endpoint: "начало" | "конец") =>
  page.getByRole("button", {
    name: `Соединить конец стены ${number}: ${endpoint}`,
    exact: true,
  });

async function selectFloorIn3D(page: Page, planBeforeEdit: FloorPlan) {
  const viewer = page.getByTestId("plan-three");
  const box = (await viewer.boundingBox())!;
  const position = (await viewer.getAttribute("data-camera-position"))!
    .split(",").map(Number);
  const bounds = spatialBounds(planBeforeEdit);
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

test("one command closes a real gap, creates a 3D floor and is one undo step", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A 0.25 m gap is wider than the 0.2 m walls: the original floor is open.
  const original = await importPlan(page, rectangle(0.25));
  await expect(page.getByTestId("connection-count")).toHaveText("2");
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await expect(connect(page, 1, "конец")).toHaveText("Соединить концы");
  await expect(connect(page, 2, "начало")).toBeVisible();
  await page.screenshot({ path: "../SpacePlan-AI-connect-action.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await expect(viewer).toHaveAttribute("data-floor-count", "0");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  const cameraPosition = (await viewer.getAttribute("data-camera-position"))!;
  await connect(page, 1, "конец").click();
  const repaired = {
    ...original,
    walls: original.walls.map((item) => item.id === "top"
      ? { ...item, end: { x: 5.25, y: 0 } }
      : item),
  };
  await expect.poll(async () => saved(page)).toEqual(repaired);
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  await expect(page.getByTestId("total-area")).toHaveText("19,19 м²");
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-camera-position", cameraPosition);
  // A raycast against the new mesh verifies that the previously absent floor exists.
  await selectFloorIn3D(page, original);
  await expect(page.getByTestId("wall-room-area")).toHaveText("19,19 м²");
  await page.getByRole("button", { name: "Режим 2D", exact: true }).click();
  await expect(page.getByTestId("plan-canvas"))
    .toHaveAttribute("data-wall-room-count", "1");
  await page.screenshot({ path: "../SpacePlan-AI-connected-ends.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(original);
  await expect(page.getByTestId("connection-count")).toHaveText("2");
  await expect(page.getByTestId("total-area")).toHaveText("0 м²");
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => saved(page)).toEqual(repaired);
  await expect(page.getByTestId("total-area")).toHaveText("19,19 м²");
  expect(errors).toEqual([]);
});

test("the reverse command moves only its source and survives reload and JSON", async ({
  page,
}) => {
  const original = await importPlan(page, rectangle(0.1));
  await expect(page.getByTestId("total-area")).toHaveText("18,62 м²");
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-renderer-status", "ready");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  const cameraPosition = (await viewer.getAttribute("data-camera-position"))!;
  await connect(page, 2, "начало").click();
  const repaired = {
    ...original,
    walls: original.walls.map((item) => item.id === "right"
      ? { ...item, start: { x: 5, y: 0 } }
      : item),
  };
  const expectedArea = formatArea(detectWallRooms(repaired.walls).rooms
    .reduce((total, room) => total + room.area, 0));
  expect(expectedArea).not.toBe("18,62 м²");
  await expect.poll(async () => saved(page)).toEqual(repaired);
  await expect(page.getByTestId("total-area")).toHaveText(expectedArea);
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  await expect(viewer).toHaveAttribute("data-floor-count", "1");
  await expect(viewer).toHaveAttribute("data-camera-position", cameraPosition);
  await selectFloorIn3D(page, original);
  await expect(page.getByTestId("wall-room-area")).toHaveText(expectedArea);
  await page.reload();
  await expect.poll(async () => saved(page)).toEqual(repaired);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);
  expect(JSON.parse(bytes.toString())).toEqual(repaired);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "joined-again.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect.poll(async () => (await saved(page)).id).not.toBe(repaired.id);
  expect((await saved(page)).walls).toEqual(repaired.walls);
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  await expect(page.getByTestId("total-area")).toHaveText(expectedArea);
  await expect(page.getByRole("button", { name: "Отменить", exact: true }))
    .toBeDisabled();
});

test("collapsed walls and invalidated openings reject the entire command without saving", async ({
  page,
}) => {
  const fixtures: { name: string; plan: FloorPlan; endpoint: "начало" | "конец" }[] = [
    {
      name: "collapsed wall",
      endpoint: "конец",
      plan: {
        ...createEmptyPlan("collapse"),
        name: "Защита от схлопывания стены",
        roomMode: "walls",
        walls: [wall("short", 0, 0, 0.1, 0), wall("target", 0, 0, 0, 1)],
      },
    },
    {
      name: "opening no longer fits",
      endpoint: "начало",
      plan: {
        ...createEmptyPlan("opening"),
        name: "Защита проёма при соединении",
        roomMode: "walls",
        walls: [wall("source", 0, 0, 1, 0), wall("target", 0.2, 0, 0.2, -1)],
        openings: [{
          id: "door",
          wallId: "source",
          kind: "door",
          offset: 0.1,
          width: 0.9,
          height: 2.1,
          sillHeight: 0,
        }],
      },
    },
  ];
  for (const fixture of fixtures) {
    await test.step(fixture.name, async () => {
      const original = await importPlan(page, fixture.plan);
      const record = await savedRecord(page);
      const count = await page.getByTestId("connection-count").textContent();
      await connect(page, 1, fixture.endpoint).click();
      await expect(page.getByRole("region", {
        name: "Рабочая область редактора", exact: true,
      }).getByRole("alert")).toBeVisible();
      expect(await saved(page)).toEqual(original);
      expect(await savedRecord(page)).toBe(record);
      await expect(page.getByTestId("connection-count")).toHaveText(count!);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
      await expect(page.getByRole("button", { name: "Повторить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("open ends and mid-wall contacts offer locating but no endpoint join", async ({
  page,
}) => {
  for (const gap of [0, 0.2, 1]) {
    await test.step(`branch gap ${gap}`, async () => {
      const original = await importPlan(page, {
        ...createEmptyPlan("no-endpoint-target"),
        name: "Концы без подходящей пары",
        roomMode: "walls",
        walls: [wall("main", 0, 0, 5, 0), wall("branch", 2.5, gap, 2.5, 2)],
      });
      await expect(page.getByTestId("connection-count")).toHaveText("4");
      await expect(page.getByRole("button", { name: /^Соединить конец стены/ }))
        .toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Показать конец стены 2: начало", exact: true,
      })).toBeVisible();
      expect(await saved(page)).toEqual(original);
      await expect(page.getByRole("button", { name: "Отменить", exact: true }))
        .toBeDisabled();
    });
  }
});

test("390 px view keeps both actions reachable and can join without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = await importPlan(page, rectangle(0.25));
  const join = connect(page, 1, "конец");
  await expect(join).toBeVisible();
  await join.scrollIntoViewIfNeeded();
  const box = (await join.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", {
    name: "Показать конец стены 1: конец", exact: true,
  })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../work/spaceplan-connect-ends-mobile.png", fullPage: true, animations: "disabled",
  });
  await join.click();
  await expect(page.getByTestId("connection-count")).toHaveText("0");
  await expect(page.getByTestId("total-area")).toHaveText("19,19 м²");
  expect((await saved(page)).walls).toEqual(original.walls.map((item) =>
    item.id === "top" ? { ...item, end: { x: 5.25, y: 0 } } : item,
  ));
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});
