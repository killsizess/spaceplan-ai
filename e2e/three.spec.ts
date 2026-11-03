import { expect, test, type Page } from "@playwright/test";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { PerspectiveCamera, Vector3 } from "three";

async function savedPlan(page: Page): Promise<FloorPlan> {
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
async function open3D(page: Page) {
  await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute(
    "data-renderer-status",
    "ready",
  );
  await expect(page.getByTestId("plan-three").locator("canvas")).toBeVisible();
}
async function createExample(page: Page) {
  await page.goto("/");
  await savedPlan(page);
  await open3D(page);
  await page.getByRole("button", { name: "Создать 3D-пример" }).click();
  await expect(
    page.getByRole("heading", { name: "Квартира · 3D-пример" }),
  ).toBeVisible();
  await expect(page.getByTestId("plan-three")).toHaveAttribute(
    "data-renderer-status",
    "ready",
  );
  await expect(page.getByTestId("plan-three")).toHaveAttribute(
    "data-opening-count",
    "12",
  );
}

test("real 3D, separate example, camera, properties, history and reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  await open3D(page);
  const viewer = page.getByTestId("plan-three");
  await expect(viewer).toHaveAttribute("data-floor-count", "6");
  await expect(viewer).toHaveAttribute("data-wall-solids", "0");
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Создать 3D-пример" }).click();
  await expect(
    page.getByRole("heading", { name: "Квартира · 3D-пример" }),
  ).toBeVisible();
  await expect(viewer).toHaveAttribute("data-opening-count", "12");
  const sample = await savedPlan(page);
  expect(sample.id).not.toEqual(original.id);
  expect(sample.walls).toHaveLength(9);
  expect(sample.openings).toHaveLength(12);
  expect(
    await page.evaluate(
      (id) =>
        JSON.parse(localStorage.getItem("spaceplan-ai:project:" + id)!).plan,
      original.id,
    ),
  ).toEqual(original);
  await expect(viewer).toHaveAttribute("data-camera-position", /,/);
  await expect(
    page.getByRole("button", { name: "Нарисовать стену", exact: true }),
  ).toHaveCount(0);
  const firstCamera = await viewer.getAttribute("data-camera-position");
  await viewer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(viewer).not.toHaveAttribute(
    "data-camera-position",
    firstCamera!,
  );
  const rotatedCamera = await viewer.getAttribute("data-camera-position");
  await page
    .getByRole("button", { name: "Выбрать стену 1", exact: true })
    .click();
  await page.getByLabel("Высота стены", { exact: true }).fill("3.2");
  await page.getByRole("button", { name: "Применить свойства" }).click();
  expect((await savedPlan(page)).walls[0].height).toBe(3.2);
  await expect(viewer).toHaveAttribute("data-model-height", "3.2");
  await expect(viewer).toHaveAttribute("data-camera-position", rotatedCamera!);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await savedPlan(page)).walls[0].height).toBe(2.7);
  await expect(viewer).toHaveAttribute("data-model-height", "2.7");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await expect(viewer).not.toHaveAttribute(
    "data-camera-position",
    rotatedCamera!,
  );
  // Click the actual projected room floor and wall cap to exercise raycasting.
  const canvasBox = await viewer.boundingBox();
  const position = (await viewer.getAttribute("data-camera-position"))!
    .split(",")
    .map(Number);
  const target = (await viewer.getAttribute("data-camera-target"))!
    .split(",")
    .map(Number);
  const camera = new PerspectiveCamera(
    42,
    canvasBox!.width / canvasBox!.height,
    0.01,
    1000,
  );
  camera.position.set(position[0], position[1], position[2]);
  // Door leaves can extend beyond the outer walls, so the fitted target is no
  // longer the old room-only bounding-box centre (5, 1.32, 4).
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateMatrixWorld();
  const clickWorld = async (x: number, y: number, z: number) => {
    const point = new Vector3(x, y, z).project(camera);
    await page.mouse.click(
      canvasBox!.x + ((point.x + 1) * canvasBox!.width) / 2,
      canvasBox!.y + ((1 - point.y) * canvasBox!.height) / 2,
    );
  };
  await clickWorld(2, 0, 2);
  await expect(page.getByTestId("room-area")).toHaveText("20 м²");
  await clickWorld(0.8, 2.7, 0);
  await expect(page.getByLabel("Высота стены", { exact: true })).toHaveValue(
    "2.7",
  );
  await page.getByRole("button", { name: "Вписать 3D-план" }).click();
  await page
    .getByRole("button", { name: "Выбрать окно 1.1", exact: true })
    .click();
  await page.getByRole("button", { name: "Удалить проём" }).click();
  await expect(viewer).toHaveAttribute("data-opening-count", "11");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-opening-count", "12");
  await savedPlan(page);
  await viewer.focus();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "../SpacePlan-AI-3D.png", fullPage: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: sample.name })).toBeVisible();
  await open3D(page);
  await expect(viewer).toHaveAttribute("data-opening-count", "12");
  await viewer.focus();
  await page.keyboard.press("w");
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-tool",
    "wall",
  );
  expect(errors).toEqual([]);
});

