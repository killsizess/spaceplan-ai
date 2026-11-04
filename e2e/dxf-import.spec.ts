import { expect, test, type Page } from "@playwright/test";
import { apartmentDxf, dxfFile, dxfLine } from "../src/domain/floor-plan/dxf.fixtures";
import type { FloorPlan } from "../src/domain/floor-plan/types";

async function savedPlan(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function newProject(page: Page) {
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название проекта").fill("Чертёж DXF");
  await page.getByRole("button", { name: "Создать пустой план" }).click();
  await savedPlan(page);
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
}

const upload = (page: Page, text: string | Buffer, name = "Квартира.dxf") =>
  page.getByLabel("Файл чертежа DXF", { exact: true }).setInputFiles({
    name, mimeType: "application/octet-stream", buffer: Buffer.isBuffer(text) ? text : Buffer.from(text),
  });

test("a DXF opens with its units and layers, needs no calibration and gives walls, doors and windows", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await newProject(page);
  const before = await savedPlan(page);
  await upload(page, apartmentDxf());

  const dialog = page.getByRole("dialog", { name: "Импорт чертежа DXF" });
  await expect(page.getByTestId("dxf-import")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("dxf-units-note")).toContainText("миллиметры");
  await expect(dialog.getByLabel("Единицы чертежа")).toHaveValue("0.001");
  await expect(page.getByTestId("dxf-layer-count")).toHaveText("5");
  // A layer that is off in the file starts off; the others on, furniture included.
  const layer = (name: string) => dialog.getByRole("checkbox", { name: new RegExp(name) });
  await expect(layer("ОФОРМЛЕНИЕ")).not.toBeChecked();
  await expect(layer("СТЕНЫ")).toBeChecked();
  await expect(layer("МЕБЕЛЬ")).toBeChecked();
  await expect(page.getByTestId("dxf-size")).toContainText("10,2 × 6,2 м");
  await expect(page.getByTestId("dxf-preview").locator("canvas")).toBeVisible();

  // Switching on the far layer changes the size at once: this is how a stray layer is spotted.
  await layer("ОФОРМЛЕНИЕ").check();
  await expect(page.getByTestId("dxf-size")).toContainText("20 ×");
  await layer("ОФОРМЛЕНИЕ").uncheck();
  await layer("МЕБЕЛЬ").uncheck();
  await expect(page.getByTestId("dxf-size")).toContainText("10,2 × 6,2 м");

  // Cancel changes nothing.
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(before);

  await upload(page, apartmentDxf());
  await expect(page.getByTestId("dxf-import")).toHaveAttribute("data-status", "ready");
  await layer("МЕБЕЛЬ").uncheck();
  await dialog.getByRole("button", { name: "Использовать чертёж" }).click();
  await expect(dialog).toHaveCount(0);

  const imported = await savedPlan(page);
  expect(imported.underlay?.calibrated).toBe(true);
  expect(imported.underlay?.name).toBe("Квартира.dxf");
  expect(imported.walls).toEqual([]);
  // No calibration step follows: the tool stays on select and the scale is set.
  const canvas = page.getByTestId("plan-canvas");
  await expect(canvas).toHaveAttribute("data-tool", "select");
  await expect(canvas).toHaveAttribute("data-underlay-loaded", "true");
  await expect(page.getByTestId("pdf-opening-suggestions").getByRole("button", { name: "Предложить двери и окна" })).toBeDisabled();

  const walls = page.getByTestId("pdf-wall-suggestions");
  await expect(walls.getByRole("button", { name: "Предложить стены" })).toBeEnabled();
  await walls.getByRole("button", { name: "Предложить стены" }).click();
  await expect(page.getByTestId("wall-suggestion-count")).toHaveText("7");
  await walls.getByRole("button", { name: "Добавить стены (7)" }).click();
  const walled = await savedPlan(page);
  expect(walled.walls).toHaveLength(7);
  for (const wall of walled.walls) expect(wall.thickness).toBeCloseTo(0.2, 2);
  // Sizes are true metres: the bottom wall axis ends 10 m from the left wall axis.
  const xs = walled.walls.flatMap((wall) => [wall.start.x, wall.end.x]);
  expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 2);

  const block = page.getByTestId("pdf-opening-suggestions");
  await block.getByRole("button", { name: "Предложить двери и окна" }).click();
  await expect(page.getByTestId("opening-suggestion-count")).toHaveText("3");
  await expect(page.getByTestId("opening-suggestion-selected")).toHaveText("2");
  await expect(page.getByTestId("opening-suggestion-doubtful")).toHaveText("1");
  await block.locator('li[data-confidence="low"]').getByRole("checkbox").check();
  await block.getByRole("button", { name: "Добавить проёмы (3)" }).click();
  const final = await savedPlan(page);
  expect(final.openings).toHaveLength(3);
  // The door came from a CAD block: hinge and side from the block's arc.
  const door = final.openings.find((item) => item.kind === "door" && item.door?.side === "left" && item.door.hinge === "start");
  expect(door?.width).toBeCloseTo(0.9, 2);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await page.getByRole("button", { name: "Комнаты по стенам" }).click();
  await expect(page.getByTestId("room-count")).toHaveText("01");
  await expect(page.getByTestId("total-area")).toHaveText("56,84 м²");
  expect(errors).toEqual([]);
});

test("a DXF without stated units asks for them before showing a size", async ({ page }) => {
  await newProject(page);
  await upload(page, dxfFile({ entities: [dxfLine("A", 0, 0, 5000, 0), dxfLine("A", 0, 0, 0, 3000)] }));
  const dialog = page.getByRole("dialog", { name: "Импорт чертежа DXF" });
  await expect(page.getByTestId("dxf-units-note")).toContainText("единицы не указаны");
  await expect(page.getByTestId("dxf-size")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Использовать чертёж" })).toBeDisabled();
  await dialog.getByLabel("Единицы чертежа").selectOption({ label: "миллиметры" });
  await expect(page.getByTestId("dxf-size")).toContainText("5 × 3 м");
  await dialog.getByLabel("Единицы чертежа").selectOption({ label: "метры" });
  // 5000 m does not fit a plan: a plain explanation, and nothing to apply.
  await expect(dialog.getByRole("alert")).toContainText("Проверьте единицы");
  await expect(dialog.getByRole("button", { name: "Использовать чертёж" })).toBeDisabled();
  await dialog.getByLabel("Единицы чертежа").selectOption({ label: "миллиметры" });
  await dialog.getByRole("button", { name: "Использовать чертёж" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await savedPlan(page)).underlay?.calibrated).toBe(true);
});

test("a DWG, a binary DXF and a stray text file are refused with an explanation and change nothing", async ({ page }) => {
  await newProject(page);
  const before = await savedPlan(page);
  const dialog = page.getByRole("dialog", { name: "Импорт чертежа DXF" });
  const cases: [Buffer, string][] = [
    [Buffer.from("AC1032\u0000binary"), "Это файл DWG"],
    [Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000"), "двоичный DXF"],
    [Buffer.from("обычный текст\nещё строка\n"), "не похож"],
  ];
  for (const [bytes, expected] of cases) {
    await upload(page, bytes);
    await expect(dialog.getByRole("alert")).toContainText(expected);
    await expect(dialog.getByRole("button", { name: "Использовать чертёж" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Отмена" }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(await savedPlan(page)).toEqual(before);
});
