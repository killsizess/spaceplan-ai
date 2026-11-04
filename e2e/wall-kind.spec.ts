import { expect, test, type Dialog, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.2,
  height: 2.7,
});

/** Walls 1–4 are the outer ring, wall 5 is the partition. No wall has a type. */
function apartment(): FloorPlan {
  return {
    ...createEmptyPlan("wall-kind"),
    name: "Типы стен",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0),
      wall("right", 10, 0, 10, 6),
      wall("bottom", 10, 6, 0, 6),
      wall("left", 0, 6, 0, 0),
      wall("partition", 6, 0, 6, 6),
    ],
  };
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function importPlan(page: Page, fixture = apartment()) {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "wall-kind.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
}

async function selectWall(page: Page, number: number) {
  await page.getByRole("button", { name: `Выбрать стену ${number}`, exact: true }).click();
  await expect(page.getByLabel("Тип стены", { exact: true })).toBeVisible();
}

/** Answers the next confirmation and returns its text once it has appeared. */
function answerNextDialog(page: Page, accept: boolean) {
  const seen: string[] = [];
  const handler = async (dialog: Dialog) => {
    seen.push(dialog.message());
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  };
  page.once("dialog", handler);
  return seen;
}

test("a wall type is set by the user, saved with the plan and undone in one step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = apartment();
  await importPlan(page, original);
  await selectWall(page, 5);
  const kind = page.getByLabel("Тип стены", { exact: true });
  await expect(kind).toHaveValue("unknown");
  await expect(page.getByTestId("wall-kind-note")).toContainText("не угадывает");

  await kind.selectOption("partition");
  await expect.poll(async () => (await saved(page)).walls[4].kind).toBe("partition");
  await expect(page.getByTestId("wall-kind-note")).toHaveText("Перегородка.");

  await kind.selectOption("bearing");
  await expect.poll(async () => (await saved(page)).walls[4].kind).toBe("bearing");
  await expect(page.getByTestId("wall-kind-note")).toContainText("потребуют подтверждения");
  await expect(page.getByRole("button", { name: "Выбрать стену 5", exact: true })).toContainText("несущая");
  const plan = await saved(page);
  // Only the chosen wall carries the field; the others stay exactly as they were.
  expect(plan.walls.filter((item) => "kind" in item).map((item) => item.id)).toEqual(["partition"]);
  expect(plan.walls.slice(0, 4)).toEqual(original.walls.slice(0, 4));

  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[4].kind).toBe("partition");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[4].kind).toBe("bearing");

  await page.reload();
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await selectWall(page, 5);
  await expect(page.getByLabel("Тип стены", { exact: true })).toHaveValue("bearing");
  expect(errors).toEqual([]);
});

test("a bearing wall is not deleted, moved or unmarked without a confirmation, and Cancel changes nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = apartment();
  fixture.walls[4] = { ...fixture.walls[4], kind: "bearing" };
  await importPlan(page, fixture);
  await selectWall(page, 5);
  const before = await saved(page);

  // Delete: declined, then accepted, then undone.
  let seen = answerNextDialog(page, false);
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toContain("несущую стену");
  expect(seen[0]).toContain("Стена 5: будет удалена");
  expect(await saved(page)).toEqual(before);

  // Move: the offset form shifts the wall by 0.5 m; the guard names it as moved.
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.5");
  seen = answerNextDialog(page, false);
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toContain("Стена 5: будет перенесена");
  expect(await saved(page)).toEqual(before);

  // Unmark: declined keeps the mark.
  seen = answerNextDialog(page, false);
  await page.getByLabel("Тип стены", { exact: true }).selectOption("partition");
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toContain("перестанет считаться несущей");
  await expect(page.getByLabel("Тип стены", { exact: true })).toHaveValue("bearing");
  expect(await saved(page)).toEqual(before);

  // Accepting the move really moves the wall, as one undo step.
  seen = answerNextDialog(page, true);
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[4].start.x).toBeCloseTo(6.5, 9);
  expect(seen).toHaveLength(1);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[4].start.x).toBe(6);

  // Accepting the delete removes it, and undo brings it back with its type.
  seen = answerNextDialog(page, true);
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(4);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(5);
  expect((await saved(page)).walls[4].kind).toBe("bearing");
  expect(errors).toEqual([]);
});

test("a wall that is not bearing is edited without any question", async ({ page }) => {
  const fixture = apartment();
  fixture.walls[4] = { ...fixture.walls[4], kind: "bearing" };
  await importPlan(page, fixture);
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  await selectWall(page, 1);
  await page.getByLabel("Тип стены", { exact: true }).selectOption("partition");
  await expect.poll(async () => (await saved(page)).walls[0].kind).toBe("partition");
  await page.getByRole("button", { name: "Удалить стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls.length).toBe(4);
  expect(dialogs).toBe(0);
});

test("the requirement «Несущие стены не меняются» needs bearing walls and reports what changed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await importPlan(page);
  const panel = page.locator(".requirements-panel");
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await panel.getByLabel("Новое требование", { exact: true }).selectOption("bearing-walls-kept");
  await panel.getByRole("button", { name: "Добавить требование", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Нет несущих стен");
  expect((await saved(page)).requirements).toEqual([]);

  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await selectWall(page, 1);
  await page.getByLabel("Тип стены", { exact: true }).selectOption("bearing");
  await selectWall(page, 5);
  await page.getByLabel("Тип стены", { exact: true }).selectOption("bearing");
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await panel.getByLabel("Новое требование", { exact: true }).selectOption("bearing-walls-kept");
  await expect(panel).toContainText("(2)");
  await panel.getByRole("button", { name: "Добавить требование", exact: true }).click();
  const item = panel.locator(".requirement").first();
  await expect(item).toContainText("Несущие стены не меняются (2)");
  await expect(item).toHaveAttribute("data-requirement-status", "met");
  await expect(panel.getByTestId("requirements-summary")).toHaveText("всё выполнено");

  // Moving a bearing wall (confirmed) breaks the requirement and names the wall.
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await selectWall(page, 5);
  await page.getByLabel("Сдвиг по X", { exact: true }).fill("0.5");
  answerNextDialog(page, true);
  await page.getByRole("button", { name: "Перенести стену", exact: true }).click();
  await expect.poll(async () => (await saved(page)).walls[4].start.x).toBeCloseTo(6.5, 9);
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(item).toHaveAttribute("data-requirement-status", "violated");
  await expect(item).toContainText("Стена 5: перенесена или изменена её длина");
  await expect(panel.getByTestId("requirements-summary")).toHaveText("нарушено: 1");

  // Unmarking the other one is reported too, once the confirmation is accepted.
  await page.getByRole("tab", { name: "Стены", exact: true }).click();
  await selectWall(page, 1);
  answerNextDialog(page, true);
  await page.getByLabel("Тип стены", { exact: true }).selectOption("unknown");
  await expect.poll(async () => (await saved(page)).walls[0].kind).toBeUndefined();
  await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
  await expect(item).toContainText("Стена 1: больше не отмечена как несущая");
  expect(errors).toEqual([]);
});