test("repeated 2D and 3D switches release contexts and preserve data", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/Too many active WebGL|WARNING.*WebGL/i.test(message.text()))
      errors.push(message.text());
  });
  await createExample(page);
  const before = await savedPlan(page);
  for (let index = 0; index < 8; index++) {
    await page.getByRole("button", { name: "Режим 2D" }).click();
    await expect(
      page.getByTestId("plan-canvas").locator("canvas").first(),
    ).toBeVisible();
    await expect(page.getByTestId("plan-three")).toHaveCount(0);
    await open3D(page);
    await expect(page.getByTestId("plan-three").locator("canvas")).toHaveCount(
      1,
    );
  }
  expect(await savedPlan(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("unavailable WebGL offers 2D without losing the plan", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = new Proxy(original, {
      apply(
        target,
        receiver: HTMLCanvasElement,
        args: Parameters<typeof original>,
      ) {
        if (String(args[0]).startsWith("webgl")) return null;
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await page.goto("/");
  const before = await savedPlan(page);
  await page.getByRole("button", { name: "Режим 3D" }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute(
    "data-renderer-status",
    "error",
  );
  await page.getByRole("button", { name: "Вернуться в 2D" }).click();
  await expect(
    page.getByTestId("plan-canvas").locator("canvas").first(),
  ).toBeVisible();
  expect(await savedPlan(page)).toEqual(before);
});

test("WebGL context loss recovers through 2D", async ({ page }) => {
  await createExample(page);
  const before = await savedPlan(page);
  const lost = await page
    .getByTestId("plan-three")
    .locator("canvas")
    .evaluate((node) => {
      const extension = (node as HTMLCanvasElement)
        .getContext("webgl2")
        ?.getExtension("WEBGL_lose_context");
      extension?.loseContext();
      return Boolean(extension);
    });
  expect(lost).toBe(true);
  await expect(page.getByTestId("plan-three")).toHaveAttribute(
    "data-renderer-status",
    "error",
  );
  await page.getByRole("button", { name: "Вернуться в 2D" }).click();
  await open3D(page);
  expect(await savedPlan(page)).toEqual(before);
});

test("3D resizes on tablet and phone with usable controls", async ({
  page,
}) => {
  await createExample(page);
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const viewer = page.getByTestId("plan-three");
    await viewer.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Вписать 3D-план" }).click();
    await expect(viewer.locator("canvas")).toBeVisible();
    const box = await viewer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    expect(box!.height).toBeGreaterThan(300);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Приблизить 3D-план" }).click();
  }
  await page.screenshot({
    path: "../../work/spaceplan-3d-mobile.png",
    fullPage: true,
  });
});
